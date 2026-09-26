import { fail } from "./failure.js";
export const BASE_URL = "https://www.alza.cz";
export const WEB_API = "https://webapi.alza.cz";
export const FILTER_PATH = "/Services/EShopService.svc/Filter";
export function alzaUrl(value: string, base = BASE_URL): string {
  let u: URL;
  try { u = new URL(value, base); } catch { return fail("INVALID_INPUT", "Invalid Alza URL."); }
  if (u.protocol !== "https:" || !["www.alza.cz", "webapi.alza.cz"].includes(u.hostname) || u.port || u.username || u.password) {
    fail("INVALID_INPUT", "Only HTTPS URLs on www.alza.cz and webapi.alza.cz are supported.");
  }
  return u.toString();
}
export function productId(url: string): number | null {
  const u = new URL(alzaUrl(url));
  const match = u.pathname.match(/-d(\d+)\.htm$/);
  const id = match?.[1] ?? u.searchParams.get("dq");
  return id && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
}
export function productUrl(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) fail("INVALID_INPUT", "Product ID must be a positive integer.");
  return `${BASE_URL}/product-d${id}.htm`;
}
