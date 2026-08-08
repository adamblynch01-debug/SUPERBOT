// ─── the bot's currency ───────────────────────────────────────────────────────
//
// Every other money assertion in this repo derives its symbol from money.js, on
// purpose: a '€' typed into an assertion is a second declaration of the currency
// and it goes on passing after the first one changes. But derived assertions
// only prove the repo is CONSISTENT — flip SYMBOL to '£' and all of them still
// pass, because everything would print pounds together.
//
// So exactly one file pins the value, and it is this one. It is deliberately
// annoying: changing the shop's currency means editing a test, which is the
// moment somebody has to notice that P-BOT's utils/money.js is a separate file
// in a separate repository that must change with it. The two deploy apart and
// share no package, so nothing else can catch them drifting.
'use strict';

const assert = require('assert');
const { CURRENCY, SYMBOL, money, moneyCents, parseMoneyText } = require('./modules/money');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

console.log('\nthe declaration');

check('the shop sells in euro — change this and change P-BOT backend/utils/money.js too', () => {
  assert.strictEqual(CURRENCY, 'EUR');
  assert.strictEqual(SYMBOL, '€');
});

check('rendering puts the symbol in front and always two decimals', () => {
  assert.strictEqual(money(7.99), '€7.99');
  assert.strictEqual(money(7.5), '€7.50');
  assert.strictEqual(moneyCents(2599), '€25.99');
  assert.strictEqual(moneyCents(0), '€0.00');
});

check('a missing figure renders as zero, never as "€NaN"', () => {
  // The one thing the old bridge did that staff actually saw. A price field
  // that reads NaN is indistinguishable from a broken order.
  assert.strictEqual(money(undefined), '€0.00');
  assert.strictEqual(moneyCents(null), '€0.00');
  assert.strictEqual(money('nonsense'), '€0.00');
});

console.log('\nreading a price a human typed');

check('a euro-locale comma decimal is not a thousands separator', () => {
  // The bug this parser exists for. `Number('12,50'.replace(/,/g,''))` is 1250,
  // so a staff member hand-delivering a €12.50 order recorded it at €1250 and
  // was told nothing.
  assert.strictEqual(parseMoneyText('12,50'), 12.5);
  assert.strictEqual(parseMoneyText('0,60'), 0.6);
});

check('and a real thousands separator still is one', () => {
  // Exactly three digits after a lone separator can only be grouping: no price
  // is written to three decimal places.
  assert.strictEqual(parseMoneyText('1,100'), 1100);
  assert.strictEqual(parseMoneyText('1.100'), 1100);
  assert.strictEqual(parseMoneyText('1,234,567'), 1234567);
});

check('both separators present — the last one is the decimal point', () => {
  assert.strictEqual(parseMoneyText('1.234,56'), 1234.56);
  assert.strictEqual(parseMoneyText('1,234.56'), 1234.56);
});

check('a symbol in the box is stripped, whichever symbol it is', () => {
  // The old strip set was `[$,]`, so a seller who typed the shop's own symbol
  // got NaN and the message "€12.50 is not a price".
  assert.strictEqual(parseMoneyText('€12.50'), 12.5);
  assert.strictEqual(parseMoneyText('$12.50'), 12.5);
  assert.strictEqual(parseMoneyText(' 12.50 EUR'), 12.5);
});

check('no number at all is null, not 0 — blank must stay distinct from free', () => {
  // /manual-deliver reads a blank box as "list price" and a typed 0 as "free".
  // If a garbage string parsed to 0 it would silently comp the order.
  assert.strictEqual(parseMoneyText(''), null);
  assert.strictEqual(parseMoneyText('abc'), null);
  assert.strictEqual(parseMoneyText(null), null);
  assert.strictEqual(parseMoneyText('0'), 0);
});

console.log('\nand nothing prints a bare dollar');

check('no module renders money with a hardcoded $', () => {
  // A grep, not a call — the point is to catch a NEW site added later, which no
  // behavioural test can see. sms-gen is excluded by name: it prices a
  // third-party API that bills in genuine US dollars.
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, 'modules');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js') && n !== 'sms-gen.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // `$${x.toFixed(2)}` and `'$' + n.toFixed(2)` — a symbol glued to a
      // formatted amount. SQL placeholders ($1, $2) and `${...}` are not that.
      if (/\$\$\{[^}]*toFixed\(2\)/.test(line) || /'\$'\s*\+/.test(line)) {
        offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.strictEqual(offenders.length, 0, 'dollar renders left behind:\n        ' + offenders.join('\n        '));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
