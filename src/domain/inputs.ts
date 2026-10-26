import { z } from "zod";
import { PRODUCT_SECTIONS, SORTS } from "./contracts.js";
const MAX_FILTER_ITEMS = 100;
const MAX_INPUT_STRING_LENGTH = 8192;
const AUTH_GUIDANCE = 'Account context. Use "preferred" for normal requests: it keeps account and company benefits and can fall back to public prices with a warning. Use "required" when verified account access must succeed. Use "anonymous" only when the user asks for public prices or for diagnosis. Omitted means the server default, normally "preferred".';
export const authSchema = z.enum(["preferred", "required", "anonymous"]).describe(AUTH_GUIDANCE);
const productIdSchema = z.number().int().positive();
export const filtersSchema = z.object({
  min_price: z.number().finite().nonnegative().describe("Lowest price in CZK, by Alza's own listing price; coupon totals are not considered.").optional(),
  max_price: z.number().finite().nonnegative().describe("Highest price in CZK, by Alza's own listing price; coupon totals are not considered.").optional(),
  in_stock: z.boolean().describe("true returns only products Alza reports in stock.").optional(),
  condition: z.array(z.enum(["new", "opened", "used"])).max(3).min(1).describe("Listing conditions to include. opened is Alza's \"Rozbaleno\"; used includes \"Zánovní\". Omitted means all conditions.").optional(),
  manufacturers: z.array(z.number().int().positive()).max(MAX_FILTER_ITEMS).describe("Manufacturer IDs advertised by get_category.").optional(),
  facets: z.array(z.object({
    id: z.number().int().positive().describe("Facet ID from get_category."),
    values: z.array(z.string().min(1).max(MAX_INPUT_STRING_LENGTH)).max(MAX_FILTER_ITEMS).min(1).describe("Enum facet: advertised value IDs to match.").optional(),
    from: z.number().finite().describe("Range facet: lower bound, an advertised numeric_value. Omit for an open range.").optional(),
    to: z.number().finite().describe("Range facet: upper bound, an advertised numeric_value. Omit for an open range.").optional(),
  }).strict().refine(v => v.values ? v.from === undefined && v.to === undefined : v.from !== undefined || v.to !== undefined, "Use values or a numeric range")).max(MAX_FILTER_ITEMS).describe("Category parameter filters from get_category. Each facet takes values (enum) or from/to (range). Use with category_id.").optional(),
}).strict().refine(f => f.min_price === undefined || f.max_price === undefined || f.min_price <= f.max_price, "min_price must not exceed max_price").describe("Filters applied by Alza. A filter Alza cannot apply fails with UNSUPPORTED_FILTER; it is never ignored.");
export const querySchema = z.object({
  query: z.string().trim().min(1).max(500).describe("Search text sent to Alza, including product names or codes.").optional(),
  category_id: z.number().int().positive().describe("Category to list, from list_categories or get_category. Combined with query, restricts the text search to the category, or fails with UNSUPPORTED_FILTER where Alza cannot.").optional(),
  filters: filtersSchema.optional(),
  sort: z.enum(SORTS).describe("Result order. Omitted means relevance. Listings support different orders; an unsupported one fails with the listing's sort_orders.").optional(),
}).strict();
export const searchSchema = querySchema.extend({ cursor: z.string().max(32768).describe("Opaque next_cursor from the previous page. Supply alone; it fixes filters and authentication.").optional(), auth: authSchema.optional() }).refine(v => v.cursor ? !v.query && !v.category_id && !v.filters && !v.sort : !!v.query || !!v.category_id, "Supply a query/category, or a cursor alone; do not change a cursor's query.");
export const productSchema = z.object({
  product_id: productIdSchema.describe("Numeric Alza product ID. New, opened and used listings of one product have different IDs.").optional(),
  url: z.string().max(MAX_INPUT_STRING_LENGTH).url().describe("Alza product page URL.").optional(),
  code: z.string().trim().min(1).max(100).describe("Alza product code. Fails unless it matches exactly one listing.").optional(),
  sections: z.array(z.enum(PRODUCT_SECTIONS)).max(PRODUCT_SECTIONS.length).min(1).describe("Sections to return. Omitted means all.").optional(),
  auth: authSchema.optional(),
}).strict().refine(v => [v.product_id, v.url, v.code].filter(v => v !== undefined).length === 1, "Supply exactly one of product_id, url, or code.");
export const reviewsSchema = z.object({ product_id: productIdSchema.describe("Numeric Alza product ID for the first page.").optional(), cursor: z.string().max(32768).describe("Opaque next_cursor from the previous page. Supply alone, without product_id or limit; it retains page size and authentication.").optional(), limit: z.number().int().min(1).max(50).describe("Page size for the initial product_id request. Omit when following a cursor.").optional(), auth: authSchema.optional() }).strict().refine(v => v.cursor ? v.product_id === undefined && v.limit === undefined : v.product_id !== undefined, "Supply product_id (and optional limit), or cursor alone.");
export const categoryInput = z.object({ category_id: z.number().int().positive().describe("Category ID from list_categories, get_category children or a CATEGORY_NOT_LISTABLE suggestion."), auth: authSchema.optional() }).strict();
export const categoryListInput = z.object({ auth: authSchema.optional() }).strict();
export type ProductInput = z.infer<typeof productSchema>;
