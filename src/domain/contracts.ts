export type AuthMode = "preferred" | "required" | "anonymous";
export type Provider = "browser" | "flaresolverr" | "byparr";
export type AccountContext = { state: "anonymous" | "signed_in"; generation: string };
export interface Notice { code: string; message: string }
export interface Attempt { provider: Provider; outcome: "success" | "failed" | "skipped"; code?: string; duration_ms: number }
export interface Metadata {
  request_id: string;
  fetched_at: string;
  sources: string[];
  provider: Provider;
  auth: { requested: AuthMode; state: "anonymous" | "signed_in" | "unverified"; session_issue: { code: "AUTH_REQUIRED" | "AUTH_ACCOUNT_MISMATCH"; message: string } | null };
  challenge: { status: "not_detected" } | { status: "detected" } | { status: "solved"; duration_ms: number; provider: Provider };
  cache: { hit: boolean; age_ms: number };
  warnings: Notice[];
  attempts: Attempt[];
}
export interface Failure {
  code: string;
  message: string;
  retryable: boolean;
  stage?: string;
  retry_after_ms?: number;
  upstream_status?: number;
}
export type Result<T> =
  | { status: "ok"; data: T; meta: Metadata }
  | { status: "partial"; data: T; errors: Failure[]; meta: Metadata }
  | { status: "error"; error: Failure; meta: Metadata };
export type Section<T> =
  | { state: "available"; data: T }
  | { state: "not_provided" }
  | { state: "failed"; error: Failure };
export const PRODUCT_SECTIONS = ["description", "specifications", "variants", "media", "documents", "offers", "attributes", "ratings"] as const;
export type ProductSection = typeof PRODUCT_SECTIONS[number];
export interface Offer {
  kind: "effective" | "public" | "conditional" | "reference";
  amount: string;
  currency: string;
  display: string | null;
  vat: "included" | "excluded" | "unknown";
  eligibility: "eligible" | "conditional" | "unknown";
  conditions: string[];
}
export interface Listing {
  id: number;
  code: string | null;
  name: string;
  url: string;
  image: string | null;
  description: string | null;
  condition: string | null;
  availability: string | null;
  offers: Offer[];
  rating: number | null;
  rating_count: number | null;
  sponsored: boolean;
}
export interface Facet { id: number; name: string; kind: "enum" | "range"; values: Array<{ id: string; label: string; count: number | null; numeric_value?: number }> }
export interface Category { id: number; name: string; url: string }
export interface SearchFilters {
  min_price?: number;
  max_price?: number;
  in_stock?: boolean;
  condition?: Array<"new" | "opened" | "used">;
  manufacturers?: number[];
  facets?: Array<{ id: number; values?: string[]; from?: number; to?: number }>;
}
export const SORTS = ["relevance", "bestselling", "price_asc", "price_desc", "rating", "newest"] as const;
export type Sort = typeof SORTS[number];
export interface SearchQuery { query?: string; category_id?: number; filters?: SearchFilters; sort?: Sort }
export interface SearchPage {
  query: SearchQuery;
  effective_url: string;
  products: Listing[];
  returned_count: number;
  total: number | null;
  page: number;
  next_cursor: string | null;
  exhausted: boolean;
  snapshot: false;
}
export interface Product {
  id: number;
  code: string | null;
  name: string;
  url: string;
  brand: string | null;
  identifiers: Record<string, string>;
  condition: string | null;
  availability: string | null;
  sections: Partial<Record<ProductSection, Section<unknown>>>;
}
export interface Review {
  id: string | null;
  author: string | null;
  body: string;
  positives: string[];
  negatives: string[];
  rating: number;
  date: string | null;
  variant: string | null;
  verified_purchase: string | null;
  translated: boolean | null;
  helpful_count: number | null;
  images: unknown[];
  response: unknown;
}
export interface ReviewsPage {
  product_id: number;
  reviews: Review[];
  statistics: Section<unknown>;
  written_review_count: number;
  returned_count: number;
  next_cursor: string | null;
  exhausted: boolean;
  order: "website";
}
