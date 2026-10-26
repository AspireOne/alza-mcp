import { load } from "cheerio";
import type { Reader } from "../infra/reader.js";
import { fail } from "../infra/failure.js";
import { BASE_URL, FILTER_PATH, productUrl } from "../infra/urls.js";
import { categories, categoryIdentity, facets, manufacturers, sortOrders, filterRequest, parseFilter, parseRenderedSearch, searchUrl } from "../adapters/catalog.js";
import { parseProduct } from "../adapters/product.js";
import { reviewStatisticsUrl } from "../adapters/review-statistics.js";
import { object, pageData } from "../adapters/html.js";
import { log } from "../infra/logger.js";
import type { Catalog } from "./catalog.js";

const DETAIL_HYDRATION = ["description", "specifications", "variants"] as const;
const PRODUCT_CACHE_MS = 60_000;

export const browserCatalog: Catalog<Reader> = {
  categories: async reader => categories((await reader.page(BASE_URL)).html),
  async category(reader, op, id) {
    const doc = await reader.page(searchUrl({ category_id: id }), { category: true });
    const $ = load(doc.html);
    const observed = categoryIdentity($);
    if (observed !== id) {
      log.warn("category.identity_mismatch", { request_id: op.id, requested_category_id: id, observed_category_id: observed, path: new URL(doc.url).pathname });
      fail("CATEGORY_ID_MISMATCH", "The page does not describe the requested category.");
    }
    const sorts = sortOrders($);
    return { id, name: $("h1").first().text().trim(), url: doc.url, children: categories($, true), facets: facets($), manufacturers: manufacturers($), sort_orders: sorts, listing_supported: sorts.length > 0 };
  },
  async searchPage(reader, op, query, page) {
    const doc = await reader.page(searchUrl(query), { stock: query.filters?.in_stock, category: true });
    const $ = load(doc.html), bootstrap = pageData($), data = object(bootstrap.data);
    const sorts = sortOrders($);
    if (data.isSearch === true && data.isEmpty === true && page === 1) {
      if (query.filters?.facets?.length || query.filters?.manufacturers?.length) fail("UNSUPPORTED_FILTER", "This empty search does not advertise the requested facet or manufacturer filters.");
      return { products: [], total: 0, next: false, effectiveUrl: doc.url, sorts };
    }
    if (!sorts.length && !$(".browsingitem").length && $('[data-testid="category-tiles"]').length) {
      const id = categoryIdentity($), suggested = categories($, true);
      if (!id || !suggested.length) fail("SCHEMA_CHANGED", "Alza's category navigation could not be identified.");
      if (query.category_id && query.category_id !== id) fail("CATEGORY_ID_MISMATCH", "The page does not describe the requested category.");
      fail("CATEGORY_NOT_LISTABLE", "Alza redirected this search to a category hub without product listings. Search a child category instead.", { category_id: id, suggested_categories: suggested });
    }
    const body = filterRequest($, query, page), effectiveUrl = `${doc.url.split("#")[0]}${body.hash}`;
    const signedIn = op.meta.auth.state === 'signed_in';
    const parsed = reader.canPost ? parseFilter(await reader.json(`${BASE_URL}${FILTER_PATH}`, body), page, signedIn) : parseRenderedSearch((await reader.page(effectiveUrl)).html, page, query, signedIn);
    // Company accounts can change listing VAT presentation; the card alone
    // does not prove the basis. Product detail carries explicit VAT offers.
    if (signedIn) for (const p of parsed.products) for (const offer of p.offers) offer.vat = "unknown";
    return { ...parsed, effectiveUrl, sorts };
  },
  async product(reader, op, id, sections, cache) {
    // Specifications and downloads can appear in either lazy tab; media also uses the description.
    const hydration = DETAIL_HYDRATION.filter(section =>
      section === "description" ? sections.some(requested => ["description", "media", "documents", "specifications"].includes(requested)) :
      section === "specifications" ? sections.some(requested => ["specifications", "documents"].includes(requested)) :
      section === "variants" && sections.includes(section));
    const coverage = cache.has(`product:${id}:${DETAIL_HYDRATION.join(",")}`, PRODUCT_CACHE_MS) ? DETAIL_HYDRATION : hydration;
    const doc = await cache.load(`product:${id}:${coverage.join(",")}`, PRODUCT_CACHE_MS, () => reader.page(productUrl(id), { detail: coverage }));
    const product = parseProduct(doc.html, doc.url, id, op.meta.auth.state === "signed_in", sections.filter(section => section !== "reliability"));
    const ratings = product.sections.ratings;
    return { product, aggregate: ratings?.state === "available" ? ratings.data : null, statisticsUrl: async () => reviewStatisticsUrl(doc.html, id) };
  },
  reviewStatisticsUrl: async (reader, _op, id) => reviewStatisticsUrl((await reader.page(productUrl(id))).html, id),
};
