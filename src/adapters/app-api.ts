import { load } from "cheerio";
import { z } from "zod";
import type { Category, Facet, Listing, Offer, Product, Section, Sort } from "../domain/contracts.js";
import { fail, SWITCH_HINT } from "../infra/failure.js";
import { log } from "../infra/logger.js";
import { alzaUrl, productId } from "../infra/urls.js";
import { blockText, text } from "./html.js";
import { SORT_CODES } from "./catalog.js";
import { CONDITION_PATTERN, couponFromTitle, membershipReference, money, offer } from "./listings.js";

// commodityWears and availabilityType values from the app's filter model.
export const CONDITION_WEARS = { new: [0], opened: [2], used: [1, 3] } as const;
export const IN_STOCK_ANYWHERE = 1;
// priceInfoV3 codes: AlzaPlus member price and company-benefit price group.
const PRICE_TYPE_ALZAPLUS = 17;
const PRICE_GROUP_BENEFIT = 5;
const CASHBACK_ITEM = 0;

/** Validates app JSON; a mismatch means Alza changed the app interface. */
export function parse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    log.error("api.schema_mismatch", { what, issues: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) });
    fail("SCHEMA_CHANGED", `Alza's app ${what} response changed shape. ${SWITCH_HINT}`);
  }
  return parsed.data;
}
/** Restservice envelopes report application errors as err/msg beside HTTP 200. */
export function envelope(raw: unknown, what: string): Record<string, unknown> {
  const data = parse(z.object({ err: z.number(), msg: z.string().nullable().optional() }).passthrough(), raw, what);
  if (data.err !== 0) fail("UPSTREAM_ERROR", `Alza's app API reported an error for the ${what}${data.msg ? `: ${data.msg}` : "."}`);
  return data;
}

const link = z.object({ href: z.string() }).passthrough();
const priceTag = z.object({
  primaryPrice: z.string().nullable(), primaryPriceNoCurrency: z.number().nullable(), secondaryPrice: z.string().nullable(), secondaryPricePrefix: z.string().nullable(),
  comparePrice: z.string().nullable(), headerText: z.string().nullable(), priceSave: z.string().nullable(), priceType: z.number(), priceGroupType: z.number(),
}).passthrough();
const cashBackItem = z.object({ type: z.number(), price: z.string(), label: z.string(), sublabel: z.string().nullable().optional(), annotation: z.string().nullable().optional() }).passthrough();
const alternativeTag = z.object({ headerText: z.string().nullable(), primaryPrice: z.string().nullable(), primaryPricePostfix: z.string().nullable(), priceSave: z.string().nullable() }).passthrough();
const priced = { priceInfoV3: z.object({ mainPriceTag: priceTag.nullable(), alternativePriceTag: alternativeTag.nullable().optional() }).passthrough().nullable(), cashBackItems: z.array(cashBackItem).nullable() };
const listItem = z.object({
  id: z.number().int().positive(), code: z.string().nullable(), name: z.string().min(1), url: z.string(), img: z.string().nullable(), spec: z.string().nullable(),
  avail: z.string().nullable(), rating: z.number().nullable(), ratingCount: z.number().nullable(), sponsoredCommodityInfo: z.unknown(), ...priced,
}).passthrough();
const sortList = z.array(z.object({ sort: z.number() }).passthrough());
export const productListSchema = z.object({ total: z.number().int().nonnegative(), has_next: z.boolean(), data: z.array(listItem) }).passthrough();
export const searchListSchema = z.object({ total: z.number().int().nonnegative(), has_next: z.boolean(), sorts: sortList.nullable(), data2: z.array(listItem).nullable() }).passthrough();
const facetValue = z.object({ v: z.number(), desc: z.string(), cnt: z.number().nullable() }).passthrough();
const facetSchema = z.object({ tId: z.number().int(), name: z.string(), renderType: z.string().nullable(), values: z.array(facetValue) }).passthrough();
export const facetsSchema = z.object({ params: z.array(z.object({ groups: z.array(z.object({ params: z.array(facetSchema) }).passthrough()) }).passthrough()), producers: z.array(facetValue) }).passthrough();
const categoryNode = z.object({ id: z.number().int(), name: z.string(), cat_type: z.string(), url: z.string().nullable() }).passthrough();
export const categorySchema = z.object({
  cat_name: z.string().nullable(), ltp: z.boolean(), data: z.array(categoryNode),
  current: z.object({ id: z.number().int(), name: z.string(), url: z.string().nullable(), sorts: sortList }).passthrough(),
}).passthrough();
const parameterGroup = z.object({ name: z.string(), params: z.array(z.object({ name: z.string(), values: z.array(z.object({ desc: z.string() }).passthrough()) }).passthrough()) }).passthrough();
export const productSchema = z.object({
  id: z.number().int().positive(), code: z.string().nullable(), name: z.string().min(1), url: z.string(), spec: z.string().nullable(), avail: z.string().nullable(),
  catalog_number: z.string().nullable(), warranty: z.string().nullable(), amountInPack: z.number().nullable(), minimumAmount: z.number().nullable(), maxCanBuy: z.number().nullable(),
  categoryName: z.string().nullable(), descPageUrl: z.string().nullable(), parameterGroups: z.array(parameterGroup).nullable(),
  imgs: z.array(z.object({ origUrl: z.string() }).passthrough()).nullable(), self: link, reviewStats: link.nullable(), ...priced,
}).passthrough();
export const productV14Schema = z.object({
  id: z.number().int().positive(), producerName: z.string().nullable(), commodityVariantsAction: link.nullable(),
  manuals: link.nullable(), videoList: z.array(z.object({ ytHash: z.string() }).passthrough()).nullable(),
}).passthrough();
export const manualsSchema = z.object({ manuals: z.array(z.object({ name: z.string().nullable(), self: link }).passthrough()) }).passthrough();
const YOUTUBE_WATCH = "https://www.youtube.com/watch?v=";
const variantGroup = z.object({ parameterTypeName: z.string(), values: z.array(z.object({
  parameterValue: z.string(), selected: z.boolean(), priceDifferenceText: z.string().nullable(), availability: z.string().nullable(), commodityAction: z.object({ webLink: z.string() }).passthrough().nullable(),
}).passthrough()) }).passthrough();
const VARIANT_KINDS = ["variants", "colorVariants", "sizeVariants"] as const;
// Condition alternatives (new, like-new, used) are flat options rather than parameter groups.
const wearVariant = z.object({ description: z.string().nullable(), isSelected: z.boolean(), price: z.string().nullable(), commodityAction: z.object({ webLink: z.string(), name: z.string() }).passthrough() }).passthrough();
// Product lines are sibling models in the same series.
const productLine = z.object({ selected: z.boolean(), availability: z.string().nullable(), price: z.string().nullable(), commodityAction: z.object({ webLink: z.string(), name: z.string() }).passthrough() }).passthrough();
export const variantsSchema = z.object({
  ...Object.fromEntries(VARIANT_KINDS.map(kind => [kind, z.array(variantGroup).nullable()])) as Record<typeof VARIANT_KINDS[number], z.ZodNullable<z.ZodArray<typeof variantGroup>>>,
  wearVariants: z.array(wearVariant).nullable(),
  productLines: z.array(productLine).nullable(),
  productLineDescriptions: z.array(z.object({ name: z.string() }).passthrough()).nullable(),
}).passthrough();

export function sortsOf(raw: z.infer<typeof sortList> | null): Sort[] {
  const codes = new Set((raw ?? []).map(s => s.sort));
  return (Object.keys(SORT_CODES) as Sort[]).filter(sort => codes.has(SORT_CODES[sort]));
}

/** Offers from the app's price tag and promotion items. Amounts are Alza's own totals; nothing is recomputed. */
export function appOffers(item: { priceInfoV3: z.infer<typeof priced.priceInfoV3>; cashBackItems: z.infer<typeof priced.cashBackItems> }, signedIn: boolean, primaryKind: "effective" | "public"): Offer[] {
  const tag = item.priceInfoV3?.mainPriceTag;
  if (!tag) return [];
  const result: Offer[] = [];
  const header = text(tag.headerText ?? "");
  const membershipApplied = signedIn && tag.priceType === PRICE_TYPE_ALZAPLUS;
  const applied = header && (membershipApplied || signedIn && tag.priceGroupType === PRICE_GROUP_BENEFIT) ? [header] : [];
  const promotion = couponFromTitle(header);
  const conditional = !!promotion || /s alzaplus/i.test(header) && !membershipApplied;
  const prefix = tag.secondaryPricePrefix ?? "";
  // The secondary price names the primary's VAT basis; without it a company account's basis is unproven.
  const vat: Offer["vat"] = /bez DPH/i.test(prefix) ? "included" : /s DPH/i.test(prefix) ? "excluded" : signedIn ? "unknown" : "included";
  const amount = money(tag.primaryPriceNoCurrency) ?? money(tag.primaryPrice);
  if (!amount) fail("SCHEMA_CHANGED", `Alza's app price could not be read. ${SWITCH_HINT}`);
  result.push({ ...offer(amount, tag.primaryPrice, conditional ? "conditional" : primaryKind, conditional ? [header] : applied), vat, ...(promotion ? { promotion } : {}) });
  if (tag.secondaryPrice) {
    const secondary = money(tag.secondaryPrice);
    if (!secondary) fail("SCHEMA_CHANGED", `Alza's app secondary price could not be read. ${SWITCH_HINT}`);
    result.push({ ...offer(secondary, `${prefix}${tag.secondaryPrice}`, primaryKind), vat: vat === "included" ? "excluded" : "included" });
  }
  const membership = membershipReference(text(tag.priceSave ?? ""));
  if (membership) result.push({ ...membership, vat });
  for (const promo of item.cashBackItems ?? []) {
    const promoAmount = money(promo.price);
    if (!promoAmount) fail("SCHEMA_CHANGED", `Alza's app promotion price could not be read. ${SWITCH_HINT}`);
    const code = promo.sublabel || null, cashback = promo.type === CASHBACK_ITEM;
    const conditions = [text(promo.label), text(promo.annotation ?? ""), ...applied].filter(Boolean);
    result.push({ ...offer(promoAmount, promo.price, "conditional", conditions), vat, promotion: cashback ? { type: "cashback" } : code ? { type: "coupon", code } : { type: "other" } });
  }
  const compare = money(tag.comparePrice);
  if (compare) result.push({ ...offer(compare, tag.comparePrice, "reference"), eligibility: "unknown", vat });
  return result;
}

export function appListing(raw: z.infer<typeof listItem>, signedIn: boolean): Listing {
  const url = alzaUrl(raw.url);
  if (productId(url) !== raw.id) fail("PRODUCT_ID_MISMATCH", "A listing URL disagrees with its product ID.");
  const rated = !!raw.ratingCount;
  return {
    id: raw.id, code: raw.code, name: text(raw.name), url, image: raw.img, description: raw.spec ? text(raw.spec) : null,
    condition: CONDITION_PATTERN.exec(`${raw.avail ?? ""} ${raw.name}`)?.[0] ?? null, availability: raw.avail ? text(raw.avail) : null,
    offers: appOffers(raw, signedIn, "effective"), rating: rated ? raw.rating : null, rating_count: rated ? raw.ratingCount : null, sponsored: !!raw.sponsoredCommodityInfo,
  };
}

export function appFacets(raw: z.infer<typeof facetsSchema>): { facets: Facet[]; manufacturers: Array<{ id: number; name: string }> } {
  const facets = new Map<number, Facet>();
  for (const parameter of raw.params.flatMap(p => p.groups).flatMap(g => g.params)) {
    const range = parameter.renderType === "Slider";
    if (facets.has(parameter.tId)) continue;
    // Enum value IDs keep the storefront's "{facet}-{value}" form so both backends accept the same IDs.
    facets.set(parameter.tId, { id: parameter.tId, name: parameter.name, kind: range ? "range" : "enum", values: parameter.values.map(v => range
      ? { id: String(v.v), label: v.desc, count: v.cnt, numeric_value: v.v }
      : { id: `${parameter.tId}-${v.v}`, label: v.desc, count: v.cnt }) });
  }
  return { facets: [...facets.values()], manufacturers: raw.producers.map(p => ({ id: p.v, name: p.desc })) };
}

export function categoryChildren(nodes: z.infer<typeof categoryNode>[], types: readonly string[]): Category[] {
  // Node IDs are the app's own category IDs; URLs are often bare landing slugs without one.
  // Placeholder nodes (promotional boosts, buying guides) have ID 0.
  return nodes.filter(node => node.id > 0 && types.includes(node.cat_type) && node.url).map(node => ({ id: node.id, name: text(node.name), url: alzaUrl(node.url!) }));
}

const available = (data: unknown): Section<unknown> => ({ state: "available", data });
const absent: Section<unknown> = { state: "not_provided" };

/** Product detail from the router (prices, availability, parameters) and v14 (brand, manuals, variants link) payloads. */
export function appProduct(detail: z.infer<typeof productSchema>, v14: z.infer<typeof productV14Schema>, id: number, signedIn: boolean): Product {
  if (detail.id !== id || v14.id !== id || productId(alzaUrl(detail.url)) !== id) fail("PRODUCT_ID_MISMATCH", "Alza's app answered for a different product ID.");
  const identifiers: Record<string, string> = {};
  if (detail.code) identifiers.sku = detail.code;
  if (detail.catalog_number) identifiers.mpn = detail.catalog_number;
  return {
    id, code: detail.code, name: text(detail.name), url: alzaUrl(detail.url), brand: v14.producerName, identifiers,
    condition: CONDITION_PATTERN.exec(`${detail.avail ?? ""} ${detail.name}`)?.[0] ?? null, availability: detail.avail ? text(detail.avail) : null, sections: {},
  };
}

export function specificationsSection(detail: z.infer<typeof productSchema>): Section<unknown> {
  const specs = (detail.parameterGroups ?? []).flatMap(group => group.params.map(p => ({ group: text(group.name) || null, name: text(p.name), value: p.values.map(v => v.desc).join(",") })));
  return specs.length ? available(specs) : absent;
}

export function offersSection(detail: z.infer<typeof productSchema>, signedIn: boolean): Section<unknown> {
  const offers = appOffers(detail, signedIn, signedIn ? "effective" : "public");
  return offers.length ? available(offers) : absent;
}

export function attributesSection(detail: z.infer<typeof productSchema>, v14: z.infer<typeof productV14Schema>): Section<unknown> {
  const financing = detail.priceInfoV3?.alternativePriceTag;
  return available({
    name: text(detail.name), sku: detail.code, mpn: detail.catalog_number, brand: v14.producerName, category: detail.categoryName,
    minimum_pieces: detail.minimumAmount, maximum_pieces: detail.maxCanBuy, pieces_in_pack: detail.amountInPack, warranty: detail.warranty,
    financing_displays: financing ? [text([financing.headerText, financing.primaryPrice, financing.primaryPricePostfix, financing.priceSave].filter(Boolean).join(" "))] : [],
  });
}

/** The app's description page: the readable description plus embedded media and document links. */
export function descriptionPage(html: string, url: string): { text: string | null; media: unknown[]; documents: Array<{ url: string; title: string }> } {
  const $ = load(html), body = $(".commodity-description").first();
  if (!body.length) fail("SCHEMA_CHANGED", `Alza's app description page changed shape. ${SWITCH_HINT}`);
  const media: unknown[] = [];
  for (const el of body.find("img[src]").toArray()) { const n = $(el); media.push({ url: new URL(n.attr("src")!, url).href, title: n.attr("alt") || null, type: "description_image" }); }
  for (const el of body.find("video, iframe").toArray()) { const n = $(el), src = n.attr("src") || n.find("source").attr("src"); if (src) media.push({ url: new URL(src, url).href, title: n.attr("title") ?? null, type: el.tagName }); }
  const documents = new Map<string, { url: string; title: string }>();
  for (const el of body.find("a[href]").toArray()) {
    const n = $(el), target = new URL(n.attr("href")!, url);
    if (target.protocol === "https:" && /\.(pdf|docx?|xlsx?|zip)$/i.test(target.pathname)) documents.set(target.href, { url: target.href, title: text(n.text()) || n.attr("title") || "" });
  }
  return { text: blockText(body) || null, media, documents: [...documents.values()] };
}

export function mediaSection(detail: z.infer<typeof productSchema>, v14: z.infer<typeof productV14Schema>, description: unknown[]): Section<unknown> {
  const media = [
    ...(detail.imgs ?? []).map(image => ({ url: image.origUrl, title: null, type: "image" })),
    ...(v14.videoList ?? []).map(video => ({ url: `${YOUTUBE_WATCH}${encodeURIComponent(video.ytHash)}`, title: null, type: "video" })),
    ...description,
  ];
  return media.length ? available(media) : absent;
}

export function documentsSection(manuals: z.infer<typeof manualsSchema> | null, description: Array<{ url: string; title: string }>): Section<unknown> {
  const documents = new Map(description.map(document => [document.url, document]));
  for (const manual of manuals?.manuals ?? []) documents.set(manual.self.href, { url: manual.self.href, title: text(manual.name ?? "") });
  return documents.size ? available([...documents.values()]) : absent;
}

export function variantsSection(raw: z.infer<typeof variantsSchema>): Section<unknown> {
  const linked = (webLink: string) => { const url = alzaUrl(webLink); return { product_id: productId(url), url }; };
  const groups = VARIANT_KINDS.flatMap(kind => raw[kind] ?? []).filter(group => group.values.length).map(group => ({
    kind: "parameter",
    label: text(group.parameterTypeName),
    options: group.values.map(value => ({
      label: text(value.parameterValue), selected: value.selected, ...(value.commodityAction ? linked(value.commodityAction.webLink) : { product_id: null, url: null }),
      price_difference: value.priceDifferenceText, availability: value.availability,
    })),
  }));
  const wear = raw.wearVariants ?? [];
  const conditions = wear.length ? [{
    kind: "condition",
    label: null,
    options: wear.map(value => ({ label: text(value.commodityAction.name), description: value.description, selected: value.isSelected, ...linked(value.commodityAction.webLink), price_display: value.price })),
  }] : [];
  const line = raw.productLines ?? [];
  const lines = line.length ? [{
    kind: "product_line",
    label: raw.productLineDescriptions?.[0] ? text(raw.productLineDescriptions[0].name) : null,
    options: line.map(value => ({ label: text(value.commodityAction.name), selected: value.selected, ...linked(value.commodityAction.webLink), price_display: value.price, availability: value.availability })),
  }] : [];
  const all = [...groups, ...conditions, ...lines];
  return all.length ? available({ groups: all, note: "Each option links to its own product ID; prices and price differences are as shown by Alza." }) : absent;
}
