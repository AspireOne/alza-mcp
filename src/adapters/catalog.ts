import { load } from "cheerio";
import JSON5 from "json5";
import type { Category, Facet, SearchQuery, Sort } from "../domain/contracts.js";
import { alzaUrl, BASE_URL } from "../infra/urls.js";
import { fail } from "../infra/failure.js";
import { object, pageData, text } from "./html.js";
import { listings } from "./listings.js";

const SORT_CODES: Record<Sort, number> = { relevance: 0, bestselling: 7, price_asc: 1, price_desc: 2, rating: 6, newest: 5 };
const CONDITION_IDS = { new: "inpStatusNew", opened: "inpStatusOpen", used: "inpStatusUsed" };
export function searchUrl(query: SearchQuery): string {
  if (query.query) {
    const url = new URL("/search.htm", BASE_URL); url.searchParams.set("exps", query.query);
    if (query.category_id) url.searchParams.set("idc", String(query.category_id));
    return url.toString();
  }
  return `${BASE_URL}/${query.category_id}.htm`;
}
export function categories(html: string, children = false): Category[] {
  const $ = load(html), found = new Map<number, Category>();
  const selectors = children ? ".category-tiles__categories a, .subCategoriesList a, .subCategories a, .subcategory a, [class*=subcategory] a" : 'li[class*="category-naviga"] a, .category-tree a, .subCategoriesList a';
  for (const el of $(selectors).toArray()) {
    const link = $(el), href = link.attr("href"), name = text(link.text());
    const match = href?.match(/\/(\d{4,})\.htm/);
    if (match && name && !found.has(Number(match[1]))) found.set(Number(match[1]), { id: Number(match[1]), name, url: alzaUrl(href!) });
  }
  if (!found.size && !children) fail("SCHEMA_CHANGED", "Alza's root category navigation was not recognized.");
  return [...found.values()];
}

interface Definition { name: string; values: Array<{ id: number; text: string; count: number; value: number | string; type?: string }> }
export function parameterDefinitions(html: string): Record<string, Definition> {
  const $ = load(html), result: Record<string, Definition> = {};
  for (const el of $("script").toArray()) {
    const source = $(el).text();
    for (const match of source.matchAll(/_parameterTypes\[(\d+)\]\s*=\s*\{/g)) {
      const start = match.index! + match[0].lastIndexOf("{");
      let depth = 0, quote = "", escaped = false;
      for (let i = start; i < source.length; i++) {
        const char = source[i]!;
        if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
          try { result[match[1]!] = JSON5.parse(source.slice(start, i + 1)); }
          catch { fail("PARSE_ERROR", "Alza's category parameter definitions could not be parsed."); }
          break;
        }
      }
    }
  }
  return result;
}
export function facets(html: string): Facet[] {
  const $ = load(html), defs = parameterDefinitions(html), found = new Map<number, Facet>();
  for (const el of $(".parameter[data-parameterid]").toArray()) {
    const node = $(el), id = Number(node.attr("data-parameterid"));
    if (!Number.isSafeInteger(id) || id <= 0 || found.has(id)) continue;
    const range = node.hasClass("slider"), def = defs[id];
    const name = text(node.find(".parameterName").first().text()) || def?.name;
    if (!name) fail("SCHEMA_CHANGED", "A category facet has no name.");
    const values: Facet["values"] = range ? (def?.values ?? []).map(v => ({ id: String(v.value), label: v.text, count: v.count, numeric_value: Number(v.value) })) : node.find(".parameterValue input").toArray().map(input => {
      const n = $(input), parent = n.closest(".parameterValue");
      return { id: n.attr("data-key") ?? n.attr("value") ?? "", label: text(parent.find(".name").text()) || parent.attr("title") || "", count: Number(parent.find(".commodityCount").text().replace(/[^\d]/g, "")) || null };
    });
    if (!values.length && def?.values?.length) values.push(...def.values.map(v => ({ id: String(v.value), label: v.text, count: v.count })));
    if (values.some(v => !v.id || !v.label)) fail("SCHEMA_CHANGED", "A category facet value could not be identified.");
    found.set(id, { id, name, kind: range ? "range" : "enum", values });
  }
  return [...found.values()];
}
export function manufacturers(html: string): Array<{ id: number; name: string }> {
  const $ = load(html);
  return $(".parameterValue.producer").toArray().map(e => ({ id: Number($(e).find("input").attr("value")), name: text($(e).find(".name").text()) })).filter(v => v.id > 0 && v.name);
}
export function sortOrders(html: string): Sort[] {
  const $ = load(html), codes = new Set($("a[data-sort]").toArray().map(el => Number($(el).attr("data-sort"))));
  return (Object.keys(SORT_CODES) as Sort[]).filter(sort => codes.has(SORT_CODES[sort]));
}

export function filterRequest(html: string, query: SearchQuery, page: number): Record<string, any> {
  const $ = load(html), bootstrap = pageData(html), data = object(bootstrap.data), filters = query.filters ?? {};
  if (typeof data.categoryTypeId !== "number" || typeof bootstrap.categoryId !== "number") fail("SCHEMA_CHANGED", "Alza's catalog filter bootstrap was not recognized.");
  if (query.category_id && bootstrap.categoryId !== query.category_id) fail("UNSUPPORTED_FILTER", "Alza did not apply the requested category restriction.");
  const sort = SORT_CODES[query.sort ?? "relevance"];
  if (!$("a[data-sort]").toArray().some(el => Number($(el).attr("data-sort")) === sort)) fail("UNSUPPORTED_FILTER", "This listing does not support the requested sort order.");
  const available = facets(html);
  const parameters = (filters.facets ?? []).map(selected => {
    const facet = available.find(f => f.id === selected.id);
    if (!facet) fail("UNSUPPORTED_FILTER", `Unknown category facet ${selected.id}. Use get_category to discover values.`);
    if (facet.kind === "range") {
      if (selected.values) fail("UNSUPPORTED_FILTER", `Facet ${facet.id} requires from/to, using the advertised numeric_value.`);
      const from = selected.from === undefined ? null : facet.values.findIndex(v => v.numeric_value === selected.from);
      const to = selected.to === undefined ? null : facet.values.findIndex(v => v.numeric_value === selected.to);
      if (from === -1 || to === -1 || selected.from !== undefined && selected.to !== undefined && selected.from > selected.to) fail("UNSUPPORTED_FILTER", "Range boundaries must match advertised numeric values in ascending order.");
      return { typeId: facet.id, valueFrom: selected.from ?? facet.values[0]!.numeric_value, valueTo: selected.to ?? facet.values.at(-1)!.numeric_value, orderFrom: from ?? 0, orderTo: to ?? facet.values.length - 1, valueIds: null };
    }
    if (!selected.values || selected.values.some(v => !facet.values.some(o => o.id === v))) fail("UNSUPPORTED_FILTER", `Invalid values for category facet ${facet.id}.`);
    const inputs = $(`.parameter[data-parameterid="${facet.id}"] input`).toArray();
    const values = selected.values.map(id => { const input = inputs.find(e => ($(e).attr("data-key") ?? $(e).attr("value")) === id); return input ? $(input).attr("value") : id; });
    return { from: null, to: null, orderFrom: null, orderTo: null, typeId: facet.id, values, valueIds: selected.values };
  });
  const makers = manufacturers(html);
  if (filters.manufacturers?.some(id => !makers.some(m => m.id === id))) fail("UNSUPPORTED_FILTER", "An unknown manufacturer filter was requested.");
  const commodityWears = (filters.condition ?? []).flatMap(condition => {
    const value = $(`#${CONDITION_IDS[condition]}`).attr("data-value");
    if (!value || !/^\d+(,\d+)*$/.test(value)) fail("UNSUPPORTED_FILTER", "The requested product condition is not supported here.");
    return value.split(",").map(Number);
  });
  let availabilityType = 0;
  if (filters.in_stock) {
    const value = $("label").filter((_, e) => /Skladem kdekoliv/.test($(e).text())).find('input[type="radio"]').attr("value");
    if (!value || !/^\d+$/.test(value)) fail("UNSUPPORTED_FILTER", "General in-stock filtering could not be identified.");
    availabilityType = Number(value);
  }
  const body: Record<string, any> = { idCategory: bootstrap.categoryId, producers: (filters.manufacturers ?? []).join(","), parameters, idPrefix: data.idPrefix ?? 0, prefixType: data.prefixType ?? 0, page, pageTo: page, availabilityType, newsOnly: false, commodityWears, upperDescriptionStatus: 0, branchId: -2, sort, categoryType: data.categoryTypeId, searchTerm: data.searchTerm ?? "", append: false, yearFrom: null, yearTo: null, artistId: data.artistId ?? null, minPrice: filters.min_price ?? -1, maxPrice: filters.max_price ?? -1, showOnlyActionCommodities: false, useRatingThreshold: false, showOnlyAlzaPlusCommodities: false, cashbackCodeStyleVariant: data.cashbackCodeStyleVariant ?? 2, callFromParametrizationDialog: false, configurationId: bootstrap.configurationId, scroll: 0, counter: 1 };
  body.hash = filterHash(body);
  return body;
}
export function filterHash(body: Record<string, any>): string {
  const parts = ["#f"];
  if (body.minPrice >= 0 || body.maxPrice >= 0) parts.push(`limit=${body.minPrice}--${body.maxPrice}`);
  if (body.availabilityType) parts.push(`availabilityFilterValue=${body.availabilityType}`);
  if (body.commodityWears.length) parts.push(`cst=${body.commodityWears.join(",")}`);
  parts.push("cud=0", `pg=${body.page}`);
  if (body.sort) parts.push(`pn=${body.sort}`);
  parts.push(`prod=${body.producers}`);
  for (const parameter of body.parameters) {
    if (parameter.valueIds) parts.push(`par${parameter.typeId}=${parameter.valueIds.map(encodeURIComponent).join(",")}`);
    else parts.push(`par${parameter.typeId}=${parameter.valueFrom}--${parameter.valueTo}`);
  }
  return parts.join("&");
}
export function parseFilter(raw: unknown, page: number): { products: ReturnType<typeof listings>; total: number; next: boolean } {
  const d = object(object(raw).d);
  if (!Number.isInteger(d.Count) || (d.Count as number) < 0 || d.Page !== page || typeof d.Boxes !== "string" || typeof d.PagerBottom !== "string") fail("SCHEMA_CHANGED", "Alza's catalog response is missing its page, count, or listings.");
  const products = listings(d.Boxes), pager = load(d.PagerBottom);
  if (!products.length && (d.Count as number) > 0) fail("INCOMPLETE_RESULTS", "Alza reports matches but returned no listings for this page.");
  return { products, total: d.Count as number, next: pager("a.next").length > 0 };
}
export function parseRenderedSearch(html: string, page: number, query: SearchQuery): { products: ReturnType<typeof listings>; total: number | null; next: boolean } {
  const $ = load(html), data = object(pageData(html).data), products = listings(html);
  const current = $("a.pgn.sel, [aria-current=page].pgn").first();
  if (products.length && (current.length ? Number(current.text()) !== page : page !== 1 || $("a.pgn").length > 0)) fail("PAGINATION_STALLED", "Recovery did not render the requested result page.");
  if (!products.length && data.isEmpty !== true) fail("INCOMPLETE_RESULTS", "Recovery returned no listings without confirming an empty search.");
  const filters = query.filters ?? {};
  for (const [key, label] of [["min_price", "Minimální cena"], ["max_price", "Maximální cena"]] as const) {
    if (filters[key] !== undefined) {
      const value = $(`input[aria-label="${label}"]`).attr("value")?.replace(/[\s\u00a0]/g, "").replace(",-", "");
      if (Number(value) !== filters[key]) fail("UNSUPPORTED_FILTER", "Recovery did not confirm the requested price filter.");
    }
  }
  // Complex selected state must be verified, not inferred from the URL fragment.
  for (const id of filters.manufacturers ?? []) if (!$(`input.producer[value="${id}"]`).is(":checked")) fail("UNSUPPORTED_FILTER", "Recovery did not apply the manufacturer filter.");
  for (const condition of filters.condition ?? []) if (!$(`#${CONDITION_IDS[condition]}`).is(":checked")) fail("UNSUPPORTED_FILTER", "Recovery did not apply the condition filter.");
  if (filters.facets?.length || filters.in_stock) fail("RECOVERY_UNSUPPORTED", "This renderer cannot independently verify the requested facet or stock state.");
  if (query.sort && query.sort !== "relevance" && !$('a[data-sort][aria-current="page"], .sorting__item-link--active').toArray().some(e => Number($(e).attr("data-sort")) === SORT_CODES[query.sort!])) fail("RECOVERY_UNSUPPORTED", "Recovery could not confirm the requested ordering.");
  const countText = $('#lblNumberItem').first().text().replace(/\s/g, '');
  if (countText && !/^\d+$/.test(countText)) fail('SCHEMA_CHANGED', 'The rendered result count could not be parsed.');
  return { products, total: countText ? Number(countText) : products.length ? null : 0, next: $("a.next[aria-label], a[id^=pgby]").length > 0 };
}
