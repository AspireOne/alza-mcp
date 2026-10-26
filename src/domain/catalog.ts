import type { Category, CategoryDetail, Listing, Product, ProductSection, SearchQuery, Sort } from "./contracts.js";
import type { Operation } from "../infra/operation.js";
import type { Source } from "../infra/reader.js";

/** Research cache scoped to one source context and provider. */
export interface Cache {
  /** Returns a fresh cached value (verifying lazy sources first) or loads and stores it. */
  load<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T>;
  /** Peeks without loading, verifying or recording a cache hit. */
  has(key: string, ttlMs: number): boolean;
}
export interface ListingPage { products: Listing[]; total: number | null; next: boolean; effectiveUrl: string; sorts: Sort[] }
export interface ProductDetail {
  /** Every requested section except ratings and reliability, which come from review statistics. */
  product: Product;
  /** Rating aggregate embedded in the product source, kept beside the review-statistics summary. */
  aggregate: unknown;
  statisticsUrl: () => Promise<string>;
}
/** Backend-specific retrieval and parsing. Traversal, caching and result contracts stay in Research. */
export interface Catalog<S extends Source> {
  categories(source: S, op: Operation): Promise<Category[]>;
  category(source: S, op: Operation, id: number): Promise<CategoryDetail>;
  searchPage(source: S, op: Operation, query: SearchQuery, page: number): Promise<ListingPage>;
  product(source: S, op: Operation, id: number, sections: ProductSection[], cache: Cache): Promise<ProductDetail>;
  reviewStatisticsUrl(source: S, op: Operation, id: number): Promise<string>;
}
