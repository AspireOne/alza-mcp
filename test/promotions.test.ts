import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { listings } from '../src/adapters/listings.js';
import { parseProduct } from '../src/adapters/product.js';
import { parseFilter, parseRenderedSearch } from '../src/adapters/catalog.js';
import type { Offer } from '../src/domain/contracts.js';
import { Research } from '../src/domain/research.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import type { Access, Reader } from '../src/infra/reader.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const couponDetail = fixture('coupon-detail'), anonymousDetail = fixture('anonymous-coupon-detail');
const benefitDetail = fixture('benefit-detail'), searchCards = fixture('coupon-search');
const url = (id: number) => `https://www.alza.cz/product-d${id}.htm`;
function offers(html: string, id = 12662568, signedIn = true): Offer[] {
  const section = parseProduct(html, url(id), id, signedIn, ['offers']).sections.offers;
  expect(section?.state).toBe('available');
  return section?.state === 'available' ? section.data as Offer[] : [];
}

describe('advertised coupon prices', () => {
  it.each([
    { name: 'signed-in rendered detail', html: couponDetail, signedIn: true, kind: 'effective' },
    { name: 'anonymous server HTML', html: anonymousDetail, signedIn: false, kind: 'public' },
  ])('returns the coupon alongside the regular price from $name', ({ html, signedIn, kind }) => {
    const prices = offers(html, 12662568, signedIn);
    expect(prices[0]).toMatchObject({ amount: '289.00', kind, vat: 'included' });
    expect(prices[1]).toMatchObject({ amount: '258.00', vat: 'excluded' });
    expect(prices[2]).toMatchObject({ amount: '246.00', display: '246,-', currency: 'CZK', vat: 'included', kind: 'conditional', eligibility: 'conditional', promotion: { type: 'coupon', code: 'ALZADNY15' } });
    expect(prices[2]?.conditions).toContain('Koupit s kódem ALZADNY15');
    expect(prices[2]?.conditions.join(' ')).toContain('při vložení kódu v nákupním košíku');
    expect(prices.filter(p => p.promotion)).toHaveLength(1);
  });

  it('reads coupons from filter API boxes and rendered recovery pages without contaminating other products', () => {
    const api = parseFilter({ d: { Boxes: searchCards, Count: 4, Page: 1, PagerBottom: '' } }, 1, true);
    const rendered = parseRenderedSearch('<script>var _pageData={"isUserLogged":true,"data":{}};</script>' + searchCards, 1, {}, true);
    expect(rendered.products).toEqual(api.products);
    expect(api.products[0]?.offers).toMatchObject([
      { amount: '289.00', kind: 'effective' },
      { amount: '246.00', kind: 'conditional', promotion: { type: 'coupon', code: 'ALZADNY15' } },
    ]);
    expect(api.products[1]?.id).toBe(7191519);
    expect(api.products[1]?.offers).toMatchObject([{ amount: '159.00' }]);
    expect(api.products.slice(1).flatMap(p => p.offers).every(p => !p.promotion)).toBe(true);
  });

  it('preserves the combined company-benefit/coupon total and separates cashback and reference prices', () => {
    const detail = offers(benefitDetail, 13458454);
    const listing = parseFilter({ d: { Boxes: fixture('benefit-search'), Count: 1, Page: 1, PagerBottom: '' } }, 1, true).products[0]!;
    expect(detail[0]).toMatchObject({ amount: '12763.75', display: '12 764,-', conditions: ['Benefit Sleva -20 %'] });
    expect(listing.offers[0]).toMatchObject({ amount: '12764.00', conditions: ['Benefit Sleva -20 %'] });
    for (const prices of [detail, listing.offers]) {
      const coupon = prices.find(p => p.promotion?.type === 'coupon');
      expect(coupon).toMatchObject({ amount: '10849.00', kind: 'conditional', promotion: { code: 'ALZADNY15' } });
      expect(coupon?.conditions).toContain('Benefit Sleva -20 %');
    }
    expect(detail.find(p => p.promotion?.type === 'cashback')).toMatchObject({ amount: '9849.00', kind: 'conditional' });
    expect(detail.find(p => p.promotion?.type === 'cashback')?.conditions.join(' ')).toContain('obecně vyžaduje registraci');
    expect(detail.find(p => p.kind === 'reference')).toMatchObject({ amount: '15990.00', eligibility: 'unknown' });
  });

  it('does not infer a coupon from SalePrice structured data or recommended products', () => {
    const html = fixture('no-coupon-detail') + searchCards;
    expect(offers(html, 7191519)).toMatchObject([{ amount: '159.00', kind: 'effective' }, { amount: '142.00', vat: 'excluded' }]);
    expect(offers(html, 7191519).every(p => !p.promotion)).toBe(true);
  });

  it('retains distinct simultaneous coupons and their terms while deduplicating identical rendered rows', () => {
    const $ = load(couponDetail), original = $('.promo-action-prices__row').first();
    const second = original.clone();
    second.find('.promo-action-prices__discount-code').text('SAVE-250');
    second.find('.promo-action-prices__price').text('239,-');
    second.find('.js-promo-action-prices__description').text('Pouze pro členy. Minimální nákup 2 ks. Platí do 31. 10. 2026.');
    original.parent().append(original.clone(), second);
    const coupons = offers($.html()).filter(p => p.promotion?.type === 'coupon');
    expect(coupons).toHaveLength(2);
    expect(coupons[0]).toMatchObject({ amount: '246.00', promotion: { code: 'ALZADNY15' } });
    expect(coupons[1]).toMatchObject({ amount: '239.00', promotion: { code: 'SAVE-250' } });
    expect(coupons[1]?.conditions).toContain('Pouze pro členy. Minimální nákup 2 ks. Platí do 31. 10. 2026.');
  });

  it('returns an observed price with unknown code when the code element is missing', () => {
    const $ = load(couponDetail);
    $('.promo-action-prices__discount-code').remove();
    expect(offers($.html()).find(p => p.promotion)).toMatchObject({ amount: '246.00', promotion: { type: 'coupon', code: null } });
  });

  it.each(['attribute', 'visible code'])('reads a listing code when only its %s is available', source => {
    const $ = load(searchCards), card = $('.browsingitem').first();
    if (source === 'attribute') card.find('.coupon-block__label--code').remove();
    else card.find('.coupon-block').removeAttr('data-coupon-code');
    expect(listings($.html())[0]?.offers.find(p => p.promotion)).toMatchObject({ amount: '246.00', promotion: { code: 'ALZADNY15' } });
  });

  it('fails explicitly on conflicting listing codes instead of advertising the wrong code', () => {
    const $ = load(searchCards);
    $('.coupon-block').first().attr('data-coupon-code', 'OTHER');
    expect(() => listings($.html())).toThrow(/coupon code disagrees/);
  });

  it.each(['', 'Sleva 15 %'])('fails the offers section on an unreadable promotional price (%j) without losing other sections', price => {
    const $ = load(couponDetail);
    $('.promo-action-prices__price').text(price);
    const product = parseProduct($.html(), url(12662568), 12662568, true, ['offers', 'ratings']);
    expect(product.sections.offers).toMatchObject({ state: 'failed', error: { code: 'PARSE_ERROR' } });
    expect(product.sections.ratings).toEqual({ state: 'not_provided' });
  });

  it('fails a malformed listing promotion instead of silently dropping it', () => {
    const $ = load(searchCards);
    $('.coupon-block__price').first().text('Sleva 15 %');
    expect(() => listings($.html())).toThrow(/promotional price/);
  });

  it('keeps an unrecognized promotion conditional and does not invent a coupon code', () => {
    const $ = load(couponDetail);
    $('.promo-action-prices__row').attr('data-type', 'special-event').removeClass('promo-action-prices__row--type-discountcode');
    $('.promo-action-prices__discount-code').remove();
    $('.promo-action-prices__name').text('Cena při nákupu 2 ks');
    expect(offers($.html()).find(p => p.promotion)).toMatchObject({ amount: '246.00', kind: 'conditional', promotion: { type: 'other' } });
  });

  it('adds coupon metadata to the existing price-box presentation', () => {
    const html = '<div class="browsingitem" data-id="42"><a class="name" href="/item-d42.htm">Item</a><div class="price"><span class="ads-pb__header">S kódem SALE-20</span><span class="js-price-box__primary-price__value">80,-</span></div></div>';
    expect(listings(html)[0]?.offers).toMatchObject([{ amount: '80.00', kind: 'conditional', promotion: { type: 'coupon', code: 'SALE-20' } }]);
  });
});

describe('promotion research responses', () => {
  function research(cards = searchCards) {
    const config = configFromEnv({});
    const reader: Reader = { provider: 'browser', context: 'account:test', canPost: true,
      page: async (target, options) => ({ url: target, html: options?.detail ? couponDetail : '<script>var _pageData={"isUserLogged":true,"categoryId":18862691,"data":{"categoryTypeId":1,"searchTerm":"magnesium"}};</script><a data-sort="0"></a>', status: 200, headers: {} }),
      json: async () => ({ d: { Boxes: cards, Count: 4, Page: 1, PagerBottom: '' } }),
    };
    const access: Access = { run: async (op, work) => { op.meta.auth.state = 'signed_in'; return work(reader); }, status: () => ({}), close: async () => {} };
    return new Research(config, access, new Cursors('x'.repeat(64)));
  }

  it('exposes regular and coupon prices through both tools and cached responses under preferred auth', async () => {
    const service = research();
    for (let call = 0; call < 2; call++) {
      const search = await service.call('search_products', { query: 'magnesium' });
      expect(search).toMatchObject({ status: 'ok', data: { products: expect.arrayContaining([expect.objectContaining({ offers: [expect.objectContaining({ amount: '289.00' }), expect.objectContaining({ amount: '246.00', promotion: { type: 'coupon', code: 'ALZADNY15' }, vat: 'unknown' })] })]) }, meta: { auth: { requested: 'preferred', state: 'signed_in' }, cache: { hit: call === 1 } } });
      const detail = await service.call('get_product', { product_id: 12662568, sections: ['offers'] });
      expect(detail).toMatchObject({ status: 'ok', data: { sections: { offers: { state: 'available', data: [{ amount: '289.00' }, { amount: '258.00' }, { amount: '246.00', promotion: { type: 'coupon', code: 'ALZADNY15' }, vat: 'included' }] } } }, meta: { auth: { requested: 'preferred' }, cache: { hit: call === 1 } } });
    }
  });

  it('returns a detail-only coupon when the listing does not advertise it', async () => {
    const $ = load(searchCards);
    $('.coupon-block').remove();
    const service = research($.html());
    const search = await service.call('search_products', { query: 'magnesium' });
    expect(search.status).toBe('ok');
    if (search.status !== 'error') expect(JSON.stringify(search.data)).not.toContain('ALZADNY15');
    expect(await service.call('get_product', { product_id: 12662568, sections: ['offers'] })).toMatchObject({ status: 'ok', data: { sections: { offers: { data: expect.arrayContaining([expect.objectContaining({ amount: '246.00', promotion: { type: 'coupon', code: 'ALZADNY15' } })]) } } } });
  });
});
