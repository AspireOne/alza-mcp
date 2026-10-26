import { load } from "cheerio";
import { z } from "zod";
import type { Complaint, RatingSummary, Reliability, Section } from "../domain/contracts.js";
import { fail } from "../infra/failure.js";
import { WEB_API } from "../infra/urls.js";
import { object, pageData } from "./html.js";

const complaintSchema = z.object({
  rate: z.number().finite().min(0).max(1).nullable(),
  type: z.number().int().nonnegative(),
  description: z.string().min(1),
  tooltip: z.string().min(1),
});
const purchaseCountSchema = z.object({ purchaseCountFormatted: z.string().nullable(), showPurchaseCount: z.boolean() });
const ratingSummarySchema = z.object({
  ratingAverage: z.number().finite().min(0).max(5).nullable(),
  ratingCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
  reviewCountTooltip: z.string().nullable(),
  ratings: z.array(z.object({ value: z.number().finite().min(0).max(5), count: z.number().int().nonnegative() }).passthrough()),
});

export function reviewStatisticsUrl(html: string, id: number): string {
  const $ = load(html);
  if (object(pageData($).data).cid !== id) fail("PRODUCT_ID_MISMATCH", "The review-statistics page does not describe the requested product ID.");
  for (const el of $('[data-api-url]').toArray()) {
    let context: URL;
    try { context = new URL($(el).attr('data-api-url')!); } catch { continue; }
    if (!context.searchParams.has('ucik') || !context.searchParams.has('pgrik')) continue;
    const url = new URL(`${WEB_API}/api/catalog/v2/commodities/${id}/reviewStats`);
    for (const key of ['ucik', 'pgrik']) url.searchParams.set(key, context.searchParams.get(key)!);
    url.searchParams.set('country', 'CZ');
    return url.href;
  }
  return fail("SCHEMA_CHANGED", "Review-statistics context was not found on the product page.");
}

export function validateReviewStatistics(raw: unknown, id: number): Record<string, unknown> {
  const data = object(raw);
  let self: URL;
  try { self = new URL(String(object(data.self).href)); }
  catch { return fail("SCHEMA_CHANGED", "Review statistics have no valid product identity."); }
  if (self.origin !== WEB_API || self.pathname !== `/api/catalog/v2/commodities/${id}/reviewStats`) {
    fail("SCHEMA_CHANGED", "Review statistics belong to another product or endpoint.");
  }
  return data;
}

function complaint(data: Record<string, unknown>): Complaint | null {
  if (data.complaint === null) return null;
  const parsed = complaintSchema.safeParse(data.complaint);
  if (!parsed.success) fail("SCHEMA_CHANGED", "Alza's complaint statistics changed shape.");
  return parsed.data;
}

export function parseReliability(data: Record<string, unknown>): Section<Reliability> {
  const assessment = complaint(data);
  if (!assessment) return { state: "not_provided" };
  const count = purchaseCountSchema.safeParse(data);
  if (!count.success) fail("SCHEMA_CHANGED", "The complaint statistics' sales-volume context changed shape.");
  return { state: "available", data: { complaint: assessment, ...count.data } };
}

export function parseRatingSummary(data: Record<string, unknown>): RatingSummary {
  const parsed = ratingSummarySchema.safeParse(data);
  if (!parsed.success) fail('SCHEMA_CHANGED', 'Review statistics changed shape.');
  return { source: 'review_stats', ...parsed.data };
}

export function parseReviewStatistics(data: Record<string, unknown>) {
  const { recommendationRate, recommendationRateTooltip, purchaseCountFormatted, showPurchaseCount } = data;
  return { ...parseRatingSummary(data), recommendationRate, recommendationRateTooltip, purchaseCountFormatted, showPurchaseCount, complaint: complaint(data) };
}
