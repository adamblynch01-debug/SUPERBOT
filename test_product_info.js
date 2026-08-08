// Round 34 — "/product-info: Dropdown menu with option to choose any product
// and show its product info."
//
// "Any product" is the part under test. The catalogue is 164 products in 44
// categories, a select menu holds 25 options and a message holds five rows, so
// the naive flat dropdown covers 125 of them and says nothing about the rest —
// which is the failure mode this file exists to keep out: a browser that looks
// complete and is not. Everything below is about coverage, about the rows
// staying inside Discord's caps, and about a public panel not being rewritten
// under the feet of everyone reading it when one customer clicks it.
//
//   node test_product_info.js
'use strict';

const assert = require('assert');
const P = require('./modules/productInfo');
// The shop's own symbol, escaped for use inside a regex, rather than a '€'
// typed here. A hand-typed symbol is a second declaration of the currency and
// it goes on passing after the first one changes.
const { SYMBOL } = require('./modules/money');
const SYM = SYMBOL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// A row exactly as GET /api/products serves it: a priced TIER joined onto its
// parent product, so a product with five plans arrives five times.
const row = (o = {}) => ({
  // `in`, not `??`: a null tier id is the case being modelled — a product with
  // no plans — and `??` would hand it the default back.
  id: 'tier_id' in o ? o.tier_id : '400',
  product_id: o.product_id ?? '181',
  tier_label: o.tier_label ?? 'Day',
  tier_period: o.tier_period ?? '24 hours',
  name: `${o.product_name ?? 'H8ED SPOOFER'} (${o.tier_label ?? 'Day'})`,
  product_name: o.product_name ?? 'H8ED SPOOFER',
  subtitle: o.subtitle ?? 'Ranked TPM Protector',
  description: o.description ?? 'HWID Spoofer — Day',
  price: o.price ?? 7.99,
  category: o.category ?? 'HWID Spoofer',
  tag: o.tag ?? 'All Games — Anti-Ban Protection',
  specs: o.specs ?? 'Intel & AMD | Windows 10 & 11',
  platforms: o.platforms ?? ['All Games'],
  spoofer: false,
  sections: o.sections ?? [{ title: 'System Requirements', features: ['Intel & AMD', 'Windows 10 & 11'] }],
  media: o.media ?? {},
  status: o.status ?? 'undetected',
  stock_type: 'auto',
  delivery_type: 'auto',
  half: o.half ?? 'main',
});

main();
async function main() {

  console.log('\nrolling tiers back up into products');

await check('a product that arrives five times is one product with five plans', () => {
  const cat = P.groupCatalog([
    row({ tier_id: '1', tier_label: 'Day', price: 7.99 }),
    row({ tier_id: '2', tier_label: 'Week', price: 19.99 }),
    row({ tier_id: '3', tier_label: 'Month', price: 39.99 }),
  ]);
  assert.strictEqual(cat.products.size, 1);
  const p = cat.products.get('main::181');
  assert.strictEqual(p.tiers.length, 3);
  assert.deepStrictEqual(p.tiers.map(t => t.label), ['Day', 'Week', 'Month']);
});

await check('a product with NO plans is kept, not filtered out', () => {
  // #18 Services / BLUEPRINTS is exactly this today: the API sends one row
  // with a null tier id. Dropping it would answer "no such product" to
  // someone asking about a product the shop lists — and the person who can
  // fix it is the one most likely to ask.
  const cat = P.groupCatalog([row({ tier_id: null, product_id: '18', product_name: 'BLUEPRINTS', category: 'Services' })]);
  const p = cat.products.get('main::18');
  assert.ok(p, 'the product is in the catalogue');
  assert.strictEqual(p.tiers.length, 0);
});

await check('the same category name on both halves stays two categories', () => {
  // "Accounts" exists on the storefront and in the vault and means different
  // things. Merged on the display name, a vault product would be listed under
  // a storefront heading and its buy link would point at the wrong page.
  const cat = P.groupCatalog([
    row({ product_id: '1', category: 'Accounts', half: 'main' }),
    row({ product_id: '2', category: 'Accounts', half: 'vault' }),
  ]);
  assert.strictEqual(cat.categories.length, 2);
  assert.deepStrictEqual(cat.categories.map(c => c.half), ['main', 'vault']);
});

  console.log('\nthe dropdowns, against the caps that reject a message');

await check('44 categories fit, and every one of them is in a row', () => {
  const rows = [];
  for (let i = 0; i < 44; i++) rows.push(row({ product_id: String(i), category: `CAT ${String(i).padStart(2, '0')}` }));
  const cat = P.groupCatalog(rows);
  const menus = P.categoryRows(cat.categories);
  assert.strictEqual(menus.length, 2, 'two rows of 25');
  const opts = menus.flatMap(r => r.toJSON().components[0].options);
  assert.strictEqual(opts.length, 44, 'no category is dropped');
  menus.forEach(r => assert.ok(r.toJSON().components[0].options.length <= 25, '25 options per menu is a hard cap'));
});

await check('the widest category is still one row', () => {
  // Streaming holds 18 vault products, the biggest there is. If a category
  // ever passes 25 the second step would silently lose products, so this is
  // the number that has to be watched, not the total.
  const rows = [];
  for (let i = 0; i < 18; i++) rows.push(row({ product_id: String(i), product_name: `SHOW ${i}`, category: 'Streaming' }));
  const cat = P.groupCatalog(rows);
  const menu = P.productRow(cat.categories[0]).toJSON().components[0];
  assert.strictEqual(menu.options.length, 18);
});

await check('a browse message never asks Discord for a sixth row', () => {
  const rows = [];
  for (let i = 0; i < 120; i++) rows.push(row({ product_id: String(i), category: `CAT ${String(i).padStart(3, '0')}` }));
  const cat = P.groupCatalog(rows);
  const payload = P.browserPayload(cat, {
    category: cat.categories[0],
    product: cat.categories[0].products[0],
    embed: P.buildProductEmbed(cat.categories[0].products[0], {}),
  });
  assert.ok(payload.components.length <= 5, `five rows is the cap, got ${payload.components.length}`);
});

await check('the language dropdown rides along when there is room for it', () => {
  const cat = P.groupCatalog([row()]);
  const ids = P.browserPayload(cat).components.map(r => r.toJSON().components[0].custom_id);
  assert.ok(ids.some(id => id === 'xlate_lang'), 'a post a customer reads can be translated');
});

  console.log('\nthe card');

await check('every plan is priced, and each one says whether it is in stock', () => {
  const cat = P.groupCatalog([
    row({ tier_id: '1', tier_label: 'Day', price: 7.99 }),
    row({ tier_id: '2', tier_label: 'Month', price: 39.99 }),
  ]);
  const lines = P.tierLines(cat.products.get('main::181'), { 1: 12, 2: 0 });
  assert.ok(new RegExp(SYM + '7\\.99').test(lines[0]) && /In stock/.test(lines[0]), lines[0]);
  assert.ok(new RegExp(SYM + '39\\.99').test(lines[1]) && /Sold out/.test(lines[1]), lines[1]);
});

await check('a stock lookup that FAILED is not printed as sold out', () => {
  // tierStock() returns null when /api/stock/bulk is unreachable, and null is
  // not zero. A red SOLD OUT next to a product we are still selling costs a
  // sale and looks authoritative doing it.
  const cat = P.groupCatalog([row({ tier_id: '1' })]);
  const lines = P.tierLines(cat.products.get('main::181'), null);
  assert.ok(!/Sold out|In stock/.test(lines[0]), lines[0]);
  assert.ok(new RegExp(SYM + '7\\.99').test(lines[0]), 'the price still shows');
});

await check('a product with no plans says why it cannot be bought', () => {
  const cat = P.groupCatalog([row({ tier_id: null, product_id: '18', product_name: 'BLUEPRINTS' })]);
  const json = P.buildProductEmbed(cat.products.get('main::18'), {}).toJSON();
  const plans = json.fields.find(f => /Price|Plans/.test(f.name));
  assert.ok(/no plans/i.test(plans.value), plans.value);
});

await check('a card stays inside the 6000 characters Discord will accept', () => {
  // Not a truncation — over the cap the whole message is REJECTED, so an
  // over-decorated product would answer with nothing at all.
  const sections = [];
  for (let i = 0; i < 12; i++) {
    sections.push({ title: `Section ${i}`, features: Array.from({ length: 20 }, (_, j) => `Feature ${i}.${j} `.repeat(6)) });
  }
  const cat = P.groupCatalog([row({ sections })]);
  const json = P.buildProductEmbed(cat.products.get('main::181'), {}).toJSON();
  const size = JSON.stringify(json).length;
  assert.ok(size < 6000, `embed is ${size} characters`);
  assert.ok(json.fields.length <= 25, 'and 25 fields is the other cap');
  const bloated = json.fields.filter(f => f.value.length > 1024);
  assert.strictEqual(bloated.length, 0, 'no single field over 1024 either');
});

await check('what did not fit is said, not silently dropped', () => {
  const feats = Array.from({ length: 60 }, (_, i) => `Feature number ${i} with enough words in it to matter`);
  const packed = P.packLines(feats.map(f => `• ${f}`));
  assert.ok(/and \d+ more/.test(packed), packed.slice(-120));
});

await check('the status shown is the site\'s status, and an unknown one is not called healthy', () => {
  const ok = P.buildProductEmbed(P.groupCatalog([row({ status: 'detected' })]).products.get('main::181'), {}).toJSON();
  assert.ok(/DETECTED/.test(ok.fields.find(f => /Status/.test(f.name)).value));
  const odd = P.buildProductEmbed(P.groupCatalog([row({ status: 'frobnicated' })]).products.get('main::181'), {}).toJSON();
  const v = odd.fields.find(f => /Status/.test(f.name)).value;
  assert.ok(/FROBNICATED/.test(v) && !/UNDETECTED/.test(v), v);
});

await check('the description does not repeat the game back at you', () => {
  // Most rows carry description "<Game> — <Plan>", and the card already has a
  // Game field and a Plans field. Printed as well, it reads like a bug.
  const json = P.buildProductEmbed(P.groupCatalog([row({ description: 'HWID Spoofer — Day' })]).products.get('main::181'), {}).toJSON();
  assert.ok(!/HWID Spoofer — Day/.test(json.description || ''), json.description);
  assert.ok(/Ranked TPM Protector/.test(json.description || ''), 'the subtitle is what it had to say');
});

  console.log('\none customer browsing must not rewrite the panel for everyone');

await check('the private browser is editable in place, the public panel is not', () => {
  // This is the whole reason the handler forks. update() on a channel panel
  // would swap the dropdown under everybody looking at it, mid-scroll.
  assert.strictEqual(P.isEphemeral({ flags: { has: (bit) => bit === 64 } }), true);
  assert.strictEqual(P.isEphemeral({ flags: { has: () => false } }), false);
  assert.strictEqual(P.isEphemeral({ flags: 64 }), true, 'a raw flag int reads the same');
  assert.strictEqual(P.isEphemeral({}), false, 'no flags means a public message');
  assert.strictEqual(P.isEphemeral(null), false);
});

await check('the buy button points at the half the product is actually on', () => {
  const vault = P.groupCatalog([row({ half: 'vault', product_id: '176', product_name: 'SLING TV', category: 'Cable' })]);
  const p = vault.products.get('vault::176');
  const payload = P.browserPayload(vault, { category: vault.categories[0], product: p, embed: P.buildProductEmbed(p, {}) });
  const url = payload.components.flatMap(r => r.toJSON().components).find(c => c.style === 5).url;
  assert.ok(/#vault$/.test(url), url);
});

  console.log('\nshowing a customer the card you are looking at');

const catalog = () => P.groupCatalog([row({ product_id: '1' })]);
const shareArgs = (cat, canShare) => {
  const p = cat.products.get('main::1');
  return { category: cat.categories[0], product: p, embed: P.buildProductEmbed(p, {}), ...(canShare == null ? {} : { canShare }) };
};
const customIds = (payload) =>
  payload.components.flatMap(r => r.toJSON().components).map(c => c.custom_id).filter(Boolean);

// "what if admin wants to show user? SAYS ONLY YOU CAN SEE AT THIS MOMENT."
// The private reply is deliberate — a price lookup is nobody else's business,
// and a public panel that rewrote itself on every click was the thing this
// whole layout was built to avoid. So the way to show somebody is a button on
// the card, not a mode picked before you know which product you want.
await check('staff get a share button on the card, everyone else does not', () => {
  const cat = catalog();
  const shared = (canShare) => customIds(P.browserPayload(cat, shareArgs(cat, canShare)));

  assert.ok(shared(true).some(i => i.startsWith('pinfo_share::')),
    'staff cannot post the card they are looking at');
  assert.ok(!shared(false).some(i => i.startsWith('pinfo_share::')),
    'a customer is being offered a button that will refuse them');
  assert.ok(!shared(null).some(i => i.startsWith('pinfo_share::')),
    'the button defaults to on — a public panel would carry it for everyone');
});

await check('the share button still leaves room for the language row', () => {
  // Five action rows is a hard limit and exceeding it rejects the whole
  // message. The button joins the Buy row rather than taking a sixth.
  const cat = catalog();
  const payload = P.browserPayload(cat, shareArgs(cat, true));
  assert.ok(payload.components.length <= 5, `${payload.components.length} rows`);
  assert.ok(customIds(payload).includes('xlate_lang'), 'the share button pushed the translator off the card');
});

await check('the share id survives a key that contains the separator', () => {
  // The product key is `<half>::<id>` and carries its own `::`, so a naive
  // split('::')[1] would hand back "main" and find no product.
  const cat = catalog();
  const id = customIds(P.browserPayload(cat, shareArgs(cat, true))).find(i => i.startsWith('pinfo_share::'));
  assert.strictEqual(id.slice('pinfo_share::'.length), 'main::1');
  assert.ok(id.length <= 100, 'customId is over Discord\'s limit');
});

  console.log('\nand it is wired in');

await check('index.js dispatches both dropdowns, the button, and registers the command', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  assert.ok(/handleProductInfoSelect\(interaction\)/.test(src), 'the dropdowns are dispatched');
  assert.ok(/handleProductInfoCommand\(interaction\)/.test(src), 'the command is dispatched');
  assert.ok(/handleProductInfoButton\(interaction\)/.test(src), 'the share button is dispatched');
  assert.ok(/productInfoCommands\.map/.test(src), 'the command is registered');
  // Public on purpose: a locked /product-info is a shop window with the
  // shutters down. The `channel:` option is gated inside the module instead.
  assert.ok(/'product-info',\s*\/\//.test(src), 'and it is in PUBLIC_COMMANDS');
});

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}
