// Round 33 — "Give me a sick modal/post for website/PAYMENT channel. Looks dead…."
//
// The look is not what these check. What they check is the thing that makes the
// panel worth more than a prettier hardcode: every number on it is the store's
// number. A panel saying "+10% Cash App" or "pay within 3 hours" is a promise
// the checkout has to keep, so the tests below feed a config in and assert the
// panel repeats it — including the awkward cases, where the fee is 0, where a
// method is switched off, and where the backend is down and the panel must say
// LESS rather than guess.
//
//   node test_storefront_panels.js
'use strict';

const assert = require('assert');
const P = require('./modules/storefrontPanels');

let passed = 0, failed = 0;
// Awaited, so a check that returns a promise fails HERE rather than escaping as
// an unhandled rejection while the runner counts it as a pass.
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// Enough of a guild for the builders: they read .name and .iconURL().
const GUILD = { id: '1', name: 'UH SERVICES', iconURL: () => null };

// What /api/config actually serves (backend/routes/config.js).
const CFG = {
  store_name: 'UH SERVICES',
  cashapp_cashtag: '$uhpay',
  paypal_email: 'pay@uhservices.xyz',
  cashapp_fee: 10,
  paypal_fee: 10,
  crypto_discount: 5,
  crypto_fee: 5,
  expiry_minutes: { crypto: 180, cash: 60, default: 60 },
  payment_methods: { cashapp: true, paypal: true, btc: true, ltc: true },
};

const site = (p) => JSON.stringify(p);
const pay  = (cfg) => P.buildPaymentPanel(GUILD, cfg).embeds[0].toJSON();
const web  = (cfg, url) => P.buildWebsitePanel(GUILD, cfg, url).embeds[0].toJSON();

main();
async function main() {

  console.log('\nthe window, in words a person reads');

await check('minutes below an hour stay minutes', () => {
  assert.strictEqual(P.humanMinutes(45), '45 minutes');
  assert.strictEqual(P.humanMinutes(5), '5 minutes');
});

await check('whole hours are hours', () => {
  assert.strictEqual(P.humanMinutes(60), '1 hour');
  assert.strictEqual(P.humanMinutes(180), '3 hours');
});

await check('a ragged window keeps its remainder', () => {
  assert.strictEqual(P.humanMinutes(90), '1h 30m');
});

await check('a window it cannot read is null, not a made-up one', () => {
  // The state that matters: a backend deployed before expiry_minutes existed
  // answers 200 with the key absent. Rounding that up to a floor printed
  // "pay within 1 minutes" on a live panel — a window nothing enforces.
  assert.strictEqual(P.humanMinutes(undefined), null);
  assert.strictEqual(P.humanMinutes(null), null);
  assert.strictEqual(P.humanMinutes(0), null);
  assert.strictEqual(P.humanMinutes('nonsense'), null);
});

await check('an older backend loses the window, not the whole row', () => {
  // This is the LIVE payload as of writing: /api/config predates both
  // expiry_minutes and crypto_fee, so the panel must degrade rather than guess.
  const { expiry_minutes, crypto_fee, ...old } = CFG;   // eslint-disable-line no-unused-vars
  const rows = P.paymentRows(old);
  const btc = rows.find(r => /Bitcoin/.test(r.name));
  assert.ok(btc, 'the method vanished with its window');
  assert.ok(/on-chain/.test(btc.value), 'the row lost its body too: ' + btc.value);
  const text = JSON.stringify(rows);
  assert.ok(!/within/.test(text), 'a window was stated with nothing to read it from');
  assert.ok(!/%/.test(text.replace(/`\+10%`/g, '')), 'the crypto fee was invented: ' + btc.value);
});

await check('a missing fee leaves no stray bullet or blank line', () => {
  const rows = P.paymentRows({ ...CFG, crypto_fee: undefined, expiry_minutes: undefined });
  const btc = rows.find(r => /Bitcoin/.test(r.name));
  assert.ok(!/^\n|\n\n|^ *•/.test(btc.value), JSON.stringify(btc.value));
  assert.ok(btc.value.startsWith('Confirmed'), JSON.stringify(btc.value));
});

await check('the cash methods keep the fee the old backend DOES serve', () => {
  // cashapp_fee and paypal_fee have always been in the payload; only the crypto
  // one is new. Degrading is per-value, not per-panel.
  const { expiry_minutes, crypto_fee, ...old } = CFG;   // eslint-disable-line no-unused-vars
  const rows = P.paymentRows(old);
  assert.ok(/\+10%/.test(rows.find(r => /Cash App/.test(r.name)).value));
  assert.ok(rows.find(r => /Cash App/.test(r.name)).value.includes('$uhpay'));
});

  console.log('\nthe payment panel says the store\'s numbers');

await check('the crypto fee comes from crypto_fee, never from crypto_discount', () => {
  // These two disagree on purpose in the payload — one is applied, one is not.
  const rows = P.paymentRows({ ...CFG, crypto_fee: 7, crypto_discount: 99 });
  const btc = rows.find(r => /Bitcoin/.test(r.name));
  assert.ok(/\+7%/.test(btc.value), btc.value);
  assert.ok(!/99/.test(JSON.stringify(rows)), 'the discount that is applied nowhere reached the panel');
});

await check('each cash method quotes its own fee and the cash window', () => {
  const rows = P.paymentRows({ ...CFG, cashapp_fee: 12, paypal_fee: 8 });
  assert.ok(/\+12%/.test(rows.find(r => /Cash App/.test(r.name)).value));
  assert.ok(/\+8%/.test(rows.find(r => /PayPal/.test(r.name)).value));
  for (const r of rows.filter(r => /Cash App|PayPal/.test(r.name))) {
    assert.ok(/1 hour/.test(r.value), r.value);
  }
});

await check('crypto quotes the crypto window, not the cash one', () => {
  const rows = P.paymentRows(CFG);
  for (const r of rows.filter(r => /Bitcoin|Litecoin/.test(r.name))) {
    assert.ok(/3 hours/.test(r.value), r.value);
  }
});

await check('a fee of zero prints as 0%, not as a default', () => {
  // parseFloat('0') is falsy — the exact shape that silently substitutes 10.
  const rows = P.paymentRows({ ...CFG, cashapp_fee: 0, crypto_fee: 0 });
  assert.ok(/\+0%/.test(rows.find(r => /Cash App/.test(r.name)).value));
  assert.ok(/\+0%/.test(rows.find(r => /Bitcoin/.test(r.name)).value));
});

await check('the cashtag and the paypal address are shown when set', () => {
  const rows = P.paymentRows(CFG);
  assert.ok(rows.find(r => /Cash App/.test(r.name)).value.includes('$uhpay'));
  assert.ok(rows.find(r => /PayPal/.test(r.name)).value.includes('pay@uhservices.xyz'));
});

await check('no cashtag means no line, not an empty bold', () => {
  const rows = P.paymentRows({ ...CFG, cashapp_cashtag: null });
  const v = rows.find(r => /Cash App/.test(r.name)).value;
  assert.ok(!/Send to/.test(v), v);
});

console.log('\nan address that is not an address');

await check('the live placeholder cashtag is never published', () => {
  // CASHAPP_CASHTAG on the live backend is literally " your $cashtag".
  const rows = P.paymentRows({ ...CFG, cashapp_cashtag: ' your $cashtag' });
  const v = rows.find(r => /Cash App/.test(r.name)).value;
  assert.ok(!/Send to/.test(v), v);
  assert.ok(!/your \$cashtag/.test(v), v);
  // and the method itself is still listed — it IS enabled, the address is not.
  assert.ok(/Cash App/.test(rows.map(r => r.name).join(' ')));
});

await check('a real cashtag survives, trimmed', () => {
  const v = P.paymentRows({ ...CFG, cashapp_cashtag: '  $uhpay  ' }).find(r => /Cash App/.test(r.name)).value;
  assert.ok(/Send to \*\*\$uhpay\*\*/.test(v), JSON.stringify(v));
});

await check('a paypal field that is not an email is dropped too', () => {
  const v = P.paymentRows({ ...CFG, paypal_email: 'ask staff' }).find(r => /PayPal/.test(r.name)).value;
  assert.ok(!/Send to/.test(v), v);
  assert.ok(/pay@uhservices\.xyz|Send to/.test(P.paymentRows(CFG).find(r => /PayPal/.test(r.name)).value));
});

await check('the admin is told which address is broken, and the channel is not', () => {
  const problems = P.addressProblems({ ...CFG, cashapp_cashtag: ' your $cashtag' });
  assert.strictEqual(problems.length, 1);
  assert.ok(/CASHAPP_CASHTAG/.test(problems[0]), problems[0]);
  assert.ok(/Railway/.test(problems[0]), problems[0]);
  assert.strictEqual(P.addressProblems(CFG).length, 0, 'a healthy config produced a warning');
  // A method that is switched off cannot have a broken address.
  assert.strictEqual(P.addressProblems({ ...CFG, cashapp_cashtag: 'x', payment_methods: {} }).length, 0);
});

await check('the footer does not claim to have read windows it did not', () => {
  const { expiry_minutes, ...old } = CFG;   // eslint-disable-line no-unused-vars
  const d = P.buildPaymentPanel(GUILD, old).embeds[0].toJSON();
  assert.ok(!/windows/.test(d.footer.text), d.footer.text);
  assert.ok(/fees/.test(d.footer.text), d.footer.text);
  assert.ok(/windows/.test(pay(CFG).footer.text), pay(CFG).footer.text);
});

  console.log('\na method that is switched off is not advertised');

await check('only the enabled methods get a field', () => {
  const rows = P.paymentRows({ ...CFG, payment_methods: { btc: true, ltc: false, cashapp: false, paypal: false } });
  const names = rows.map(r => r.name).join(' ');
  assert.ok(/Bitcoin/.test(names), names);
  assert.ok(!/Litecoin/.test(names), names);
  assert.ok(!/Cash App/.test(names), names);
  assert.ok(!/PayPal/.test(names), names);
});

await check('store balance is always there — it needs no backend key', () => {
  const rows = P.paymentRows({ ...CFG, payment_methods: {} });
  assert.strictEqual(rows.length, 1);
  assert.ok(/balance/i.test(rows[0].name));
});

  console.log('\nthe backend being down');

await check('no config means no invented fee anywhere in the panel', () => {
  const d = pay(null);
  const text = site(d);
  assert.ok(!/%/.test(text.replace(/[^%]/g, '')), 'a percentage was printed with no config to read it from');
  assert.ok(!/\bwithin\b/.test(text), 'a payment window was printed with no config');
});

await check('and it says so instead of pretending', () => {
  const d = pay(null);
  assert.ok(/could not be read/i.test(d.description), d.description);
  assert.ok(/unreachable/i.test(d.footer.text), d.footer.text);
});

await check('the warnings still print — they are not fetched, they are always true', () => {
  const d = pay(null);
  const warn = d.fields.find(f => /Before you send/.test(f.name));
  assert.ok(warn, 'the scam warning was dropped with the config');
  assert.ok(/never/i.test(warn.value));
});

  console.log('\nthe website panel');

await check('it is more than the link it used to be', () => {
  const d = web(CFG);
  assert.ok(d.fields.length >= 3, `${d.fields.length} fields`);
  assert.ok(/24\/7/.test(d.description), d.description);
  assert.ok(d.url === 'https://uhservices.xyz', d.url);
});

await check('a custom url is used everywhere, and the scheme is not doubled', () => {
  const p = P.buildWebsitePanel(GUILD, CFG, 'https://example.com/');
  const d = p.embeds[0].toJSON();
  assert.strictEqual(d.url, 'https://example.com');
  assert.ok(/example\.com/.test(d.title) && !/https/.test(d.title), d.title);
  for (const b of p.components[0].toJSON().components) {
    assert.ok(b.url.startsWith('https://example.com'), b.url);
    assert.ok(!/https:\/\/.*https:/.test(b.url), b.url);
  }
});

await check('the accepted-payment line names only enabled methods', () => {
  const d = web({ ...CFG, payment_methods: { btc: true, cashapp: true } });
  const f = d.fields.find(f => /Payments accepted/.test(f.name));
  assert.ok(/Bitcoin/.test(f.value) && /Cash App/.test(f.value), f.value);
  assert.ok(!/Litecoin/.test(f.value) && !/PayPal/.test(f.value), f.value);
});

await check('with no config the payments line is absent rather than empty', () => {
  const d = web(null);
  assert.ok(!d.fields.some(f => /Payments accepted/.test(f.name)), site(d.fields));
});

  console.log('\nre-running edits instead of duplicating');

await check('both panels carry a marker in the footer', () => {
  assert.ok(web(CFG).footer.text.includes(P.MARK_SITE));
  assert.ok(pay(CFG).footer.text.includes(P.MARK_PAY));
  assert.notStrictEqual(P.MARK_SITE, P.MARK_PAY);
});

await check('upsertPanel edits the marked message and never sends a second', async () => {
  const me = { id: 'bot' };
  const edits = [], sends = [];
  const target = { author: { id: 'bot' }, embeds: [{ footer: { text: `x • ${P.MARK_PAY}` } }], edit: async (p) => edits.push(p) };
  const channel = {
    messages: { fetch: async () => [
      { author: { id: 'someone' }, embeds: [] },
      { author: { id: 'bot' }, embeds: [{ footer: { text: `x • ${P.MARK_SITE}` } }], edit: async () => { throw new Error('edited the WRONG panel'); } },
      target,
    ] },
    send: async (p) => { sends.push(p); return {}; },
  };
  return P.upsertPanel(channel, P.MARK_PAY, { embeds: [] }, me).then(r => {
    assert.strictEqual(r.edited, true);
    assert.strictEqual(edits.length, 1);
    assert.strictEqual(sends.length, 0);
  });
});

await check('a channel it cannot read history in still gets the panel', async () => {
  const sends = [];
  const channel = {
    messages: { fetch: async () => { throw new Error('Missing Access'); } },
    send: async (p) => { sends.push(p); return {}; },
  };
  return P.upsertPanel(channel, P.MARK_PAY, { embeds: [] }, { id: 'bot' }).then(r => {
    assert.strictEqual(r.edited, false);
    assert.strictEqual(sends.length, 1);
  });
});

  console.log('\nDiscord will accept it');

await check('no field exceeds the hard caps and there are not too many', () => {
  for (const d of [pay(CFG), web(CFG), pay(null), web(null)]) {
    assert.ok((d.fields || []).length <= 25);
    for (const f of d.fields || []) {
      assert.ok(f.name.length <= 256, f.name);
      assert.ok(f.value.length <= 1024, `${f.name}: ${f.value.length}`);
    }
    assert.ok((d.description || '').length <= 4096);
    assert.ok(d.footer.text.length <= 2048);
  }
});

await check('every button is a valid link or a custom id, never both', () => {
  for (const p of [P.buildWebsitePanel(GUILD, CFG), P.buildPaymentPanel(GUILD, CFG)]) {
    const row = p.components[0].toJSON();
    assert.ok(row.components.length <= 5);
    for (const b of row.components) {
      if (b.style === 5) { assert.ok(/^https?:\/\//.test(b.url), b.url); assert.ok(!b.custom_id); }
      else { assert.ok(b.custom_id, JSON.stringify(b)); assert.ok(!b.url); }
    }
  }
});

  console.log('\nthe old dead post is gone');

await check('/setwebsite no longer builds the bare-link embed', () => {
  const src = require('fs').readFileSync('index.js', 'utf8');
  assert.ok(!/setDescription\(`### \[\$\{displayUrl\}\]/.test(src), 'the one-line link embed is still in index.js');
  assert.ok(/buildWebsitePanel\(/.test(src), '/setwebsite does not render the shared panel');
});

await check('and it no longer remembers the message in memory', () => {
  const src = require('fs').readFileSync('index.js', 'utf8');
  // The name may survive in a comment explaining why it went; the assignment
  // must not, because that is the part a restart forgot.
  assert.ok(!/^const websiteMessages/m.test(src), 'websiteMessages is still declared');
  assert.ok(!/websiteMessages\[/.test(src), 'websiteMessages is still written to');
});

  console.log(`\n${passed} passed, ${failed} failed`);
}
