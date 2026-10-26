import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Access, Source } from "../infra/reader.js";
import { Operation } from "../infra/operation.js";
import { Cursors } from "../infra/cursor.js";
import { TtlCache } from "../infra/cache.js";
import { fail, failureOf } from "../infra/failure.js";
import { productId } from "../infra/urls.js";
import { parseReviews, reviewUrl } from "../adapters/reviews.js";
import { parseRatingSummary, parseReliability, parseReviewStatistics, validateReviewStatistics } from "../adapters/review-statistics.js";
import { productSchema, searchSchema, reviewsSchema, authSchema } from "./inputs.js";
import type { AuthMode, Failure, Result, SearchPage, SearchQuery, ReviewsPage, Section } from "./contracts.js";
import { PRODUCT_SECTIONS } from "./contracts.js";
import type { Cache, Catalog } from "./catalog.js";
import type { Config } from "../infra/config.js";
import { memorySnapshot } from "../infra/memory.js";
import { log } from "../infra/logger.js";

const categoryInput = z.object({ category_id: z.number().int().positive(), auth: authSchema.optional() }).strict();
const categoryListInput = z.object({ auth: authSchema.optional() }).strict();
export const INPUTS = { search_products: searchSchema, get_product: productSchema, get_product_reviews: reviewsSchema, list_categories: categoryListInput, get_category: categoryInput, get_session_status: z.object({}).strict() };
export type ToolName = keyof typeof INPUTS;
export interface ResearchService { call(name: ToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> }
interface Outcome<T = unknown> { data: T; errors?: Failure[] }
interface SearchState { kind: "search"; query: SearchQuery; page: number; seen: number[]; total: number | null }
interface ReviewState { kind: "reviews"; id: number; offset: number; limit: number; seen: string[]; total: number }
type Continuation = (SearchState | ReviewState) & { context: string; auth: AuthMode };
interface Cached { value: unknown; at: number; sources: string[] }
const cursorState = z.object({ id: z.string().uuid(), auth: authSchema });
const PARTIAL_ONLY = new Set(["SCHEMA_CHANGED", "PARSE_ERROR", "SECTION_INCOMPLETE", "UPSTREAM_ERROR"]);

export class Research<S extends Source> implements ResearchService {
  private readonly continuations = new TtlCache<string, Continuation>(3_600_000, 1000);
  private readonly cache = new TtlCache<string, Cached>(86_400_000, 500);
  constructor(readonly config: Config, readonly access: Access<S>, private readonly catalog: Catalog<S>, private readonly cursors: Cursors) {}
  /** Until a source serves the operation, its metadata names the configured backend. */
  private operation(auth: AuthMode, signal?: AbortSignal, id?: string): Operation {
    const op = new Operation(auth, this.config.timeoutMs, signal, id);
    op.meta.provider = this.config.backend;
    return op;
  }
  async call(name: ToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    let op = this.operation(this.config.authMode, signal);
    const started = performance.now();
    let result: Result<unknown> | undefined;
    const finish = (value: Result<unknown>) => { result = value; return value; };
    log.info("request.started", { request_id: op.id, tool: name, memory: memorySnapshot() });
    try {
      const parsed = INPUTS[name].safeParse(input);
      if (!parsed.success) fail("INVALID_INPUT", parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
      const args = parsed.data as Record<string, unknown>;
      let continuation: Continuation | undefined;
      if (typeof args.cursor === "string") {
        const kind = name === "search_products" ? "search" : "reviews";
        const decoded = this.cursors.decode(args.cursor, kind, cursorState);
        continuation = this.continuations.get(decoded.data.id);
        if (!continuation) fail("CURSOR_EXPIRED", "The traversal expired or the server restarted. Start a new traversal.");
        if (continuation.context !== decoded.context || continuation.kind !== kind) fail("INVALID_CURSOR", "The cursor context is inconsistent.");
        if (args.auth && args.auth !== continuation.auth) fail("CONTEXT_CHANGED", "Do not change authentication mode during a traversal.");
      }
      op.dispose();
      op = this.operation(continuation?.auth ?? args.auth as AuthMode ?? this.config.authMode, signal, op.id);
      if (name === "get_session_status") return finish({ status: "ok", data: this.access.status(), meta: op.meta });
      const outcome = await this.access.run(op, async source => op.step("research.execute", { provider: source.provider }, async () => {
        switch (name) {
          case "search_products": return this.search(source, op, args, continuation?.kind === "search" ? continuation : undefined);
          case "get_product": return this.product(source, op, args);
          case "get_product_reviews": return this.reviews(source, op, args, continuation?.kind === "reviews" ? continuation : undefined);
          case "list_categories": return { data: await this.scoped(source, op).load("categories", 86_400_000, () => this.catalog.categories(source, op)) };
          case "get_category": return { data: await this.scoped(source, op).load(`category:${args.category_id}`, 86_400_000, () => this.catalog.category(source, op, args.category_id as number)) };
          default: return fail("INVALID_INPUT", "Unknown research tool.");
        }
      }), continuation?.context);
      if (outcome.errors?.length) return finish({ status: "partial", data: outcome.data, errors: outcome.errors, meta: op.meta });
      return finish({ status: "ok", data: outcome.data, meta: op.meta });
    } catch (error) { return finish({ status: "error", error: failureOf(error), meta: op.meta }); }
    finally {
      op.dispose();
      const fields = { request_id: op.id, tool: name, outcome: result?.status ?? "error", duration_ms: performance.now() - started,
        provider: op.meta.provider, auth: op.auth, auth_state: op.meta.auth.state, challenge: op.meta.challenge,
        cache: op.meta.cache, attempts: op.meta.attempts, warning_codes: op.meta.warnings.map(w => w.code),
        error_codes: result?.status === "error" ? [result.error.code] : result?.status === "partial" ? result.errors.map(e => e.code) : [], memory: memorySnapshot() };
      if (result?.status === "ok") log.info("request.completed", fields);
      else log.warn("request.completed", fields);
    }
  }
  private scoped(source: S, op: Operation): Cache {
    const scope = (key: string) => `${source.context}:${source.provider}:${key}`;
    const fresh = (cached: Cached | undefined, ttl: number): cached is Cached => !!cached && Date.now() - cached.at < ttl;
    return {
      has: (key, ttl) => fresh(this.cache.get(scope(key)), ttl),
      load: async (key, ttl, loader) => {
        const cacheKey = scope(key), cached = this.cache.get(cacheKey);
        if (fresh(cached, ttl)) {
          await source.verify?.();
          log.info("cache.hit", { request_id: op.id, provider: source.provider, age_ms: Date.now() - cached.at });
          op.meta.cache = { hit: true, age_ms: Math.max(op.meta.cache.age_ms, Date.now() - cached.at) };
          op.meta.fetched_at = new Date(Math.min(Date.parse(op.meta.fetched_at), cached.at)).toISOString(); op.meta.sources.push(...cached.sources);
          return structuredClone(cached.value) as never;
        }
        const result = await loader();
        this.cache.set(cacheKey, { value: structuredClone(result), at: Date.now(), sources: [...op.meta.sources] });
        return result;
      },
    };
  }
  private cursor(state: Continuation): string {
    const id = randomUUID(); this.continuations.set(id, state);
    return this.cursors.encode(state.kind, state.context, { id, auth: state.auth });
  }
  private async search(source: S, op: Operation, args: Record<string, unknown>, previous?: SearchState): Promise<Outcome<SearchPage>> {
    const query: SearchQuery = previous?.query ?? { query: args.query as string | undefined, category_id: args.category_id as number | undefined, filters: args.filters as SearchQuery["filters"], sort: args.sort as SearchQuery["sort"] };
    const page = previous?.page ?? 1;
    const result = await this.scoped(source, op).load(`search:${JSON.stringify(query)}:${page}`, 60_000, () => this.catalog.searchPage(source, op, query, page));
    for (const p of result.products) for (const offer of p.offers) {
      if (offer.kind === "effective" && op.meta.auth.state === "anonymous") offer.kind = "public";
    }
    const errors: Failure[] = [];
    const seen = new Set(previous?.seen ?? []);
    if (result.products.some(p => seen.has(p.id))) errors.push(problem("RESULT_SET_CHANGED", "Previously returned product IDs appeared again. Restart the traversal to avoid missing products."));
    for (const p of result.products) seen.add(p.id);
    if (previous?.total !== undefined && previous.total !== null && result.total !== null && previous.total !== result.total) errors.push(problem("RESULT_SET_CHANGED", "Alza's reported result count changed during traversal."));
    if (!result.next && result.total !== null && seen.size !== result.total || result.next && result.total !== null && seen.size >= result.total) errors.push(problem("INCOMPLETE_RESULTS", "Pagination and Alza's total count disagree."));
    if (result.total === null) op.meta.warnings.push({ code: "TOTAL_UNAVAILABLE", message: "This recovery renderer supplies pages but no trustworthy total count." });
    const next = result.next && !errors.length ? this.cursor({ kind: "search", query, page: page + 1, seen: [...seen], total: result.total, context: source.context, auth: op.auth }) : null;
    return { data: { query, effective_url: result.effectiveUrl, sort_orders: result.sorts, products: result.products, returned_count: result.products.length, total: result.total, page, next_cursor: next, exhausted: !result.next && !errors.length, snapshot: false }, errors };
  }
  private async product(source: S, op: Operation, args: Record<string, unknown>): Promise<Outcome> {
    const input = productSchema.parse(args);
    let id = input.product_id ?? (input.url ? productId(input.url) : null);
    if (input.code) {
      const found: number[] = [];
      let state: SearchState | undefined;
      do {
        const page = await this.search(source, op, { query: input.code }, state);
        if (page.errors?.length) fail("AMBIGUOUS_PRODUCT", "Code lookup could not establish a complete, unique match. Use a numeric product ID.");
        for (const p of page.data.products) if (p.code?.toLowerCase() === input.code.toLowerCase()) found.push(p.id);
        if (found.length > 1) fail("AMBIGUOUS_PRODUCT", "This code identifies multiple listings or conditions. Search it and choose a numeric product ID.");
        state = page.data.next_cursor ? this.continuations.get(this.cursors.decode(page.data.next_cursor, "search", cursorState).data.id) as SearchState : undefined;
      } while (state);
      if (!found.length) fail("PRODUCT_NOT_FOUND", "No exact product-code match was found.");
      id = found[0]!;
    }
    if (!id) fail("INVALID_INPUT", "The URL must contain a numeric Alza product ID.");
    const sections = input.sections ?? [...PRODUCT_SECTIONS];
    const { product, aggregate, statisticsUrl } = await this.catalog.product(source, op, id, sections, this.scoped(source, op));
    // Share the request, including its failure, while validating each optional
    // section independently. Malformed complaint data must not erase valid ratings.
    const statistics = sections.some(section => section === "ratings" || section === "reliability") ? this.reviewStatistics(source, op, id, statisticsUrl) : undefined;
    for (const section of ["ratings", "reliability"] as const) if (sections.includes(section)) {
      try {
        const data = await statistics!;
        product.sections[section] = section === "ratings"
          ? { state: "available", data: { ...parseRatingSummary(data), html_aggregate: aggregate } }
          : parseReliability(data);
      } catch (error) {
        const failure = failureOf(error, section);
        if (!PARTIAL_ONLY.has(failure.code)) throw error;
        log.warn(`product.${section}_failed`, { request_id: op.id, product_id: id, code: failure.code });
        product.sections[section] = { state: "failed", error: failure };
      }
    }
    const errors = Object.values(product.sections).flatMap(s => s?.state === "failed" ? [s.error] : []);
    return { data: product, errors };
  }
  private async reviewStatistics(source: S, op: Operation, id: number, url: () => Promise<string>): Promise<Record<string, unknown>> {
    return this.scoped(source, op).load(`review-stats:${id}`, 300_000, async () => validateReviewStatistics(await source.json(await url()), id));
  }
  private async reviews(source: S, op: Operation, args: Record<string, unknown>, previous?: ReviewState): Promise<Outcome<ReviewsPage>> {
    const id = previous?.id ?? args.product_id as number, offset = previous?.offset ?? 0, limit = previous?.limit ?? args.limit as number ?? 20;
    const result = await this.scoped(source, op).load(`reviews:${id}:${offset}:${limit}`, 300_000, async () => parseReviews(await source.json(reviewUrl(id, offset, limit)), id, offset));
    const errors: Failure[] = [], seen = new Set(previous?.seen ?? []);
    for (const review of result.reviews) {
      const key = review.id ?? createHash("sha256").update(JSON.stringify(review)).digest("hex");
      if (seen.has(key)) errors.push(problem("RESULT_SET_CHANGED", "Previously returned reviews appeared again. Restart the traversal."));
      seen.add(key);
    }
    if (previous && previous.total !== result.total) errors.push(problem("RESULT_SET_CHANGED", "The written-review count changed during traversal."));
    if (result.nextOffset === null && seen.size !== result.total) errors.push(problem("INCOMPLETE_RESULTS", "Review pagination ended before the reported count was reached."));
    let statistics: Section<unknown>;
    try {
      statistics = { state: "available", data: parseReviewStatistics(await this.reviewStatistics(source, op, id, () => this.catalog.reviewStatisticsUrl(source, op, id))) };
    } catch (error) {
      const failure = failureOf(error, "review_statistics");
      if (!PARTIAL_ONLY.has(failure.code)) throw error;
      statistics = { state: "failed", error: failure }; errors.push(failure);
    }
    const next = result.nextOffset !== null && !errors.some(e => e.stage !== 'review_statistics') ? this.cursor({ kind: "reviews", id, offset: result.nextOffset, limit, seen: [...seen], total: result.total, context: source.context, auth: op.auth }) : null;
    return { data: { product_id: id, reviews: result.reviews, statistics, written_review_count: result.total, returned_count: result.reviews.length, next_cursor: next, exhausted: result.nextOffset === null && !errors.some(e => e.stage !== 'review_statistics'), order: "website" }, errors };
  }
}
function problem(code: string, message: string): Failure { return { code, message, retryable: false }; }
