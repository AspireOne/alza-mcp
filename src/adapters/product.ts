import { load } from "cheerio";
import type { Product, ProductSection, Section, Offer } from "../domain/contracts.js";
import { PRODUCT_SECTIONS } from "../domain/contracts.js";
import { fail, failureOf } from "../infra/failure.js";
import { productId, alzaUrl } from "../infra/urls.js";
import { jsonLd, object, pageData, string, text } from "./html.js";
import { money, offer } from "./listings.js";

const available = (data: unknown): Section<unknown> => ({ state: "available", data });
const absent: Section<unknown> = { state: "not_provided" };
export function parseProduct(html: string, url: string, id: number, signedIn: boolean, requested: ProductSection[] = [...PRODUCT_SECTIONS]): Product {
  const $ = load(html), bootstrap = pageData(html), detail = object(bootstrap.data), ld = jsonLd(html, "Product");
  if (!ld || detail.cid !== id || productId(url) !== id) fail("PRODUCT_ID_MISMATCH", "The page does not describe the requested product ID.");
  const name = string(ld.name) || text($("h1").first().text());
  if (!name) fail("SCHEMA_CHANGED", "The product name was not found.");
  const baseOffer = object(Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);
  const identifiers: Record<string, string> = {};
  for (const key of ["sku", "mpn", "gtin", "gtin13", "gtin14"]) if (typeof ld[key] === "string") identifiers[key] = ld[key] as string;
  const result: Product = { id, code: string(detail.commodityCode) || string(ld.sku), name, url, brand: string(object(ld.brand).name) || string(detail.producerName), identifiers, condition: string(baseOffer.itemCondition), availability: string(baseOffer.availability), sections: {} };
  const parsers: Record<ProductSection, () => Section<unknown>> = {
    description: () => {
      const node = $("#descAnnotation");
      if (node.length && !text(node.text())) fail("SECTION_INCOMPLETE", "The full product description did not finish loading.");
      const clone = (node.length ? node : $("#descriptionContent")).clone();
      clone.find("script, style, link, .infoPopup").remove();
      clone.find("p, h1, h2, h3, h4, li, br").append("\n");
      const full = clone.text().replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
      return full || ld.description ? available({ summary: string(ld.description), full_text: full || null }) : absent;
    },
    specifications: () => {
      const groups = $("#parameters .allpar .groupx, #descriptionContent .allpar .groupx");
      const specs = new Map<string, { group: string | null; name: string; value: string }>();
      for (const el of groups.find("[data-parameter-name]").toArray()) {
        const n = $(el), key = n.attr("data-parameter-name")!, value = n.attr("data-parameter-value");
        if (value === undefined) fail("SCHEMA_CHANGED", "A specification has no value.");
        const group = text(n.closest(".groupx").find("h3").first().text()) || null;
        specs.set(`${group}:${key}`, { group, name: key, value });
      }
      if (!specs.size && Array.isArray(ld.additionalProperty)) for (const raw of ld.additionalProperty) {
        const p = object(raw); if (typeof p.name !== "string" || typeof p.value !== "string") fail("SCHEMA_CHANGED", "A structured specification changed shape.");
        specs.set(p.name, { group: null, name: p.name, value: p.value });
      }
      if (!specs.size && $("#parameters, .js-detail-params").length) fail("SECTION_INCOMPLETE", "The complete specification table was not available.");
      return specs.size ? available([...specs.values()]) : absent;
    },
    variants: () => {
      const snapshot = $('#alza-mcp-variant-options').text();
      if (snapshot) return available({ groups: JSON.parse(snapshot), note: "Option labels and price differences are as shown by Alza; select another product ID through search for its full detail." });
      const variants = new Map<number, { id: number; name: string; url: string }>();
      for (const el of $('.detailVariants a[href], [data-alza-variant-snapshot] a[href]').toArray()) {
        const n = $(el), href = n.attr("href")!; let variantId: number | null;
        try { variantId = productId(alzaUrl(href)); } catch { continue; }
        if (!variantId) continue;
        variants.set(variantId, { id: variantId, name: text(n.text()) || n.attr("title") || n.find("img").attr("alt") || "", url: alzaUrl(href) });
      }
      if ($(".detailVariants").length && !variants.size) fail("SECTION_INCOMPLETE", "Variant options were present but could not be fully read.");
      return variants.size ? available([...variants.values()]) : absent;
    },
    media: () => {
      const media: unknown[] = Array.isArray(ld.image) ? [...ld.image] : ld.image ? [ld.image] : [];
      for (const el of $("#descAnnotation video, #descAnnotation iframe, .detailGallery video, .detailGallery iframe").toArray()) { const n = $(el); media.push({ url: n.attr("src") || n.find("source").attr("src"), title: n.attr("title") ?? null, type: el.tagName }); }
      return media.length ? available(media) : absent;
    },
    documents: () => {
      const links = new Map<string, { url: string; title: string }>();
      for (const el of $('a[href]').toArray()) {
        const n = $(el), href = n.attr("href")!;
        if (!/\.(pdf|docx?|xlsx?|zip)(?:[?#]|$)/i.test(href)) continue;
        const target = new URL(href, url); if (target.protocol !== "https:") continue;
        links.set(target.href, { url: target.href, title: text(n.text()) || n.attr("title") || "" });
      }
      return links.size ? available([...links.values()]) : absent;
    },
    offers: () => {
      const currency = string(baseOffer.priceCurrency) || "CZK", prices: Offer[] = [];
      const main = $('.js-price-detail__main-price-box-wrapper').first();
      const display = text(main.find('.js-price-box__primary-price__value, [data-slot="pb-price"]').first().text()) || null;
      const amount = money(baseOffer.price) ?? (display ? money(display) : null);
      if (amount) prices.push({ ...offer(amount, display, signedIn ? "effective" : "public"), currency, vat: "included" });
      else if (main.length || Object.keys(baseOffer).length) fail("SCHEMA_CHANGED", "The effective product price could not be parsed.");
      const withoutVat = text(main.find('.js-secondary-price').text());
      if (withoutVat) { const parsed = money(withoutVat.replace(/bez DPH/i, "")); if (!parsed) fail("PARSE_ERROR", "The price without VAT could not be parsed."); prices.push({ ...offer(parsed, withoutVat, signedIn ? "effective" : "public"), currency, vat: "excluded" }); }
      for (const el of $('.js-price-detail__alternative-price-box-wrapper').toArray()) {
        const n = $(el), display = text(n.find('[data-slot="pb-price"], .ads-pb__price-value').first().text()), amount = money(display);
        if (!amount && text(n.text())) fail("PARSE_ERROR", "An advertised conditional offer could not be parsed.");
        if (amount) prices.push({ ...offer(amount, display, "conditional"), currency, conditions: [text(n.text())], eligibility: "conditional", vat: "included" });
      }
      return prices.length ? available(prices) : absent;
    },
    attributes: () => {
      const { review, offers, additionalProperty, image, description, aggregateRating, ...attributes } = ld;
      return available({ ...attributes, archive: detail.isArchiveCommodity === true, minimum_pieces: detail.minimumPcs ?? null, maximum_pieces: detail.maximumPcs ?? null, pieces_in_pack: detail.amountInPack ?? null, warranty: text($('#detailWarranty, .warranty').first().text()) || null });
    },
    ratings: () => ld.aggregateRating ? available(ld.aggregateRating) : absent,
  };
  for (const section of requested) {
    try { result.sections[section] = parsers[section](); }
    catch (error) { result.sections[section] = { state: "failed", error: failureOf(error, section) }; }
  }
  return result;
}
