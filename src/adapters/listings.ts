import { load } from "cheerio";
import type { Listing, Offer } from "../domain/contracts.js";
import { fail } from "../infra/failure.js";
import { alzaUrl, productId } from "../infra/urls.js";
import { text } from "./html.js";

export function money(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value.toFixed(2) : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s\u00a0\u202f]/g, "");
  const match = normalized.match(/^(\d+)(?:[,.](\d{1,2}|-))?(?:Kč|CZK)?$/);
  return match ? `${match[1]}.${(match[2] === "-" ? "00" : match[2] ?? "00").padEnd(2, "0")}` : null;
}
export function offer(amount: string, display: string | null, kind: Offer["kind"] = "effective", conditions: string[] = []): Offer {
  return { amount, display, kind, currency: "CZK", vat: "included", eligibility: kind === "conditional" ? "conditional" : "eligible", conditions };
}
export function listings(html: string): Listing[] {
  const $ = load(html), result: Listing[] = [], seen = new Set<number>();
  for (const node of $(".browsingitem").toArray()) {
    const card = $(node), id = Number(card.attr("data-id")), link = card.find("a.name").first();
    if (!Number.isSafeInteger(id) || id <= 0 || !text(link.text()) || !link.attr("href")) fail("PARSE_ERROR", "An Alza listing is missing its identity or name.");
    if (seen.has(id)) continue;
    const url = alzaUrl(link.attr("href")!);
    if (productId(url) !== id) fail("PRODUCT_IDENTITY_MISMATCH", "A listing URL disagrees with its product ID.");
    const displayed = text(card.find(".price .js-price-box__primary-price__value, .price .ads-pb__price-value").first().text());
    const amount = money(displayed);
    const priceTitle = text(card.find(".price .ads-pb__header").first().text());
    const conditional = /(?:s alzaplus|s kódem|s kuponem)/i.test(priceTitle);
    const offers = amount ? [offer(amount, displayed, conditional ? "conditional" : "effective", conditional ? [priceTitle] : [])] : [];
    if (!amount && card.find(".price").length && card.find(".price").text().trim()) fail("PARSE_ERROR", "The price of an Alza listing could not be parsed.");
    const ratingRaw = text(card.find(".star-rating-block__value").text());
    const countRaw = text(card.find(".star-rating-block__count").text()).replace(/[^\d]/g, "");
    result.push({ id, code: card.attr("data-code") ?? null, name: text(link.text()), url, image: card.find("img").first().attr("src") ?? null,
      description: text(card.find(".descr, .description, .Description").first().text()) || null,
      condition: text(card.find(".wear, .commodity-wear").first().text()) || (/Rozbaleno|Použité/i.exec(card.text())?.[0] ?? null),
      availability: text(card.find(".avail, .availability, .avlVal").first().text()) || null,
      offers, rating: ratingRaw ? Number(ratingRaw.replace(",", ".")) : null, rating_count: countRaw ? Number(countRaw) : null,
      sponsored: !!card.find(".box-recommendation, [data-sponsored]").length || /Sponzorováno/.test(card.text()),
    });
    seen.add(id);
  }
  return result;
}
