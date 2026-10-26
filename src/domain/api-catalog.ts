import type { ApiSource } from "../infra/api-access.js";
import { fail, failureOf } from "../infra/failure.js";
import { alzaUrl, BASE_URL } from "../infra/urls.js";
import { filterHash, searchUrl, SORT_CODES } from "../adapters/catalog.js";
import {
  appFacets, appListing, appProduct, attributesSection, categoryChildren, categorySchema, CONDITION_WEARS, descriptionPage, documentsSection, envelope, facetsSchema, IN_STOCK_ANYWHERE,
  manualsSchema, mediaSection, offersSection, parse, productListSchema, productSchema, productV14Schema, searchListSchema, sortsOf, specificationsSection, variantsSection, variantsSchema,
} from "../adapters/app-api.js";
import type { Catalog } from "./catalog.js";
import type { Facet, ProductSection, SearchQuery, Section } from "./contracts.js";

const RESTSERVICE = `${BASE_URL}/services/restservice.svc`;
const COUNTRY = "CZ";
const ROOT_CATEGORY = 1;
const PRODUCT_CACHE_MS = 60_000;
// The root navigation lists categories and promotional collections; deeper levels list only categories.
const ROOT_TYPES = ["CATEGORY", "ACTION"], CHILD_TYPES = ["CATEGORY"];
const DESCRIPTION_SECTIONS: ProductSection[] = ["description", "media", "documents"];

const categoryUrl = (id: number) => `${RESTSERVICE}/v1/category/${id}?T=CATEGORY&P=0`;
const facetsUrl = (id: number, type: string, search = "") => `${RESTSERVICE}/v3/params/${id}?type=${type}&typeId=0&search=${encodeURIComponent(search)}`;

async function category(source: ApiSource, id: number) {
  const raw = parse(categorySchema, envelope(await source.json(categoryUrl(id)), "category"), "category");
  if (raw.current.id !== id) fail("CATEGORY_ID_MISMATCH", "Alza's app answered for a different category.");
  return raw;
}
async function routerProduct(source: ApiSource, id: number) {
  return parse(productSchema, envelope(await source.json(`${BASE_URL}/api/router/legacy/catalog/product/${id}?country=${COUNTRY}`), "product").data, "product");
}
async function facets(source: ApiSource, id: number, type: string, search?: string) {
  return appFacets(parse(facetsSchema, envelope(await source.json(facetsUrl(id, type, search)), "facets"), "facets"));
}

/** Builds the app's filter parameters, rejecting filters the listing does not advertise, plus the matching website filter fragment. */
function filterParameters(query: SearchQuery, id: number, type: string, page: number, advertised: { facets: Facet[]; manufacturers: Array<{ id: number }> } | null) {
  const filters = query.filters ?? {};
  const selections = (filters.facets ?? []).map(selected => {
    const facet = advertised?.facets.find(f => f.id === selected.id);
    if (!facet) fail("UNSUPPORTED_FILTER", advertised ? `Unknown category facet ${selected.id}. Use get_category to discover values.` : "The API backend supports facet filters only in category listings.");
    if (facet.kind === "range") {
      if (selected.values) fail("UNSUPPORTED_FILTER", `Facet ${facet.id} requires from/to, using the advertised numeric_value.`);
      const advertisedValues = facet.values.map(v => v.numeric_value);
      if (selected.from !== undefined && !advertisedValues.includes(selected.from) || selected.to !== undefined && !advertisedValues.includes(selected.to) || selected.from !== undefined && selected.to !== undefined && selected.from > selected.to) fail("UNSUPPORTED_FILTER", "Range boundaries must match advertised numeric values in ascending order.");
      // An open bound means the advertised extreme, as on the website.
      return { typeId: facet.id, valueFrom: selected.from ?? advertisedValues[0]!, valueTo: selected.to ?? advertisedValues.at(-1)!, valueIds: null };
    }
    if (!selected.values || selected.values.some(v => !facet.values.some(o => o.id === v))) fail("UNSUPPORTED_FILTER", `Invalid values for category facet ${facet.id}.`);
    return { typeId: facet.id, valueFrom: null, valueTo: null, valueIds: selected.values };
  });
  if (filters.manufacturers?.some(m => !advertised?.manufacturers.some(a => a.id === m))) fail("UNSUPPORTED_FILTER", "An unknown manufacturer filter was requested.");
  const sort = SORT_CODES[query.sort ?? "relevance"], availabilityType = filters.in_stock ? IN_STOCK_ANYWHERE : 0, producers = filters.manufacturers ?? [];
  const commodityWears = (filters.condition ?? []).flatMap(condition => CONDITION_WEARS[condition]);
  const body = {
    id, type, typeId: 0, orderBy: sort, page, availabilityType, selectedBranches: [], commodityWears, sendPrices: true, minPrice: filters.min_price ?? null, maxPrice: filters.max_price ?? null,
    params: selections.map(p => ({ tId: p.typeId, v: p.valueIds?.map(v => Number(v.slice(`${p.typeId}-`.length))) ?? [], vFrom: p.valueFrom, vTo: p.valueTo })),
    areas: [], latitude: null, longitude: null, producers, useRatingThreshold: false, showOnlyActionCommodities: false, showOnlyAlzaPlusCommodities: false,
  };
  const hash = filterHash({ minPrice: filters.min_price ?? -1, maxPrice: filters.max_price ?? -1, availabilityType, commodityWears, page, sort, producers: producers.join(","), parameters: selections });
  return { body, hash };
}

type Loaded<T> = { state: "loaded"; data: T } | { state: "failed"; error: ReturnType<typeof failureOf> } | null;
/** Loads a supplementary document; its failure fails only the sections built from it. */
async function optional<T>(wanted: boolean, load: () => Promise<T>): Promise<Loaded<T>> {
  if (!wanted) return null;
  try { return { state: "loaded", data: await load() }; }
  catch (error) { return { state: "failed", error: failureOf(error) }; }
}
function from<T>(value: Loaded<T>, build: (data: T | null) => Section<unknown>): Section<unknown> {
  return value?.state === "failed" ? value : build(value?.data ?? null);
}

export const apiCatalog: Catalog<ApiSource> = {
  categories: async source => categoryChildren((await category(source, ROOT_CATEGORY)).data, ROOT_TYPES),
  async category(source, _op, id) {
    const raw = await category(source, id);
    const sorts = sortsOf(raw.current.sorts);
    // Hubs ("local title pages") list subcategories but no products or filters.
    const advertised = raw.ltp ? { facets: [], manufacturers: [] } : await facets(source, id, "CATEGORY");
    return { id, name: raw.cat_name ?? raw.current.name, url: raw.current.url ?? categoryUrl(id), children: categoryChildren(raw.data, CHILD_TYPES), ...advertised, sort_orders: raw.ltp ? [] : sorts, listing_supported: !raw.ltp && sorts.length > 0 };
  },
  async searchPage(source, op, query, page) {
    if (query.query && query.category_id) fail("UNSUPPORTED_FILTER", "The API backend cannot restrict a text search to a category. Search the category with filters, or search the text alone.");
    const requested = query.sort ?? "relevance";
    if (query.category_id) {
      const id = query.category_id, raw = await category(source, id);
      if (raw.ltp) fail("CATEGORY_NOT_LISTABLE", "This category is a hub without product listings. Search a child category instead.", { category_id: id, suggested_categories: categoryChildren(raw.data, CHILD_TYPES) });
      const sorts = sortsOf(raw.current.sorts);
      if (!sorts.includes(requested)) fail("UNSUPPORTED_FILTER", "This listing does not support the requested sort order.", { sort_orders: sorts });
      const advertised = query.filters?.facets?.length || query.filters?.manufacturers?.length ? await facets(source, id, "CATEGORY") : null;
      const { body, hash } = filterParameters(query, id, "CATEGORY", page, advertised);
      const list = parse(productListSchema, envelope(await source.json(`${RESTSERVICE}/v2/products?categoryId=${id}`, { filterParameters: body }), "product listing"), "product listing");
      const signedIn = op.meta.auth.state === "signed_in";
      return { products: list.data.map(item => appListing(item, signedIn)), total: list.total, next: list.has_next, effectiveUrl: `${alzaUrl(raw.current.url ?? `/${id}.htm`)}${hash}`, sorts };
    }
    const term = query.query!;
    const advertised = query.filters?.manufacturers?.length ? await facets(source, 0, "PRODUCTION", term) : null;
    const { body, hash } = filterParameters(query, 0, "PRODUCTION", page, advertised);
    const list = parse(searchListSchema, envelope(await source.json(`${RESTSERVICE}/v5/search`, { ...body, searchTerm: term }), "search"), "search");
    const sorts = sortsOf(list.sorts);
    // An empty search advertises no orders; the requested order is then irrelevant.
    if (list.total && !sorts.includes(requested)) fail("UNSUPPORTED_FILTER", "This search does not support the requested sort order.", { sort_orders: sorts });
    const signedIn = op.meta.auth.state === "signed_in";
    return { products: (list.data2 ?? []).map(item => appListing(item, signedIn)), total: list.total, next: list.has_next, effectiveUrl: `${searchUrl(query)}${hash}`, sorts };
  },
  async product(source, op, id, sections, cache) {
    const detail = await cache.load(`product:${id}`, PRODUCT_CACHE_MS, () => routerProduct(source, id));
    // The router's self link carries the account and price-group context the v14 detail requires.
    const context = new URL(detail.self.href).search;
    const v14 = await cache.load(`product-v14:${id}`, PRODUCT_CACHE_MS, async () => parse(productV14Schema, await source.json(`${BASE_URL}/api/legacy/catalog/v14/product/${id}${context}`), "product detail"));
    const signedIn = op.meta.auth.state === "signed_in";
    const product = appProduct(detail, v14, id, signedIn);
    const descriptionUrl = detail.descPageUrl;
    const description = await optional(!!descriptionUrl && sections.some(s => DESCRIPTION_SECTIONS.includes(s)), () => cache.load(`description:${id}`, PRODUCT_CACHE_MS, async () => descriptionPage(await source.text(descriptionUrl!), descriptionUrl!)));
    const manuals = await optional(!!v14.manuals && sections.includes("documents"), async () => parse(manualsSchema, await source.json(v14.manuals!.href), "manuals"));
    const variants = await optional(!!v14.commodityVariantsAction && sections.includes("variants"), async () => parse(variantsSchema, await source.json(v14.commodityVariantsAction!.href), "variants"));
    const builders: Record<Exclude<ProductSection, "ratings" | "reliability">, () => Section<unknown>> = {
      description: () => from(description, page => page?.text || detail.spec ? { state: "available", data: { summary: detail.spec, full_text: page?.text ?? null } } : { state: "not_provided" }),
      specifications: () => specificationsSection(detail),
      variants: () => from(variants, data => data ? variantsSection(data) : { state: "not_provided" }),
      media: () => from(description, page => mediaSection(detail, v14, page?.media ?? [])),
      documents: () => from(manuals, data => from(description, page => documentsSection(data, page?.documents ?? []))),
      offers: () => offersSection(detail, signedIn),
      attributes: () => attributesSection(detail, v14),
    };
    for (const section of sections) if (section !== "ratings" && section !== "reliability") product.sections[section] = builders[section]();
    const statistics = detail.reviewStats?.href;
    return { product, aggregate: null, statisticsUrl: async () => statistics ?? fail("SCHEMA_CHANGED", "Alza's app product has no review statistics link.") };
  },
  async reviewStatisticsUrl(source, _op, id) {
    const detail = await routerProduct(source, id);
    if (detail.id !== id) fail("PRODUCT_ID_MISMATCH", "Alza's app answered for a different product ID.");
    return detail.reviewStats?.href ?? fail("SCHEMA_CHANGED", "Alza's app product has no review statistics link.");
  },
};
