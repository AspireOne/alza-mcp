import { z } from "zod";
import { SORTS, type Category, type CategoryDetail, type Complaint, type Failure, type Listing, type Metadata, type Offer, type Product, type ProductSection, type RatingSummary, type Reliability, type Review, type ReviewsPage, type SearchPage } from "./contracts.js";
import type { ToolName } from "./research.js";

// Output schemas mirror the contract types; `satisfies` keeps them from drifting apart.
// Section data that differs by source stays `unknown` and is described in prose.
const provider = z.enum(["browser", "flaresolverr", "byparr", "api"]);
const sort = z.enum(SORTS);
const category = z.object({ id: z.number(), name: z.string(), url: z.string() }) satisfies z.ZodType<Category>;
const failure = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(), stage: z.string().optional(), retry_after_ms: z.number().optional(), upstream_status: z.number().optional(),
  sort_orders: z.array(sort).optional().describe("Sort orders the listing supports, on UNSUPPORTED_FILTER."),
  category_id: z.number().optional(), suggested_categories: z.array(category).optional().describe("Child categories to search instead, on CATEGORY_NOT_LISTABLE."),
}).passthrough().meta({ id: "Failure" }) satisfies z.ZodType<Failure>;
const meta = z.object({
  request_id: z.string(),
  fetched_at: z.string(),
  sources: z.array(z.string()),
  provider,
  auth: z.object({
    requested: z.enum(["required", "preferred", "anonymous"]),
    state: z.enum(["signed_in", "anonymous", "unverified"]),
    session_issue: z.object({ code: z.enum(["AUTH_REQUIRED", "AUTH_ACCOUNT_MISMATCH"]), message: z.string() }).nullable(),
  }),
  challenge: z.discriminatedUnion("status", [
    z.object({ status: z.literal("not_detected") }),
    z.object({ status: z.literal("detected") }),
    z.object({ status: z.literal("solved"), duration_ms: z.number().nonnegative(), provider }),
  ]),
  cache: z.object({ hit: z.boolean(), age_ms: z.number() }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  attempts: z.array(z.object({ provider, outcome: z.enum(["success", "failed", "skipped"]), code: z.string().optional(), duration_ms: z.number() })),
}) satisfies z.ZodType<Metadata>;
const section = <T extends z.ZodType>(data: T) => z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), data }),
  z.object({ state: z.literal("not_provided") }),
  z.object({ state: z.literal("failed"), error: failure }),
]);
const offer = z.object({
  kind: z.enum(["effective", "public", "conditional", "reference"]),
  amount: z.string().describe("Decimal amount with upstream precision."),
  currency: z.string(),
  display: z.string().nullable().describe("Alza's displayed, rounded price."),
  vat: z.enum(["included", "excluded", "unknown"]),
  eligibility: z.enum(["eligible", "conditional", "unknown"]),
  conditions: z.array(z.string()),
  promotion: z.discriminatedUnion("type", [z.object({ type: z.literal("coupon"), code: z.string().nullable() }), z.object({ type: z.enum(["cashback", "other"]) })]).optional(),
}) satisfies z.ZodType<Offer>;
const listing = z.object({
  id: z.number(), code: z.string().nullable(), name: z.string(), url: z.string(), image: z.string().nullable(), description: z.string().nullable(),
  condition: z.string().nullable(), availability: z.string().nullable(), offers: z.array(offer), rating: z.number().nullable(), rating_count: z.number().nullable(), sponsored: z.boolean(),
}) satisfies z.ZodType<Listing>;
const filters = z.object({
  min_price: z.number().optional(), max_price: z.number().optional(), in_stock: z.boolean().optional(), condition: z.array(z.enum(["new", "opened", "used"])).optional(),
  manufacturers: z.array(z.number()).optional(), facets: z.array(z.object({ id: z.number(), values: z.array(z.string()).optional(), from: z.number().optional(), to: z.number().optional() })).optional(),
});
const searchPage = z.object({
  query: z.object({ query: z.string().optional(), category_id: z.number().optional(), filters: filters.optional(), sort: sort.optional() }),
  effective_url: z.string(),
  sort_orders: z.array(sort),
  products: z.array(listing),
  returned_count: z.number(),
  total: z.number().nullable(),
  page: z.number(),
  next_cursor: z.string().nullable(),
  exhausted: z.boolean().describe("false with a null next_cursor means the traversal failed."),
  snapshot: z.literal(false),
}) satisfies z.ZodType<SearchPage>;
const complaint = z.object({ rate: z.number().nullable().describe("Observed claim rate as a fraction: 0.02 means 2%. Null means unknown."), type: z.number(), description: z.string(), tooltip: z.string() }) satisfies z.ZodType<Complaint>;
const reliability = z.object({ complaint, purchaseCountFormatted: z.string().nullable(), showPurchaseCount: z.boolean() }) satisfies z.ZodType<Reliability>;
const ratingSummary = z.object({
  source: z.literal("review_stats"), ratingAverage: z.number().nullable(), ratingCount: z.number().describe("Star ratings."), reviewCount: z.number().describe("Written reviews, which can include foreign reviews."),
  reviewCountTooltip: z.string().nullable(), ratings: z.array(z.object({ value: z.number(), count: z.number() }).passthrough()),
}) satisfies z.ZodType<RatingSummary>;
const unknownSection = section(z.unknown()).optional();
const sections = {
  description: unknownSection, specifications: unknownSection, variants: unknownSection, media: unknownSection, documents: unknownSection, attributes: unknownSection,
  offers: section(z.array(offer)).optional(),
  ratings: section(ratingSummary.extend({ html_aggregate: z.unknown().describe("The page's JSON-LD rating, or null when unavailable.") })).optional(),
  reliability: section(reliability).optional(),
} satisfies Record<ProductSection, z.ZodType>;
const product = z.object({
  id: z.number(), code: z.string().nullable(), name: z.string(), url: z.string(), brand: z.string().nullable(), identifiers: z.record(z.string(), z.string()),
  condition: z.string().nullable(), availability: z.string().nullable(), sections: z.object(sections),
}) satisfies z.ZodType<Product>;
const review = z.object({
  id: z.string().nullable(), author: z.string().nullable(), body: z.string(), positives: z.array(z.string()), negatives: z.array(z.string()), rating: z.number(), date: z.string().nullable(), variant: z.string().nullable(),
  verified_purchase: z.string().nullable(), translated: z.boolean().nullable(), country_flag_url: z.string().nullable(), helpful_count: z.number().nullable(), images: z.array(z.unknown()), response: z.unknown(),
}) satisfies z.ZodType<Review>;
const reviewsPage = z.object({
  product_id: z.number(), reviews: z.array(review),
  statistics: section(ratingSummary.extend({ recommendationRate: z.unknown(), recommendationRateTooltip: z.unknown(), purchaseCountFormatted: z.unknown(), showPurchaseCount: z.unknown(), complaint: complaint.nullable() })),
  written_review_count: z.number(), returned_count: z.number(), next_cursor: z.string().nullable(), exhausted: z.boolean(), order: z.literal("website"),
}) satisfies z.ZodType<ReviewsPage>;
const facet = z.object({ id: z.number(), name: z.string(), kind: z.enum(["enum", "range"]), values: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().nullable(), numeric_value: z.number().optional().describe("Range boundary in Alza's source units; pass as from/to.") })) });
const categoryDetail = z.object({ id: z.number(), name: z.string(), url: z.string(), children: z.array(category), facets: z.array(facet), manufacturers: z.array(z.object({ id: z.number(), name: z.string() })), sort_orders: z.array(sort), listing_supported: z.boolean() }) satisfies z.ZodType<CategoryDetail>;
const sessionStatus = z.object({ backend: z.enum(["browser", "api"]), account_configured: z.boolean(), active_requests: z.number(), last_failure: failure.nullable() }).passthrough();

/** The result envelope: data on ok and partial, errors on partial, error on error. */
const result = <T extends z.ZodType>(data: T) => z.object({ status: z.enum(["ok", "partial", "error"]), data: data.optional(), errors: z.array(failure).optional(), error: failure.optional(), meta });
export const OUTPUTS = {
  search_products: result(searchPage),
  get_product: result(product),
  get_product_reviews: result(reviewsPage),
  list_categories: result(z.array(category)),
  get_category: result(categoryDetail),
  get_session_status: result(sessionStatus),
} satisfies Record<ToolName, z.ZodType>;
