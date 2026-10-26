import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Research } from '../src/domain/research.js';
import { configFromEnv } from '../src/infra/config.js';
import { Cursors } from '../src/infra/cursor.js';
import { SessionBrowser } from '../src/infra/session-browser.js';
import { StateStore } from '../src/infra/state.js';
import type { Access } from '../src/infra/reader.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// TODO: Mock storefront transport; real Chromium runs the lazy section interactions.
const html = `<script>var _pageData={"isUserLogged":false,"data":{"cid":42,"hasVariants":false}};</script>
<script type="application/ld+json">{"@type":"Product","name":"Disk","offers":{"price":100,"priceCurrency":"CZK"}}</script>
<div data-api-url="https://webapi.alza.cz/api/catalog/v2/commodities/42?ucik=test-user&pgrik=test-page"></div>
<div class="js-price-detail__main-price-box-wrapper"><span class="js-price-box__primary-price__value">100,-</span></div>
<a id="hlTabParameters" href="#parameters" onclick="document.querySelector('#parameters').innerHTML='<div class=allpar><div class=groupx><h3>Size</h3><span class=param data-parameter-name=Capacity data-parameter-value=1TB></span></div></div>'">Parameters</a>
<a href="#description" onclick="document.querySelector('#descAnnotation').innerHTML='<p>Full description</p><img src=https://www.alza.cz/image.png><a href=https://www.alza.cz/manual.pdf>Manual</a>'">Description</a>
<div id="parameters"></div><div id="descAnnotation"></div>
<button data-testid="detailVariantSelectComponentOpenOptionsButton" onclick="document.body.dataset.variantsOpened='true';document.querySelector('#variantOptions').innerHTML='<div role=listbox><div role=option aria-selected=true>Black</div></div>'">Colour</button><div id="variantOptions"></div>`;

async function harness(pageHtml = html) {
  const directory = await mkdtemp(join(tmpdir(), 'alza-product-hydration-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = configFromEnv({ ALZA_DATA_DIR: directory, ALZA_HEADLESS: 'true' });
  const browser = new SessionBrowser(config, new StateStore(directory));
  cleanup.push(() => browser.close());
  const context = await browser.start('anonymous');
  let productNavigations = 0;
  const captures: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/reviewStats')) return route.fulfill({ json: { self: { href: 'https://webapi.alza.cz/api/catalog/v2/commodities/42/reviewStats' }, ratingAverage: null, ratingCount: 0, reviewCount: 0, reviewCountTooltip: 'Written reviews including foreign reviews', ratings: [], complaint: null } });
    if (url.pathname.includes('-d42.htm')) productNavigations++;
    await route.fulfill({ contentType: 'text/html', body: pageHtml });
  });
  const access: Access = {
    run: async (op, work) => {
      const resource = await browser.reader(op, 'anonymous', Date.now() + 20_000);
      const page = resource.reader.page.bind(resource.reader);
      resource.reader.page = async (...args) => { const document = await page(...args); captures.push(document.html); return document; };
      try { return await work(resource.reader); } finally { await resource.dispose(); }
    },
    status: () => ({}), close: () => browser.close(),
  };
  return { research: new Research(config, access, new Cursors('x'.repeat(64))), productNavigations: () => productNavigations, captures };
}

it('reads offers without loading lazy sections, then still returns complete default sections', async () => {
  const h = await harness();
  const narrow = await h.research.call('get_product', { product_id: 42, sections: ['offers'] });
  expect(narrow).toMatchObject({ status: 'ok', data: { sections: { offers: { state: 'available', data: [{ amount: '100.00' }] } } } });
  expect('data' in narrow && (narrow.data as { sections: object }).sections).toEqual({ offers: expect.any(Object) });
  expect(h.captures.at(-1)).toContain('<div id="parameters"></div><div id="descAnnotation"></div>');
  expect(h.captures.at(-1)).not.toContain('data-variants-opened');
  const full = await h.research.call('get_product', { product_id: 42 });
  expect(full).toMatchObject({ status: 'ok', data: { sections: { description: { state: 'available', data: { full_text: expect.stringContaining('Full description') } }, specifications: { state: 'available', data: [{ name: 'Capacity', value: '1TB' }] }, variants: { state: 'available', data: { groups: [{ label: 'Colour', options: [{ label: 'Black', selected: true }] }] } }, media: { state: 'available' }, documents: { state: 'available' } } } });
  expect(h.productNavigations()).toBe(2);
  expect(await h.research.call('get_product', { product_id: 42, sections: ['offers'] })).toMatchObject({ status: 'ok', meta: { cache: { hit: true } }, data: { sections: { offers: { state: 'available' } } } });
  expect(h.productNavigations()).toBe(2);
}, 30_000);

it('shares hydrated documents across reordered and duplicate section requests', async () => {
  const h = await harness();
  expect(await h.research.call('get_product', { product_id: 42, sections: ['description', 'specifications', 'description'] })).toMatchObject({ status: 'ok' });
  expect(await h.research.call('get_product', { product_id: 42, sections: ['specifications', 'description'] })).toMatchObject({ status: 'ok', meta: { cache: { hit: true } }, data: { sections: { description: { state: 'available' }, specifications: { state: 'available' } } } });
  expect(h.productNavigations()).toBe(1);
}, 30_000);

it.each(['media', 'documents'] as const)('loads the description dependency when only %s is requested', async section => {
  const h = await harness();
  const result = await h.research.call('get_product', { product_id: 42, sections: [section] });
  if (section === 'media') expect(h.captures.at(-1)).toContain('<div id="parameters"></div>');
  expect(h.captures.at(-1)).not.toContain('data-variants-opened');
  expect(result).toMatchObject({ status: 'ok', data: { sections: { [section]: { state: 'available', data: [expect.objectContaining({ url: section === 'media' ? 'https://www.alza.cz/image.png' : 'https://www.alza.cz/manual.pdf' })] } } } });
}, 30_000);

it('hydrates variant choices without loading specifications or description', async () => {
  const h = await harness();
  expect(await h.research.call('get_product', { product_id: 42, sections: ['variants'] })).toMatchObject({ status: 'ok', data: { sections: { variants: { state: 'available', data: { groups: [{ label: 'Colour', options: [{ label: 'Black', selected: true }] }] } } } } });
  expect(h.captures.at(-1)).toContain('<div id="parameters"></div><div id="descAnnotation"></div>');
}, 30_000);

it('retains specifications that load only inside the description tab', async () => {
  const legacy = html.replace('<span class=param data-parameter-name=Capacity data-parameter-value=1TB></span>', '<span class=param></span>')
    .replace('<p>Full description</p>', '<p>Full description</p><div id=descriptionContent><div class=allpar><div class=groupx><span data-parameter-name=Capacity data-parameter-value=2TB></span></div></div></div>');
  const h = await harness(legacy);
  expect(await h.research.call('get_product', { product_id: 42, sections: ['specifications'] })).toMatchObject({ status: 'ok', data: { sections: { specifications: { state: 'available', data: [{ name: 'Capacity', value: '2TB' }] } } } });
  expect(h.captures.at(-1)).not.toContain('data-variants-opened');
}, 30_000);

it('retains downloads loaded by the parameters tab in a documents-only request', async () => {
  const downloads = html.replace('<span class=param data-parameter-name=Capacity data-parameter-value=1TB></span>', '<span class=param data-parameter-name=Capacity data-parameter-value=1TB></span><a href=https://www.alza.cz/specifications.pdf>Specifications</a>');
  const h = await harness(downloads);
  expect(await h.research.call('get_product', { product_id: 42, sections: ['documents'] })).toMatchObject({ status: 'ok', data: { sections: { documents: { state: 'available', data: expect.arrayContaining([{ url: 'https://www.alza.cz/specifications.pdf', title: 'Specifications' }, { url: 'https://www.alza.cz/manual.pdf', title: 'Manual' }]) } } } });
  expect(h.captures.at(-1)).not.toContain('data-variants-opened');
}, 30_000);

it('hydrates tabs and variant controls inside closed shadow roots', async () => {
  const h = await harness(html + `<script>
    for (const selector of ['#hlTabParameters', 'a[href="#description"]', '[data-testid="detailVariantSelectComponentOpenOptionsButton"]']) {
      const host = document.createElement('div'); document.body.append(host);
      host.attachShadow({mode:'closed'}).append(document.querySelector(selector));
    }
  </script>`);
  expect(await h.research.call('get_product', { product_id: 42 })).toMatchObject({ status: 'ok', data: { sections: {
    description: { state: 'available', data: { full_text: expect.stringContaining('Full description') } },
    specifications: { state: 'available', data: [{ name: 'Capacity', value: '1TB' }] },
    variants: { state: 'available', data: { groups: [{ label: 'Colour', options: [{ label: 'Black', selected: true }] }] } },
  } } });
}, 30_000);

it('loads sections whose handlers require trusted browser clicks', async () => {
  const h = await harness(html.replaceAll('onclick="document.querySelector', 'onclick="if(!event.isTrusted)return;document.querySelector'));
  expect(await h.research.call('get_product', { product_id: 42, sections: ['description', 'specifications'] })).toMatchObject({ status: 'ok', data: { sections: {
    description: { state: 'available', data: { full_text: expect.stringContaining('Full description') } },
    specifications: { state: 'available', data: [{ name: 'Capacity', value: '1TB' }] },
  } } });
}, 30_000);

it('rechecks identity from the final document when hydration changes the account state', async () => {
  const h = await harness(html + `<script>
    document.querySelector('#hlTabParameters').addEventListener('click', () => {
      document.scripts[0].textContent = 'var _pageData = ' + JSON.stringify({isUserLogged:true,userId:'999',data:{cid:42}}) + ';';
    });
  </script>`);
  expect(await h.research.call('get_product', { product_id: 42, sections: ['specifications'] })).toMatchObject({ status: 'error', error: { code: 'AUTH_ACCOUNT_MISMATCH' } });
}, 30_000);

// TODO: Mock a storefront that re-renders controls and adds another group after closing a menu.
const changingVariants = html + `<script>
  const original = document.querySelector('[data-testid="detailVariantSelectComponentOpenOptionsButton"]');
  const controls = document.createElement('div'); controls.className = 'detailVariants'; original.replaceWith(controls);
  function addGroup(label, value) {
    const button = original.cloneNode(true); button.textContent = label;
    button.onclick = () => {
      document.querySelector('#variantOptions').innerHTML = '<div role="listbox"><div role="option" aria-selected="true">' + value + '</div></div>';
      const replacement = button.cloneNode(true); replacement.onclick = button.onclick; button.replaceWith(replacement);
    };
    controls.append(button);
  }
  addGroup('Colour', 'Black'); addGroup('Capacity', '1TB');
  let closed = 0;
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelector('#variantOptions').replaceChildren();
    if (++closed === 2) addGroup('Pack', 'Two');
  });
</script>`;

it('retains every variant group when controls re-render and a later group appears', async () => {
  const h = await harness(changingVariants);
  expect(await h.research.call('get_product', { product_id: 42, sections: ['variants'] })).toMatchObject({ status: 'ok', data: { sections: { variants: { state: 'available', data: { groups: [
    { label: 'Colour', options: [{ label: 'Black', selected: true }] },
    { label: 'Capacity', options: [{ label: '1TB', selected: true }] },
    { label: 'Pack', options: [{ label: 'Two', selected: true }] },
  ] } } } } });
}, 30_000);

it('reports incomplete variants when the inspected group labels change during hydration', async () => {
  const h = await harness(changingVariants.replace("if (++closed === 2) addGroup('Pack', 'Two');", "if (++closed === 2) { controls.firstElementChild.textContent = 'Material'; controls.insertAdjacentHTML('beforeend', '<a href=/product-d43.htm>Another product</a>'); }"));
  expect(await h.research.call('get_product', { product_id: 42, sections: ['variants'] })).toMatchObject({ status: 'partial', data: { sections: { variants: { state: 'failed' } } }, errors: [{ code: 'SECTION_INCOMPLETE' }] });
  expect(h.captures.at(-1)).not.toContain('alza-mcp-variant-options');
}, 30_000);
