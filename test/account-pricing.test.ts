import { expect, it } from 'vitest';
import { listings, money } from '../src/adapters/listings.js';
import { parseProduct } from '../src/adapters/product.js';

// Sanitized shapes observed in signed-in Brave: the membership price is already
// applied, and the other amount is the same account's price without membership.
const card = '<div class="browsingitem" data-id="12611062"><a class="name" href="/ssd-d12611062.htm">SSD</a><div class="price"><span class="ads-pb--alza-plus"><span class="ads-pb__header">-10 % s AlzaPlus+</span><span class="js-price-box__primary-price__value">7 199,-</span><span class="ads-pb__original-price">Bez členství: 7 999,-</span></span></div></div>';

it('recognizes an applied membership price only with verified auth and applied-offer markup', () => {
  expect(listings(card, true)[0]?.offers).toMatchObject([
    { amount: '7199.00', kind: 'effective', eligibility: 'eligible', conditions: ['-10 % s AlzaPlus+'] },
    { amount: '7999.00', kind: 'reference', eligibility: 'unknown', conditions: ['Bez členství'] },
  ]);
  expect(listings(card, false)[0]?.offers[0]).toMatchObject({ kind: 'conditional', eligibility: 'conditional' });
  expect(listings(card.replace('ads-pb--alza-plus', 'ads-pb--basic'), true)[0]?.offers[0]).toMatchObject({ kind: 'conditional' });
  expect(listings(card.replace('-10 % s AlzaPlus+', 'S kódem SALE'), true)[0]?.offers[0]).toMatchObject({ kind: 'conditional' });
});

it('preserves sub-cent account prices separately from the displayed rounded amount', () => {
  expect(money(360.591)).toBe('360.591');
  expect(money('360,591 Kč')).toBe('360.591');
  const html = '<script>var _pageData={"isUserLogged":true,"data":{"cid":42}};</script><script type="application/ld+json">{"@type":"Product","name":"Detergent","offers":{"price":360.591,"priceCurrency":"CZK","priceSpecification":[{"price":360.591,"valueAddedTaxIncluded":true}]}}</script><div class="js-price-detail__main-price-box-wrapper"><span class="js-price-box__primary-price__value">361,-</span><span class="js-secondary-price">bez DPH 298,-</span><span class="ads-pb__original-price">Bez členství: 515,-</span></div>';
  expect(parseProduct(html, 'https://www.alza.cz/item-d42.htm', 42, true, ['offers']).sections.offers).toMatchObject({ state: 'available', data: [
    { amount: '360.591', display: '361,-', kind: 'effective', vat: 'included' },
    { amount: '298.00', vat: 'excluded' },
    { amount: '515.00', kind: 'reference', conditions: ['Bez členství'] },
  ] });
});
