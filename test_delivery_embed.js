// Round 33 — "Remove dashes — fix it make it look nice".
//
// What the buyer was looking at:
//
//   📦 Call of Duty: Warzone — H8ED Private External — Month
//   ```TEST-123```
//   🧾 Invoice   W6CT-TV8S ...
//   Invoice: W6CT-TV8S | Today at 11:52 AM        ← again
//
// Three facts welded into one field name with em-dashes, long enough to wrap
// onto two lines on a phone, and the invoice printed twice.
//
// These checks pin what was asked for rather than the exact wording, so the
// copy can be reworded without breaking them: no dash joining the facts, one
// invoice, one field per fact, and — the thing that is easy to lose in a
// rewrite — the protect list still naming every catalogue string in the embed,
// because that is what stops a Spanish buyer being sold a product that does not
// exist.
//
//   node test_delivery_embed.js
'use strict';

const assert = require('assert');
const { buildDeliveryEmbed } = require('./modules/deliveryEmbed');
const D = require('./modules/deliveryEmbed');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// The order from the screenshot.
const ORDER = {
  items: [{ game: 'Call of Duty: Warzone', product: 'H8ED Private External', tier: 'Month', qty: 1, values: ['TEST-123'] }],
  invoiceNo: 'W6CT-TV8S',
  orderId: 41,
  email: 'nxgx@gmail.com',
};

const render = (o) => {
  const r = buildDeliveryEmbed(o);
  const d = r.embed.toJSON();
  return { ...r, d, fields: d.fields || [], text: JSON.stringify(d) };
};

console.log('\nthe dashes');

check('no field name welds the game, the product and the term together', () => {
  const { fields } = render(ORDER);
  for (const f of fields) {
    assert.ok(!/[—–-]/.test(f.name), `still joined with a dash: ${f.name}`);
  }
});

check('each fact gets its own field', () => {
  const { fields } = render(ORDER);
  const names = fields.map(f => f.name).join(' ');
  assert.ok(/Game/.test(names), names);
  assert.ok(/Product/.test(names), names);
  assert.ok(/Plan/.test(names), names);
  assert.strictEqual(fields.find(f => /Game/.test(f.name)).value, 'Call of Duty: Warzone');
  assert.strictEqual(fields.find(f => /Product/.test(f.name)).value, 'H8ED Private External');
  assert.strictEqual(fields.find(f => /Plan/.test(f.name)).value, 'Month');
});

check('those three sit on one row', () => {
  // Discord lays out up to three consecutive inline fields per row. Four would
  // wrap, which is the layout this replaces.
  const { fields } = render(ORDER);
  const inline = fields.filter(f => f.inline);
  assert.strictEqual(inline.length, 3, inline.map(f => f.name).join(', '));
});

check('the keys still arrive, in a fence', () => {
  const { fields } = render(ORDER);
  const keys = fields.find(f => /Key/.test(f.name));
  assert.ok(keys, 'no key field');
  assert.ok(keys.value.includes('TEST-123'), keys.value);
  assert.ok(keys.value.startsWith('```') && keys.value.endsWith('```'), keys.value);
});

console.log('\nthe invoice, once');

check('the invoice number appears exactly once', () => {
  const { text } = render(ORDER);
  const hits = (text.match(/W6CT-TV8S/g) || []).length;
  assert.strictEqual(hits, 1, `printed ${hits} times`);
});

check('the footer no longer repeats it', () => {
  const { d } = render(ORDER);
  assert.ok(d.footer && d.footer.text, 'the footer was dropped entirely');
  assert.ok(!/W6CT-TV8S/.test(d.footer.text), d.footer.text);
});

check('the claim instructions survived the rewrite', () => {
  const { fields } = render(ORDER);
  const inv = fields.find(f => /Invoice/.test(f.name));
  assert.ok(/claim-customer/.test(inv.value), inv.value);
  assert.ok(inv.value.includes('nxgx@gmail.com'), 'the email to claim with is gone');
});

check('no email is not a dead end', () => {
  const { fields } = render({ ...ORDER, email: null });
  const inv = fields.find(f => /Invoice/.test(f.name));
  assert.ok(/leave the email blank/i.test(inv.value), inv.value);
});

console.log('\nwhat must not be translated');

check('every catalogue string in the embed is in the protect list', () => {
  const { protect } = render(ORDER);
  for (const s of ['Call of Duty: Warzone', 'H8ED Private External', 'Month', 'W6CT-TV8S']) {
    assert.ok(protect.includes(s), `${s} would be translated`);
  }
});

check('the list has no empty or duplicate entries', () => {
  const { protect } = render({
    items: [
      { game: '', product: 'Balance Top-Up', tier: null, qty: 1, values: ['+$25.00'] },
      { game: '', product: 'Balance Top-Up', tier: null, qty: 1, values: ['+$10.00'] },
    ],
    invoiceNo: 'AAAA-BBBB',
  });
  assert.deepStrictEqual(protect, ['Balance Top-Up', 'AAAA-BBBB']);
});

console.log('\nthe cases that are not one product with a game');

check('a game already inside the product name is not repeated', () => {
  // "HWID Spoofer — H8ED PERMANENT SPOOFER" read like a bug.
  const { fields } = render({
    items: [{ game: 'HWID Spoofer', product: 'HWID Spoofer H8ED Permanent', qty: 1, values: ['K'] }],
    invoiceNo: 'X',
  });
  assert.ok(!fields.some(f => /Game/.test(f.name)), 'the game was shown twice');
});

check('no tier and no game still renders', () => {
  const { fields, d } = render({ items: [{ product: 'Balance Top-Up', qty: 1, values: ['+$25.00'] }], invoiceNo: 'X' });
  assert.ok(d.title.includes('Ready'), d.title);
  assert.ok(fields.some(f => /Product/.test(f.name)));
  assert.ok(fields.some(f => /Key/.test(f.name)));
});

check('a quantity above one is stated', () => {
  const { text } = render({ items: [{ product: 'Gen Key', tier: 'Week', qty: 3, values: ['a', 'b', 'c'] }], invoiceNo: 'X' });
  assert.ok(/×3/.test(text), text);
});

check('several products get one field each, product first', () => {
  const { fields, delivered } = render({
    items: [
      { game: 'Rust', product: 'Fluent', tier: 'Day', qty: 1, values: ['R-1'] },
      { game: 'Apex', product: 'Ring-1', tier: 'Week', qty: 2, values: ['A-1', 'A-2'] },
    ],
    invoiceNo: 'X',
  });
  assert.strictEqual(delivered, 2);
  const boxes = fields.filter(f => f.name.startsWith('📦'));
  assert.strictEqual(boxes.length, 2, boxes.map(f => f.name).join(' | '));
  assert.ok(boxes[0].name.includes('Fluent') && !/[—–]/.test(boxes[0].name), boxes[0].name);
  assert.ok(boxes[1].value.includes('A-2'), boxes[1].value);
});

check('an item with nothing to deliver is not a field', () => {
  // The caller filters failure markers; an item that filters down to nothing
  // must not leave an empty box behind.
  const { fields, delivered } = render({
    items: [{ product: 'Sold Out Thing', qty: 1, values: [] },
            { product: 'Real Thing', qty: 1, values: ['K-1'] }],
    invoiceNo: 'X',
  });
  assert.strictEqual(delivered, 1);
  assert.ok(!JSON.stringify(fields).includes('Sold Out Thing'), 'the undelivered item is in the embed');
});

check('nothing delivered at all reports zero rather than sending an empty embed', () => {
  assert.strictEqual(render({ items: [{ product: 'X', values: [] }], invoiceNo: 'X' }).delivered, 0);
});

console.log('\nDiscord will accept it');

check('no field exceeds the hard caps', () => {
  const many = Array.from({ length: 400 }, (_, i) => `KEY-${String(i).padStart(4, '0')}-XXXXXXXXXXXX`);
  const { fields, d } = render({
    items: [{ game: 'G'.repeat(300), product: 'P'.repeat(300), tier: 'T'.repeat(300), qty: 1, values: many }],
    invoiceNo: 'X',
  });
  assert.ok(fields.length <= 25, `${fields.length} fields`);
  for (const f of fields) {
    assert.ok(f.name.length <= 256, `name ${f.name.length}`);
    assert.ok(f.value.length <= 1024, `value ${f.value.length} on ${f.name}`);
  }
  assert.ok((d.description || '').length <= 4096);
});

check('a long multi-product order stays inside the field count', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ product: `Item ${i}`, tier: 'Month', qty: 1, values: [`K${i}`] }));
  const { fields } = render({ items, invoiceNo: 'X' });
  assert.ok(fields.length <= 25, `${fields.length} fields`);
  assert.ok(fields.some(f => /Invoice/.test(f.name)), 'the invoice was pushed out by the products');
});

console.log('\nthe two delivery paths are the same message');

check('manualDelivery and internalEvents both render through this module', () => {
  const fs = require('fs');
  for (const f of ['modules/manualDelivery.js', 'modules/internalEvents.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(/require\('\.\/deliveryEmbed'\)/.test(src), `${f} does not use the shared renderer`);
    assert.ok(/buildDeliveryEmbed\(/.test(src), `${f} does not call it`);
  }
});

check('neither one still builds its own delivery embed', () => {
  // The call, not the phrase — a comment is allowed to quote the title, and
  // asserting on the words alone made this fail on a comment explaining why an
  // empty delivery must NOT send one.
  const fs = require('fs');
  for (const f of ['modules/manualDelivery.js', 'modules/internalEvents.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/setTitle\(\s*'✅ Your Order is Ready!'/.test(src),
      `${f} still has a hand-built copy of the buyer's embed`);
  }
});

console.log('\na bulk order does not deliver half a key');

check('whole keys only, and the buyer is told how many did not fit', () => {
  // 300 × 20 chars against a 1024-char field. Cutting the string at the cap
  // ends mid-key, so the buyer gets one credential that does not work and no
  // sign that 280 more were ever theirs — a failure that reads as a success.
  const many = Array.from({ length: 300 }, (_, i) => `KEY-${String(i).padStart(15, '0')}`);
  const { embed } = D.buildDeliveryEmbed({ items: [{ product: 'Bulk', values: many }], invoiceNo: 'INV-1' });
  const f = embed.toJSON().fields.find(x => /Key/i.test(x.name));
  assert.ok(f.value.length <= D.LIMIT.value, `${f.value.length} chars`);
  const block = f.value.slice(f.value.indexOf('```') + 3, f.value.lastIndexOf('```'));
  const keys = block.split('\n');
  assert.ok(keys.length > 1, 'nothing was delivered at all');
  assert.ok(keys.every(k => many.includes(k)), 'a key was cut in half');
  assert.ok(/\b\d+ more keys are not shown/.test(f.value), f.value.slice(-200));
  // The count has to be right — "some" is not a number a person can act on.
  assert.strictEqual(Number(f.value.match(/(\d+) more keys/)[1]), 300 - keys.length);
  assert.ok(/Orders/.test(f.value), 'the buyer is not told where the rest are');
});

check('an order that fits says nothing about omissions', () => {
  const { embed } = D.buildDeliveryEmbed({ items: [{ product: 'One', values: ['KEY-A', 'KEY-B'] }] });
  const f = embed.toJSON().fields.find(x => /Key/i.test(x.name));
  assert.ok(!/not shown/.test(f.value), f.value);
  assert.ok(f.value.includes('KEY-A') && f.value.includes('KEY-B'), f.value);
});

check('the same holds when several products share the embed', () => {
  const many = Array.from({ length: 200 }, (_, i) => `K${String(i).padStart(18, '0')}`);
  const { embed } = D.buildDeliveryEmbed({ items: [
    { product: 'Alpha', game: 'Rust', tier: '30 Days', values: many },
    { product: 'Beta', values: many },
  ] });
  for (const f of embed.toJSON().fields.filter(x => /Alpha|Beta/.test(x.name))) {
    assert.ok(f.value.length <= D.LIMIT.value, `${f.name}: ${f.value.length} chars`);
    const block = f.value.slice(f.value.indexOf('```') + 3, f.value.lastIndexOf('```'));
    assert.ok(block.split('\n').every(k => many.includes(k)), `${f.name} cut a key in half`);
    assert.ok(/not shown/.test(f.value), `${f.name} dropped keys silently`);
  }
});

check('one absurdly long value still delivers something, marked', () => {
  // A single 3000-char "key" is a malformed catalogue entry, not a normal
  // order — but an empty code block would be the worst of both.
  const { embed } = D.buildDeliveryEmbed({ items: [{ product: 'Odd', values: ['X'.repeat(3000)] }] });
  const f = embed.toJSON().fields.find(x => /Key/i.test(x.name));
  assert.ok(f.value.length <= D.LIMIT.value, `${f.value.length} chars`);
  assert.ok(/X{50,}/.test(f.value), 'nothing was delivered');
});

console.log(`\n${passed} passed, ${failed} failed`);
