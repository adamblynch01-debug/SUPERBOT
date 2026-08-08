// ─── The shop's currency, in one place (bot side) ────────────────────────────
//
// The store switched from dollars to euro. This file is the bot's copy of the
// backend's utils/money.js and it is a DELIBERATE duplicate: SUPERBOT and P-BOT
// are two repositories that deploy separately and share no package, so the only
// alternatives were an npm dependency between them or a `require` across a path
// that does not exist inside either container.
//
// What is not acceptable is a `$` typed into a template literal, which is how
// the currency came to be un-changeable in the first place. Everything in this
// repo that prints or reads money goes through here, so the next change is one
// edit in one file per repo rather than a grep across two.
//
// ⚠ modules/sms-gen.js is NOT one of those places. It prices numbers bought
// from a third-party SMS API that bills in genuine US dollars; its `$` is
// correct and must survive every future currency sweep.
'use strict';

const CURRENCY = 'EUR';
const SYMBOL = '€';

/** Euro (a float) → "€7.99". */
function money(amount) {
  return SYMBOL + (Number(amount) || 0).toFixed(2);
}

/** Integer cents → "€7.99". The form most order rows need. */
function moneyCents(cents) {
  return SYMBOL + ((Number(cents) || 0) / 100).toFixed(2);
}

/**
 * Reads a money figure out of text a HUMAN typed, in either separator
 * convention. The bot has exactly one such box — the "price paid" field on
 * /manual-deliver — and it used to do `Number(s.replace(/[$,]/g, ''))`.
 *
 * In a euro shop that is two bugs at once. A seller typing the European form
 * "12,50" got the comma deleted and delivered an order recorded at €1250. A
 * seller typing "€12.50" got the euro sign left in place — it is not in the
 * stripped set — so `Number` returned NaN, which the guard below rejects as
 * "not a price" for a string that plainly is one.
 *
 * The rule needs no locale flag:
 *   • Both separators → the LAST is the decimal point.
 *   • One lone separator with exactly 3 digits after it → grouping ("1,100").
 *   • Otherwise a lone separator is the decimal point ("12,50", "12.50").
 *
 * Returns null, not NaN, when there is no number in the string, so callers keep
 * using Number.isFinite() as the "did we read an amount" test.
 */
function parseMoneyText(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const digits = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  let normalised;

  if (lastDot > -1 && lastComma > -1) {
    const dec = Math.max(lastDot, lastComma);
    normalised = digits.slice(0, dec).replace(/[.,]/g, '') + '.' + digits.slice(dec + 1).replace(/[.,]/g, '');
  } else if (lastDot > -1 || lastComma > -1) {
    const dec = Math.max(lastDot, lastComma);
    const after = digits.slice(dec + 1);
    const before = digits.slice(0, dec);
    const lone = (digits.match(/[.,]/g) || []).length === 1;
    normalised = (lone && after.length !== 3)
      ? before.replace(/[.,]/g, '') + '.' + after
      : digits.replace(/[.,]/g, '');
  } else {
    normalised = digits;
  }

  const value = parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

module.exports = { CURRENCY, SYMBOL, money, moneyCents, parseMoneyText };
