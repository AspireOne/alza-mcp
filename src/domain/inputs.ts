import { z } from "zod";
import { PRODUCT_SECTIONS, SORTS } from "./contracts.js";
export const authSchema = z.enum(["preferred", "required", "anonymous"]).describe("required verifies the configured account on every call; preferred may warn and fall back to public prices; anonymous uses a separate profile.");
export const filtersSchema = z.object({
  min_price: z.number().finite().nonnegative().optional(), max_price: z.number().finite().nonnegative().optional(),
  in_stock: z.boolean().optional(), condition: z.array(z.enum(["new", "opened", "used"])).min(1).optional(),
  manufacturers: z.array(z.number().int().positive()).optional(),
  facets: z.array(z.object({ id: z.number().int().positive(), values: z.array(z.string().min(1)).min(1).optional(), from: z.number().finite().optional(), to: z.number().finite().optional() }).strict().refine(v => v.values ? v.from === undefined && v.to === undefined : v.from !== undefined || v.to !== undefined, "Use values or a numeric range")).optional(),
}).strict().refine(f => f.min_price === undefined || f.max_price === undefined || f.min_price <= f.max_price, "min_price must not exceed max_price");
export const querySchema = z.object({ query: z.string().trim().min(1).max(500).describe("Search text sent to Alza, including product names or codes.").optional(), category_id: z.number().int().positive().optional(), filters: filtersSchema.optional(), sort: z.enum(SORTS).optional() }).strict();
export const searchSchema = querySchema.extend({ cursor: z.string().max(32768).describe("Opaque next_cursor from the previous page. Supply alone; it fixes filters and authentication.").optional(), auth: authSchema.optional() }).refine(v => v.cursor ? !v.query && !v.category_id && !v.filters && !v.sort : !!v.query || !!v.category_id, "Supply a query/category, or a cursor alone; do not change a cursor's query.");
export const productSchema = z.object({ product_id: z.number().int().positive().optional(), url: z.string().url().optional(), code: z.string().trim().min(1).max(100).optional(), sections: z.array(z.enum(PRODUCT_SECTIONS)).min(1).optional(), auth: authSchema.optional() }).strict().refine(v => [v.product_id, v.url, v.code].filter(v => v !== undefined).length === 1, "Supply exactly one of product_id, url, or code.");
export const reviewsSchema = z.object({ product_id: z.number().int().positive().optional(), cursor: z.string().max(32768).optional(), limit: z.number().int().min(1).max(50).optional(), auth: authSchema.optional() }).strict().refine(v => v.cursor ? v.product_id === undefined && v.limit === undefined : v.product_id !== undefined, "Supply product_id (and optional limit), or cursor alone.");
export type ProductInput = z.infer<typeof productSchema>;
