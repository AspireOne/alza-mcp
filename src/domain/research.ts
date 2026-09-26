import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio";
import { z } from "zod";
import type { Access, Reader } from "../infra/reader.js";
import { Operation } from "../infra/operation.js";
import { Cursors } from "../infra/cursor.js";
import { TtlCache } from "../infra/cache.js";
import { fail, failureOf } from "../infra/failure.js";
import { BASE_URL, FILTER_PATH, WEB_API, productId, productUrl } from "../infra/urls.js";
import { categories, facets, manufacturers, sortOrders, filterRequest, parseFilter, parseRenderedSearch, searchUrl } from "../adapters/catalog.js";
import { parseProduct } from "../adapters/product.js";
import { parseReviews, reviewUrl } from "../adapters/reviews.js";
import { object, pageData } from "../adapters/html.js";
import { productSchema, searchSchema, reviewsSchema, authSchema } from "./inputs.js";
import type { AuthMode, Failure, Result, SearchPage, SearchQuery, ReviewsPage, Section } from "./contracts.js";
import type { Config } from "../infra/config.js";

const categoryInput = z.object({ category_id: z.number().int().positive(), auth: authSchema.optional() }).strict();
const categoryListInput = z.object({ auth: authSchema.optional() }).strict();
export const INPUTS = { search_products: searchSchema, get_product: productSchema, get_product_reviews: reviewsSchema, list_categories: categoryListInput, get_category: categoryInput, get_session_status: z.object({}).strict() };
export type ToolName = keyof typeof INPUTS;
interface Outcome<T = unknown> { data: T; errors?: Failure[] }
interface SearchState { kind: "search"; query: SearchQuery; page: number; seen: number[]; total: number | null }
interface ReviewState { kind: "reviews"; id: number; offset: number; limit: number; seen: string[]; total: number }
type Continuation = (SearchState | ReviewState) & { context: string; auth: AuthMode };
interface Cached { value: unknown; at: number; sources: string[] }
const cursorState = z.object({ id: z.string().uuid(), auth: authSchema });
const PARTIAL_ONLY = new Set(["SCHEMA_CHANGED", "PARSE_ERROR", "SECTION_INCOMPLETE", "UPSTREAM_ERROR"]);

export class Research {
  private readonly continuations = new TtlCache<string, Continuation>(3_600_000, 1000);
  private readonly cache = new TtlCache<string, Cached>(86_400_000, 500);
  constructor(readonly config: Config, readonly access: Access, private readonly cursors: Cursors) {}
  async call(name: ToolName, input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    let op = new Operation(this.config.authMode, this.config.timeoutMs, signal);
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
      op = new Operation(continuation?.auth ?? args.auth as AuthMode ?? this.config.authMode, this.config.timeoutMs, signal);
      if (name === "get_session_status") return { status: "ok", data: this.access.status(), meta: op.meta };
      const outcome = await this.access.run(op, async reader => {
        switch (name) {
          case "search_products": return this.search(reader, op, args, continuation?.kind === "search" ? continuation : undefined);
          case "get_product": return this.product(reader, op, args);
          case "get_product_reviews": return this.reviews(reader, op, args, continuation?.kind === "reviews" ? continuation : undefined);
          case "list_categories": return { data: await this.cached(reader, op, "categories", 86_400_000, async () => categories((await reader.page(BASE_URL)).html)) };
          case "get_category": return { data: await this.cached(reader, op, `category:${args.category_id}`, 86_400_000, async () => {
            const doc = await reader.page(searchUrl({ category_id: args.category_id as number }));
            const $ = load(doc.html);
            if (pageData(doc.html).categoryId !== args.category_id) fail("CATEGORY_ID_MISMATCH", "The page does not describe the requested category.");
            const sorts = sortOrders(doc.html);
            return { id: args.category_id, name: $("h1").first().text().trim(), url: doc.url, children: categories(doc.html, true), facets: facets(doc.html), manufacturers: manufacturers(doc.html), sort_orders: sorts, listing_supported: sorts.length > 0 };
          }) };
          default: return fail("INVALID_INPUT", "Unknown research tool.");
        }
      }, continuation?.context);
      if (outcome.errors?.length) return { status: "partial", data: outcome.data, errors: outcome.errors, meta: op.meta };
      return { status: "ok", data: outcome.data, meta: op.meta };
    } catch (error) { return { status: "error", error: failureOf(error), meta: op.meta }; }
    finally { op.dispose(); }
  }
  private async cached<T>(reader: Reader, op: Operation, key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const cacheKey = `${reader.context}:${reader.provider}:${key}`, cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttl) {
      op.meta.cache = { hit: true, age_ms: Math.max(op.meta.cache.age_ms, Date.now() - cached.at) };
      op.meta.fetched_at = new Date(Math.min(Date.parse(op.meta.fetched_at), cached.at)).toISOString(); op.meta.sources.push(...cached.sources);
      return structuredClone(cached.value) as T;
    }
    const result = await loader();
    this.cache.set(cacheKey, { value: structuredClone(result), at: Date.now(), sources: [...op.meta.sources] });
    return result;
  }
  private cursor(state: Continuation): string {
    const id = randomUUID(); this.continuations.set(id, state);
    return this.cursors.encode(state.kind, state.context, { id, auth: state.auth });
  }
  private async search(reader: Reader, op: Operation, args: Record<string, unknown>, previous?: SearchState): Promise<Outcome<SearchPage>> {
    const query: SearchQuery = previous?.query ?? { query: args.query as string | undefined, category_id: args.category_id as number | undefined, filters: args.filters as SearchQuery["filters"], sort: args.sort as SearchQuery["sort"] };
    const page = previous?.page ?? 1;
    const result = await this.cached(reader, op, `search:${JSON.stringify(query)}:${page}`, 60_000, async () => {
      const doc = await reader.page(searchUrl(query));
      const bootstrap = pageData(doc.html), data = object(bootstrap.data);
      if (data.isSearch === true && data.isEmpty === true && page === 1) {
        if (query.filters?.facets?.length || query.filters?.manufacturers?.length) fail("UNSUPPORTED_FILTER", "This empty search does not advertise the requested facet or manufacturer filters.");
        return { products: [], total: 0, next: false, effectiveUrl: doc.url };
      }
      const body = filterRequest(doc.html, query, page), effectiveUrl = `${doc.url.split("#")[0]}${body.hash}`;
      const signedIn = op.meta.auth.state === 'signed_in';
      const parsed = reader.canPost ? parseFilter(await reader.json(`${BASE_URL}${FILTER_PATH}`, body), page, signedIn) : parseRenderedSearch((await reader.page(effectiveUrl)).html, page, query, signedIn);
      return { ...parsed, effectiveUrl };
    });
    for (const p of result.products) for (const offer of p.offers) {
      if (offer.kind === "effective" && op.meta.auth.state === "anonymous") offer.kind = "public";
      // Company accounts can change listing VAT presentation; the card alone
      // does not prove the basis. Product detail carries explicit VAT offers.
      if (op.meta.auth.state === "signed_in") offer.vat = "unknown";
    }
    const errors: Failure[] = [];
    const seen = new Set(previous?.seen ?? []);
    if (result.products.some(p => seen.has(p.id))) errors.push(problem("RESULT_SET_CHANGED", "Previously returned product IDs appeared again. Restart the traversal to avoid missing products."));
    for (const p of result.products) seen.add(p.id);
    if (previous?.total !== undefined && previous.total !== null && result.total !== null && previous.total !== result.total) errors.push(problem("RESULT_SET_CHANGED", "Alza's reported result count changed during traversal."));
    if (!result.next && result.total !== null && seen.size !== result.total || result.next && result.total !== null && seen.size >= result.total) errors.push(problem("INCOMPLETE_RESULTS", "Pagination and Alza's total count disagree."));
    if (result.total === null) op.meta.warnings.push({ code: "TOTAL_UNAVAILABLE", message: "This recovery renderer supplies pages but no trustworthy total count." });
    const next = result.next && !errors.length ? this.cursor({ kind: "search", query, page: page + 1, seen: [...seen], total: result.total, context: reader.context, auth: op.auth }) : null;
    return { data: { query, effective_url: result.effectiveUrl, products: result.products, returned_count: result.products.length, total: result.total, page, next_cursor: next, exhausted: !result.next && !errors.length, snapshot: false }, errors };
  }
  private async product(reader: Reader, op: Operation, args: Record<string, unknown>): Promise<Outcome> {
    const input = productSchema.parse(args);
    let id = input.product_id ?? (input.url ? productId(input.url) : null);
    if (input.code) {
      const found: number[] = [];
      let state: SearchState | undefined;
      do {
        const page = await this.search(reader, op, { query: input.code }, state);
        if (page.errors?.length) fail("AMBIGUOUS_PRODUCT", "Code lookup could not establish a complete, unique match. Use a numeric product ID.");
        for (const p of page.data.products) if (p.code?.toLowerCase() === input.code.toLowerCase()) found.push(p.id);
        if (found.length > 1) fail("AMBIGUOUS_PRODUCT", "This code identifies multiple listings or conditions. Search it and choose a numeric product ID.");
        state = page.data.next_cursor ? this.continuations.get(this.cursors.decode(page.data.next_cursor, "search", cursorState).data.id) as SearchState : undefined;
      } while (state);
      if (!found.length) fail("PRODUCT_NOT_FOUND", "No exact product-code match was found.");
      id = found[0]!;
    }
    if (!id) fail("INVALID_INPUT", "The URL must contain a numeric Alza product ID.");
    const doc = await this.cached(reader, op, `product:${id}`, 60_000, () => reader.page(productUrl(id!), { detail: true }));
    const product = parseProduct(doc.html, doc.url, id, op.meta.auth.state === "signed_in", input.sections);
    const errors = Object.values(product.sections).flatMap(s => s?.state === "failed" ? [s.error] : []);
    return { data: product, errors };
  }
  private async reviews(reader: Reader, op: Operation, args: Record<string, unknown>, previous?: ReviewState): Promise<Outcome<ReviewsPage>> {
    const id = previous?.id ?? args.product_id as number, offset = previous?.offset ?? 0, limit = previous?.limit ?? args.limit as number ?? 20;
    const result = await this.cached(reader, op, `reviews:${id}:${offset}:${limit}`, 300_000, async () => parseReviews(await reader.json(reviewUrl(id, offset, limit)), id, offset));
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
      statistics = { state: "available", data: await this.cached(reader, op, `review-stats:${id}`, 300_000, async () => {
        const doc = await reader.page(productUrl(id));
        const $ = load(doc.html); let context: URL | undefined;
        for (const el of $('[data-api-url]').toArray()) { try { const url = new URL($(el).attr('data-api-url')!); if (url.searchParams.has('ucik') && url.searchParams.has('pgrik')) { context = url; break; } } catch {} }
        if (!context) fail("SCHEMA_CHANGED", "Review-statistics context was not found on the product page.");
        const url = new URL(`${WEB_API}/api/catalog/v2/commodities/${id}/reviewStats`);
        for (const key of ['ucik', 'pgrik']) url.searchParams.set(key, context.searchParams.get(key)!);
        url.searchParams.set('country', 'CZ');
        const data = object(await reader.json(url.href));
        if (typeof data.ratingCount !== 'number' || !Array.isArray(data.ratings) || typeof data.reviewCount !== 'number') fail('SCHEMA_CHANGED', 'Review statistics changed shape.');
        const { ratingAverage, ratingCount, reviewCount, reviewCountTooltip, recommendationRate, recommendationRateTooltip, ratings, purchaseCountFormatted } = data;
        return { ratingAverage, ratingCount, reviewCount, reviewCountTooltip, recommendationRate, recommendationRateTooltip, ratings, purchaseCountFormatted };
      }) };
    } catch (error) {
      const failure = failureOf(error, "review_statistics");
      if (!PARTIAL_ONLY.has(failure.code)) throw error;
      statistics = { state: "failed", error: failure }; errors.push(failure);
    }
    const next = result.nextOffset !== null && !errors.some(e => e.stage !== 'review_statistics') ? this.cursor({ kind: "reviews", id, offset: result.nextOffset, limit, seen: [...seen], total: result.total, context: reader.context, auth: op.auth }) : null;
    return { data: { product_id: id, reviews: result.reviews, statistics, written_review_count: result.total, returned_count: result.reviews.length, next_cursor: next, exhausted: result.nextOffset === null && !errors.some(e => e.stage !== 'review_statistics'), order: "website" }, errors };
  }
}
function problem(code: string, message: string): Failure { return { code, message, retryable: false }; }
