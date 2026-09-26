import { z } from "zod";
import type { Review } from "../domain/contracts.js";
import { fail } from "../infra/failure.js";
import { alzaUrl, WEB_API } from "../infra/urls.js";
const link = z.object({ href: z.string().url() }).passthrough();
const review = z.object({ rating: z.number().min(0).max(5), description: z.string(), positives: z.array(z.string()), negatives: z.array(z.string()), name: z.string().nullable().optional(), reviewDate: z.string().nullable().optional(), commodityName: z.string().nullable().optional(), verifiedPurchaseTag: z.object({ label: z.string() }).nullable().optional(), isTranslated: z.boolean().nullable().optional(), likeCount: z.number().nullable().optional(), images: z.array(z.unknown()), response: z.unknown(), templatedReviewAction: link.nullable().optional() }).passthrough();
const response = z.object({ paging: z.object({ size: z.number().int().nonnegative(), limit: z.number().int().positive(), next: link.nullable() }), value: z.array(review) });
export function reviewUrl(id: number, offset: number, limit: number): string { return `${WEB_API}/api/catalog/v2/commodities/${id}/reviews?country=cz&offset=${offset}&limit=${limit}`; }
export function parseReviews(raw: unknown, id: number, offset: number): { reviews: Review[]; total: number; nextOffset: number | null } {
  const parsed = response.safeParse(raw);
  if (!parsed.success) fail("SCHEMA_CHANGED", "Alza's review response no longer matches the supported schema.");
  const { paging, value } = parsed.data;
  let nextOffset: number | null = null;
  if (paging.next) {
    const url = new URL(alzaUrl(paging.next.href));
    if (url.origin !== WEB_API || url.pathname !== `/api/catalog/v2/commodities/${id}/reviews`) fail("SCHEMA_CHANGED", "The next review page belongs to another product or endpoint.");
    nextOffset = Number(url.searchParams.get("offset"));
    if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + value.length || nextOffset <= offset) fail("PAGINATION_STALLED", "The review continuation does not advance by the number of returned reviews.");
  }
  if (!value.length && paging.size > offset) fail("INCOMPLETE_RESULTS", "Alza reports more reviews but returned an empty page.");
  return { total: paging.size, nextOffset, reviews: value.map(r => ({ id: r.templatedReviewAction?.href.match(/\/review\/(\d+)\//)?.[1] ?? null, author: r.name ?? null, body: r.description, positives: r.positives, negatives: r.negatives, rating: r.rating, date: r.reviewDate ?? null, variant: r.commodityName ?? null, verified_purchase: r.verifiedPurchaseTag?.label ?? null, translated: r.isTranslated ?? null, helpful_count: r.likeCount ?? null, images: r.images, response: r.response ?? null })) };
}
