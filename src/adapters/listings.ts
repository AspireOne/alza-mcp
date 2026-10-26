import { type CheerioAPI } from "cheerio";
import type { Listing, Offer } from "../domain/contracts.js";
import { fail } from "../infra/failure.js";
import { alzaUrl, productId } from "../infra/urls.js";
import { htmlDocument, text, type HtmlSource } from "./html.js";

export function money(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s\u00a0\u202f]/g, "");
  const match = normalized.match(/^(\d+)(?:[,.](\d+|-))?(?:Kč|CZK)?$/);
  return match ? `${match[1]}.${(match[2] === "-" ? "00" : match[2] ?? "00").padEnd(2, "0")}` : null;
}
// Alza's condition labels for opened, used and like-new items; new items carry none.
export const CONDITION_PATTERN = /Rozbaleno|Použité|Zánovní/i;
export function offer(amount: string, display: string | null, kind: Offer["kind"] = "effective", conditions: string[] = []): Offer {
  return { amount, display, kind, currency: "CZK", vat: "included", eligibility: kind === "conditional" ? "conditional" : "eligible", conditions };
}
export function membershipReference(display: string): Offer | null {
  if (!/^Bez členství\s*:/i.test(display)) return null;
  const amount = money(display.replace(/^Bez členství\s*:\s*/i, ''));
  if (!amount) fail('PARSE_ERROR', 'The displayed price without membership could not be parsed.');
  return { ...offer(amount, display, 'reference', ['Bez členství']), eligibility: 'unknown' };
}
export function couponFromTitle(title: string): Offer["promotion"] | undefined {
  const match = /(?:s kódem|s kup[oó]nem)(?:\s+(\S+))?/i.exec(title);
  return match ? { type: "coupon", code: match[1] ?? null } : undefined;
}

/** Read advertised totals, which can already include account benefits. Never reapply a discount. */
export function promotionalOffers($: CheerioAPI, scope: ReturnType<CheerioAPI>, currency = "CZK", appliedConditions: string[] = []): Offer[] {
  const result: Offer[] = [], seen = new Set<string>();
  for (const el of scope.find('.promo-action-prices__row, .coupon-block').toArray()) {
    const node = $(el), card = node.hasClass('coupon-block');
    const type = node.attr('data-type');
    const cashback = type === 'cashback' || node.hasClass('coupon-block--cashback');
    const display = text(node.find(card ? '.coupon-block__price' : '.promo-action-prices__price').first().text());
    const amount = money(display);
    if (!amount) fail('PARSE_ERROR', 'An advertised promotional price could not be parsed.');
    const label = text(node.find(card ? '.coupon-block__label--link' : '.promo-action-prices__name').first().text());
    const displayedCode = text(node.find(card ? '.coupon-block__label--code' : '.promo-action-prices__discount-code').first().text());
    const attributeCode = text(node.attr('data-coupon-code') ?? '');
    if (displayedCode && attributeCode && displayedCode !== attributeCode) fail('SCHEMA_CHANGED', 'The advertised coupon code disagrees with its data attribute.');
    const code = attributeCode || displayedCode || null;
    const coupon = type === 'discountcode' || node.hasClass('promo-action-prices__row--type-discountcode') || node.hasClass('coupon-block--discountcode') || !!code && !cashback;
    const description = text(node.find(card ? '.js-coupon-description' : '.js-promo-action-prices__description').text());
    const conditions = [[label, code].filter(Boolean).join(' '), description, ...appliedConditions].filter(Boolean);
    const promotion: NonNullable<Offer['promotion']> = coupon ? { type: 'coupon', code } : { type: cashback ? 'cashback' : 'other' };
    const price: Offer = { ...offer(amount, display, 'conditional', conditions), currency, promotion };
    const key = JSON.stringify(price);
    if (!seen.has(key)) result.push(price);
    seen.add(key);
  }
  return result;
}
export function listings(html: HtmlSource, signedIn = false): Listing[] {
  const $ = htmlDocument(html), result: Listing[] = [], seen = new Set<number>();
  for (const node of $(".browsingitem").toArray()) {
    const card = $(node), id = Number(card.attr("data-id")), link = card.find("a.name").first();
    if (!Number.isSafeInteger(id) || id <= 0 || !text(link.text()) || !link.attr("href")) fail("PARSE_ERROR", "An Alza listing is missing its identity or name.");
    if (seen.has(id)) continue;
    const url = alzaUrl(link.attr("href")!);
    if (productId(url) !== id) fail("PRODUCT_ID_MISMATCH", "A listing URL disagrees with its product ID.");
    const displayed = text(card.find(".price .js-price-box__primary-price__value, .price .ads-pb__price-value").first().text());
    const amount = money(displayed);
    const priceTitle = text(card.find(".price .ads-pb__header").first().text());
    const comparison = membershipReference(text(card.find('.price .ads-pb__original-price').first().text()));
    const membershipApplied = signedIn && !!comparison && !!card.find('.price .ads-pb--alza-plus').length;
    const benefitApplied = signedIn && !!card.find('.price .ads-pb--benefit').length;
    const appliedConditions = (membershipApplied || benefitApplied) && priceTitle ? [priceTitle] : [];
    const promotion = couponFromTitle(priceTitle);
    const conditional = !!promotion || /s alzaplus/i.test(priceTitle) && !membershipApplied;
    const offers: Offer[] = amount ? [{ ...offer(amount, displayed, conditional ? "conditional" : "effective", conditional ? [priceTitle] : appliedConditions), ...(promotion ? { promotion } : {}) }] : [];
    if (comparison) offers.push(comparison);
    offers.push(...promotionalOffers($, card, 'CZK', appliedConditions));
    if (!amount && card.find(".price").length && card.find(".price").text().trim()) fail("PARSE_ERROR", "The price of an Alza listing could not be parsed.");
    const ratingRaw = text(card.find(".star-rating-block__value").text());
    const countRaw = text(card.find(".star-rating-block__count").text()).replace(/[^\d]/g, "");
    result.push({ id, code: card.attr("data-code") ?? null, name: text(link.text()), url, image: card.find("img").first().attr("src") ?? null,
      description: text(card.find(".descr, .description, .Description").first().text()) || null,
      condition: text(card.find(".wear, .commodity-wear").first().text()) || (CONDITION_PATTERN.exec(card.text())?.[0] ?? null),
      availability: text(card.find(".avail, .availability, .avlVal").first().text()) || null,
      offers, rating: ratingRaw ? Number(ratingRaw.replace(",", ".")) : null, rating_count: countRaw ? Number(countRaw) : null,
      sponsored: !!card.find(".box-recommendation, [data-sponsored]").length || /Sponzorováno/.test(card.text()),
    });
    seen.add(id);
  }
  return result;
}
