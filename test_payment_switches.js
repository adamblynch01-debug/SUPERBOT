// Cover for /config methods — the Discord half of the payment kill switch
// added 2026-08-06.
//
// Before it existed there was no way to stop accepting a payment method. The
// bot's /config set takes a REQUIRED free-text value, so "off" could only be
// expressed by blanking the address — destructive, and it meant retyping a
// cashtag from memory to reopen.
//
//   node test_payment_switches.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const pending = [];
function fail(name, e) {
  failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1;
}
// Some of the checks below are async — handleMethodButton returns a promise.
// A bare try/catch would count those as passed the instant they were CALLED,
// which is a test that can only ever report success. Promises are collected
// and awaited before the tally is printed.
function check(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) { return fail(name, e); }
  if (r && typeof r.then === 'function') {
    pending.push(r.then(
      () => { passed++; console.log('  ok   ' + name); },
      (e) => fail(name, e)));
    return;
  }
  passed++; console.log('  ok   ' + name);
}

const S = require('./modules/paymentSwitches');

const states = (over) => Object.assign({
  cashapp: { available: true,  state: 'on',           reason: null },
  paypal:  { available: false, state: 'off',          reason: 'Switched off by staff' },
  btc:     { available: false, state: 'unconfigured', reason: 'BTC_XPUB is not set' },
  ltc:     { available: true,  state: 'on',           reason: null },
}, over || {});

const embedOf = (s) => S.buildEmbed(s).toJSON();
const buttonsOf = (s) => S.buildRows(s).flatMap(r => r.toJSON().components);

console.log('\nthe embed distinguishes all three states');

check('a live method reads as accepting', () => {
  assert.match(embedOf(states()).description, /Cash App\*\* — 🟢 accepting/);
});
// These two read identically at checkout, and want opposite reactions from
// whoever is looking: one is a decision, the other is a fault to go and fix.
check('a switched-off method says so, not "unavailable"', () => {
  assert.match(embedOf(states()).description, /PayPal\*\* — 🔴 switched off/);
});
check('a broken method names the variable to fix', () => {
  assert.match(embedOf(states()).description, /Bitcoin\*\* — 🟠 needs setup · BTC_XPUB is not set/);
});

check('the reply says addresses are kept', () => {
  const f = embedOf(states()).fields.map(x => x.value).join(' ');
  assert.match(f, /kept/i);
  assert.match(f, /nothing retyped/i);
});

// A posted panel is a message, not a live view. Repointing it silently would
// be worse than telling the admin to re-run one command — a stale panel that
// still says "send Cash App" is an instruction, and buyers follow it.
check('the footer points at the command that refreshes the posted panel', () => {
  assert.match(embedOf(states()).footer.text, /post-payment-method\b/);
});
check('that command actually exists in index.js', () => {
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.ok(/setName\('post-payment-method'\)/.test(idx),
    'the footer names a slash command this bot does not register');
});

// The one state worth shouting about: nothing can be paid at all.
check('with every method closed the embed turns red and says so', () => {
  const all = states({
    cashapp: { available: false, state: 'off', reason: 'Switched off by staff' },
    ltc:     { available: false, state: 'off', reason: 'Switched off by staff' },
  });
  const e = embedOf(all);
  assert.strictEqual(e.color, 0xED4245, 'still the neutral colour');
  assert.match(e.footer.text, /NOTHING IS BEING ACCEPTED/);
});

console.log('\nthe buttons flip the switch they are next to');

check('one button per method, and no more', () => {
  const b = buttonsOf(states());
  assert.strictEqual(b.length, 4);
  assert.deepStrictEqual(b.map(x => x.custom_id.split('::')[1]), ['cashapp', 'paypal', 'btc', 'ltc']);
});
check('a live method offers to turn it OFF', () => {
  const b = buttonsOf(states()).find(x => x.custom_id.startsWith('paysw::cashapp'));
  assert.strictEqual(b.custom_id, 'paysw::cashapp::off');
  assert.match(b.label, /^Turn off/);
});
check('a closed method offers to turn it back ON', () => {
  const b = buttonsOf(states()).find(x => x.custom_id.startsWith('paysw::paypal'));
  assert.strictEqual(b.custom_id, 'paysw::paypal::on');
  assert.match(b.label, /^Turn on/);
});
// The button reflects the SWITCH, not availability — but closing something
// that was never working should not look like closing a live till.
check('a broken-but-switched-on method is grey, a live one is red', () => {
  const b = buttonsOf(states());
  const btc = b.find(x => x.custom_id.startsWith('paysw::btc'));
  const cash = b.find(x => x.custom_id.startsWith('paysw::cashapp'));
  assert.strictEqual(btc.custom_id, 'paysw::btc::off', 'the switch is on, so the button turns it off');
  assert.strictEqual(btc.style, 2, 'ButtonStyle.Secondary expected for a method that was never live');
  assert.strictEqual(cash.style, 4, 'ButtonStyle.Danger expected for a live method');
});

console.log('\nthe button cannot be pressed by whoever finds the customId');

// The reply is ephemeral, but a customId is a string: anyone who can read it
// can send it, and this one closes the store's tills.
check('a non-admin press is refused and never reaches the backend', () => {
  let replied = null, deferred = false;
  return S.handleMethodButton({
    customId: 'paysw::paypal::off',
    reply: async (o) => { replied = o; },
    deferUpdate: async () => { deferred = true; },
  }, false).then((handled) => {
    assert.strictEqual(handled, true, 'it fell through to another handler');
    assert.strictEqual(replied && replied.flags, 64, 'the refusal was not ephemeral');
    assert.match(replied.content, /owner\/admin/i);
    assert.strictEqual(deferred, false, 'it started doing the work anyway');
  });
});

check('an unrecognised customId is passed through, not swallowed', () => {
  return S.handleMethodButton({ customId: 'sbrestore::123' }, true)
    .then(r => assert.strictEqual(r, false, 'it claimed a button belonging to another handler'));
});

check('an unknown method in the customId is refused', () => {
  let replied = null;
  return S.handleMethodButton({
    customId: 'paysw::payapl::off',
    reply: async (o) => { replied = o; },
    deferUpdate: async () => { throw new Error('should not defer'); },
  }, true).then(() => {
    assert.match(replied.content, /Unknown payment method/);
  });
});

console.log('\nindex.js wires it up');

const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

check('/config methods is registered', () => {
  assert.ok(/setName\('methods'\)/.test(idx), 'the subcommand is not registered');
  assert.ok(/if \(sub === 'methods'\)/.test(idx), 'the subcommand is not handled');
});
// hasOwnerAccess gates the whole /config command, and the button check is
// passed the same function's result — one definition of "owner", not two.
check('the button handler is given the same owner check as the command', () => {
  assert.ok(/handleMethodButton\(interaction, hasOwnerAccess\(interaction\)\)/.test(idx));
});
check('the PayPal.Me handle is settable from /config set', () => {
  assert.ok(/value: 'paypalme'/.test(idx), 'no paypalme choice');
  assert.ok(/paypalme: \{ key: 'PAYPAL_ME'/.test(idx), 'paypalme maps to no config key');
});
// PAYPAL_ME is not PAYPAL_EMAIL. Conflating them is the original bug.
check('the PayPal.Me choice is not wired to the email variable', () => {
  assert.ok(!/paypalme: \{ key: 'PAYPAL_EMAIL'/.test(idx));
});

Promise.all(pending).then(() => console.log(`\n${passed} passed, ${failed} failed\n`));
