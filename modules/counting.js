// ─── Counting game: reading what someone actually meant ─────────────────────
//
// The complaint this exists to fix: "the bot keeps messing up even though the
// equation is correct, making the community start over."
//
// It was. The old evaluator accepted digits, `+ - * / ^` and parentheses and
// nothing else, and ANY input it did not understand reset the count to 1. So
// `5 × 5` broke the server's streak — and `×` is the character the iOS and
// Android keyboards insert when you press the multiply key. So did `5x5`,
// `**52**`, `5²`, `sqrt(2704)`, `2(26)`, `1,000`, `５２`, `5️⃣2️⃣`, `LII`,
// `fifty two`, `50 = 25*2`, `52!`, and `52 lets go`. Twenty-one of the
// twenty-two things a real person is likely to type.
//
// The design point that follows from that: **the bot's job is not to find THE
// interpretation of a message, it is to decide whether someone counted
// correctly.** Those are different problems, and the second one is much easier
// and much more forgiving. So a message is read several ways at once — as
// typed, with the markdown stripped, with the decoration removed, either side
// of an `=`, the leading run of maths, as Roman numerals, as English words —
// and if ANY reading equals the expected number, the count stands.
//
// Being generous is not sloppiness here, it is the correct bias. A false
// accept costs one number in a sequence nobody audits. A false reject costs a
// streak the whole server built, and there is no undo. The two errors are not
// remotely the same size, so they should not get the same benefit of the doubt.
//
// The other half of the fix is that not counting is no longer the same as
// counting wrong. "gg" and "nice one" used to reset the streak, because
// anything unparseable did. Now a message that cannot be read as a number at
// all is chatter and is ignored; only a message that genuinely parses as the
// wrong number resets.
//
// eval() is still not used and must not be — this evaluates text that any
// member of the server can write. It is a hand-written tokenizer and parser
// with a step budget, a magnitude cap and no access to anything but the
// function table below.
'use strict';

// Long inputs are not a counting attempt, they are someone pasting something.
// The cap also bounds the parser's worst case.
const MAX_INPUT = 300;
// A step budget, because `9^9^9^9` is short to type and expensive to evaluate.
const MAX_STEPS = 10000;
// Beyond this a result is not a count, and letting it through invites
// deliberately huge intermediate values.
const MAX_MAGNITUDE = 1e21;
// 171! is Infinity in a double, so nothing above this is worth computing.
const FACT_MAX = 170;

// ─── Comparing ───────────────────────────────────────────────────────────────
/**
 * Whether two numbers are the same count.
 *
 * Not `===`. Binary floating point makes `0.1*520` come out as 52.00000000000001
 * and `100/3*3` as 100.00000000000001 — both of which are correct arithmetic
 * that an exact comparison calls wrong, resetting the streak over a rounding
 * error in the seventeenth digit.
 */
function nearlyEqual(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= 1e-9) return true;
  return diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

// ─── Normalising what a keyboard produced ────────────────────────────────────

// Superscripts have to be turned into `^(...)` BEFORE Unicode normalisation,
// because NFKD flattens `²` to a plain `2` — silently turning `5²` into `52`,
// which is a wrong answer that looks like a right one.
const SUPERS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
  '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁽': '(', '⁾': ')' };
const SUPER_RE = new RegExp(`[${Object.keys(SUPERS).join('')}]+`, 'g');

const FRACTIONS = { '½': '(1/2)', '⅓': '(1/3)', '⅔': '(2/3)', '¼': '(1/4)',
  '¾': '(3/4)', '⅕': '(1/5)', '⅖': '(2/5)', '⅗': '(3/5)', '⅘': '(4/5)',
  '⅙': '(1/6)', '⅚': '(5/6)', '⅐': '(1/7)', '⅛': '(1/8)', '⅜': '(3/8)',
  '⅝': '(5/8)', '⅞': '(7/8)', '⅑': '(1/9)', '⅒': '(1/10)', '↉': '(0/3)' };

// Every character a keyboard, a phone or a "fancy text" generator might produce
// for an operator that is one ASCII byte in the parser.
const OPERATORS = [
  [/[×⨯✕✖⋅·∙∗•＊]/g, '*'],
  [/[÷∕⁄／]/g, '/'],
  [/[−–—‒﹘➖]/g, '-'],
  [/[＋➕]/g, '+'],
  [/[％]/g, '%'],
  [/[（【［]/g, '('],
  [/[）】］]/g, ')'],
  [/[√]/g, 'sqrt'],
  [/[∛]/g, 'cbrt'],
  [/[π𝜋]/g, 'pi'],
  [/[τ]/g, 'tau'],
  [/[φϕ]/g, 'phi'],
  [/[≈≅]/g, '='],
];

// Word forms. `x` is handled separately because it collides with hex literals.
const WORD_OPS = [
  [/\bto the power of\b/g, '^'], [/\bto the\b/g, '^'],
  [/\bmultiplied by\b/g, '*'], [/\bdivided by\b/g, '/'],
  [/\btimes\b/g, '*'], [/\bplus\b/g, '+'], [/\bminus\b/g, '-'],
  [/\bover\b/g, '/'], [/\bmodulo\b/g, '%'], [/\bmod\b/g, '%'],
  [/\bsquared\b/g, '^2'], [/\bcubed\b/g, '^3'],
  [/\bfactorial\b/g, '!'], [/\bpercent of\b/g, '%*'], [/\bpercent\b/g, '%'],
  [/\bsquare root of\b/g, 'sqrt'], [/\broot of\b/g, 'sqrt'],
];

/**
 * Everything that is presentation rather than arithmetic.
 *
 * Discord markdown is the load-bearing part: `**52**` was rejected outright,
 * and `**` is also the exponent operator in half the world's languages, so it
 * cannot simply be deleted globally. Spoilers, code spans and strikethrough
 * have no arithmetic meaning at all and go unconditionally; the emphasis marks
 * are only stripped as a matched pair wrapping the whole thing.
 */
function stripDecoration(s) {
  let out = s
    .replace(/<a?:\w+:\d+>/g, ' ')          // custom emoji
    .replace(/<@[!&]?\d+>|<#\d+>/g, ' ')     // mentions
    .replace(/\|\|/g, '')                    // spoiler
    .replace(/~~/g, '')                      // strikethrough
    .replace(/```+/g, '').replace(/`/g, '')  // code
    .replace(/‍/g, '')                  // ZWJ, inside emoji sequences
    .replace(/[​-‏⁠﻿]/g, '')
    // A keycap emoji is <digit> + variation selector + combining keycap. Drop
    // the two decorations and `5️⃣2️⃣` is simply `52`.
    .replace(/[︎️⃣]/g, '');
  try { out = out.replace(/\p{Extended_Pictographic}/gu, ' '); } catch (_) {}

  // Emphasis, only as a pair around the whole remainder.
  for (const pair of ['**', '__', '*', '_']) {
    let guard = 0;
    while (out.length > pair.length * 2 && out.startsWith(pair) && out.endsWith(pair) && guard++ < 5) {
      out = out.slice(pair.length, -pair.length);
    }
  }
  return out;
}

// Functions that really do take more than one argument. A comma inside one of
// these calls is separating arguments; a comma anywhere else in a count is
// almost always a thousands separator someone's keyboard put there.
const MULTI_ARG = new Set(['log', 'min', 'max', 'gcd', 'hcf', 'lcm', 'ncr', 'choose',
  'comb', 'npr', 'perm', 'atan2', 'hypot', 'pow', 'mod', 'sum', 'prod', 'avg', 'mean']);

/** Hides argument commas behind a sentinel so the thousands rules skip them. */
function protectArgCommas(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const m = /^[a-z_][a-z_0-9]*\(/.exec(s.slice(i));
    if (m && MULTI_ARG.has(m[0].slice(0, -1))) {
      let depth = 1, j = i + m[0].length, inner = '';
      while (j < s.length) {
        const c = s[j];
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
        inner += c === ',' ? '\u0002' : c;
        j++;
      }
      out += m[0] + inner + (depth === 0 ? ')' : '');
      i = depth === 0 ? j + 1 : j;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Turns whatever was typed into something the tokenizer can read. Does not
 * decide whether it is valid — that is the parser's job.
 */
function normalize(raw) {
  let s = String(raw == null ? '' : raw).slice(0, MAX_INPUT);

  s = s.replace(SUPER_RE, run => `^(${[...run].map(c => SUPERS[c]).join('')})`);
  s = s.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒↉]/g, m => FRACTIONS[m] || m);
  // A digit immediately before a fraction is a mixed number: 1½ is one and a
  // half, not one times a half. The brackets matter — without them `1½*2` is
  // `1+1/2*2`, which precedence reads as 2 rather than 3.
  s = s.replace(/(\d)(\(\d+\/\d+\))/g, '($1+$2)');

  // NFKD folds fullwidth digits, "fancy text" digits (𝟓𝟐, 𝟱𝟮 — this server's
  // own name is written in them), Arabic-Indic digits and the fraction slash
  // down to ASCII. Doing it AFTER superscripts and fractions is what keeps
  // their meaning.
  try { s = s.normalize('NFKD'); } catch (_) {}
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
       .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
       .replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966));

  s = stripDecoration(s);
  for (const [re, to] of OPERATORS) s = s.replace(re, to);

  s = s.toLowerCase();
  for (const [re, to] of WORD_OPS) s = s.replace(re, to);
  s = numberWordsToDigits(s);

  // `x` means multiply between numbers — but `0x1f` is a hex literal, so the
  // literals are hidden before the substitution and put back after.
  const holes = [];
  s = s.replace(/0[xbo][0-9a-f]+/g, m => { holes.push(m); return `\u0001${holes.length - 1}\u0001`; });
  s = s.replace(/(?<=[\d)])\s*x\s*(?=[\d(])/g, '*');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => holes[Number(i)]);

  // Thousands separators. `1,000` and `1 000` and `1_000` are one number, and
  // reading the comma as an argument separator makes it two. The reverse is
  // just as bad: in `gcd(104,156)` the comma IS the argument separator, and
  // collapsing it asks for the gcd of one number. So the commas belonging to a
  // function that genuinely takes several arguments are hidden first.
  s = protectArgCommas(s);
  s = s.replace(/(\d)[,_](?=\d{3}\b)/g, '$1');
  s = s.replace(/(\d) (?=\d{3}\b)/g, '$1');
  s = s.replace(/\u0002/g, ',');
  // Ordinals and numbering: `52nd`, `#52`, `no. 52`.
  s = s.replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  s = s.replace(/\bno\.?\s*(?=\d)/g, '').replace(/#/g, '');

  return s.replace(/\s+/g, ' ').trim();
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────
const NUM_RE = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = NUM_RE.exec(s.slice(i));
      if (!m) return null;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) return null;
      out.push({ t: 'num', v });
      i += m[0].length;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z_0-9]*/i.exec(s.slice(i));
      // `√2704` normalises to `sqrt2704`, and an identifier run swallows the
      // digits — so the longest KNOWN name wins instead. `log2` and `atan2`
      // still tokenize whole, because they are known and longer than `log`.
      const run = m[0].toLowerCase();
      let name = run;
      if (!KNOWN.has(run)) {
        for (let len = run.length - 1; len > 0; len--) {
          if (KNOWN.has(run.slice(0, len))) { name = run.slice(0, len); break; }
        }
      }
      out.push({ t: 'name', v: name });
      i += name.length;
      continue;
    }
    if (s.startsWith('**', i)) { out.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^%!(),|'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    return null;   // a character with no arithmetic meaning: not an expression
  }
  return out;
}

// ─── Functions and constants ─────────────────────────────────────────────────
// A plain table, looked up with hasOwnProperty. Nothing here reaches anything
// the caller did not name, and there is no path to a prototype.
const gcd2 = (a, b) => { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; } return a; };

function factorial(n) {
  if (!Number.isFinite(n) || n < 0 || Math.abs(n - Math.round(n)) > 1e-9) return NaN;
  n = Math.round(n);
  if (n > FACT_MAX) return Infinity;
  let acc = 1;
  for (let i = 2; i <= n; i++) acc *= i;
  return acc;
}

const nPr = (n, r) => factorial(n) / factorial(n - r);
const nCr = (n, r) => factorial(n) / (factorial(r) * factorial(n - r));

// arity -1 means variadic. Single-argument entries may be written without
// parentheses — `sqrt 2704` and `sqrt2704` both work, because people write
// them that way.
const FUNCS = Object.assign(Object.create(null), {
  sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs],
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round],
  trunc: [1, Math.trunc], int: [1, Math.trunc], sign: [1, Math.sign],
  exp: [1, Math.exp], ln: [1, Math.log], log2: [1, Math.log2], log10: [1, Math.log10],
  log: [-1, (...a) => (a.length > 1 ? Math.log(a[0]) / Math.log(a[1]) : Math.log10(a[0]))],
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
  asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
  sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
  atan2: [2, Math.atan2], hypot: [-1, (...a) => Math.hypot(...a)],
  deg: [1, x => x * 180 / Math.PI], rad: [1, x => x * Math.PI / 180],
  min: [-1, (...a) => Math.min(...a)], max: [-1, (...a) => Math.max(...a)],
  pow: [2, Math.pow], mod: [2, (a, b) => (b === 0 ? NaN : a % b)],
  gcd: [-1, (...a) => a.reduce(gcd2)], hcf: [-1, (...a) => a.reduce(gcd2)],
  lcm: [-1, (...a) => a.reduce((x, y) => (x && y ? Math.abs(Math.round(x) * Math.round(y)) / gcd2(x, y) : 0))],
  fact: [1, factorial], factorial: [1, factorial],
  ncr: [2, nCr], choose: [2, nCr], comb: [2, nCr], npr: [2, nPr], perm: [2, nPr],
  sum: [-1, (...a) => a.reduce((x, y) => x + y, 0)],
  prod: [-1, (...a) => a.reduce((x, y) => x * y, 1)],
  avg: [-1, (...a) => a.reduce((x, y) => x + y, 0) / a.length],
  mean: [-1, (...a) => a.reduce((x, y) => x + y, 0) / a.length],
});

const CONSTS = Object.assign(Object.create(null), {
  pi: Math.PI, tau: Math.PI * 2, e: Math.E, phi: (1 + Math.sqrt(5)) / 2,
});

// Every name the tokenizer should recognise, longest-match-wins. Used to split
// `sqrt2704` into `sqrt` and `2704` without also splitting `log2`.
const KNOWN = new Set([...Object.keys(FUNCS), ...Object.keys(CONSTS)]);

// ─── Parser ──────────────────────────────────────────────────────────────────
//
//   expression := term (('+'|'-') term)*
//   term       := unary (('*'|'/'|'%') unary | implicit-unary)*
//   unary      := ('+'|'-') unary | power
//   power      := postfix ('^' unary)?            right-associative
//   postfix    := primary ('!' | '%')*            factorial, percent-of-one
//   primary    := number | constant | call | '(' expression ')' | '|' expr '|'
//
// Implicit multiplication is in `term` so `2(26)`, `2pi` and `(2)(3)` work —
// people write those and the old parser rejected all three.
class Bail extends Error {}

function evaluate(text) {
  const src = typeof text === 'string' ? text : normalize(text);
  if (!src || src.length > MAX_INPUT) return null;
  const toks = tokenize(src);
  if (!toks || !toks.length) return null;

  let pos = 0, steps = 0;
  const peek = (k = 0) => toks[pos + k];
  const isOp = (v, k = 0) => { const t = peek(k); return t && t.t === 'op' && t.v === v; };
  const step = () => { if (++steps > MAX_STEPS) throw new Bail('too much work'); };
  const guard = (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Bail('not a number');
    if (!Number.isFinite(v) || Math.abs(v) > MAX_MAGNITUDE) throw new Bail('out of range');
    return v;
  };
  // Can a primary start here? This is what makes implicit multiplication work
  // without swallowing `+`/`-`, which belong to the additive loop.
  const startsOperand = (k = 0) => {
    const t = peek(k);
    if (!t) return false;
    return t.t === 'num' || t.t === 'name' || (t.t === 'op' && (t.v === '(' || t.v === '|'));
  };

  function args() {
    const list = [expression()];
    while (isOp(',')) { pos++; list.push(expression()); }
    return list;
  }

  function primary() {
    step();
    const t = peek();
    if (!t) throw new Bail('ran out of input');
    if (t.t === 'num') { pos++; return t.v; }
    if (t.t === 'op' && t.v === '(') {
      pos++;
      const v = expression();
      if (!isOp(')')) throw new Bail('unclosed (');
      pos++;
      return v;
    }
    if (t.t === 'op' && t.v === '|') {   // |x| absolute value
      pos++;
      const v = expression();
      if (!isOp('|')) throw new Bail('unclosed |');
      pos++;
      return Math.abs(v);
    }
    if (t.t === 'name') {
      const name = t.v;
      if (Object.prototype.hasOwnProperty.call(FUNCS, name)) {
        pos++;
        const [arity, fn] = FUNCS[name];
        if (isOp('(')) {
          pos++;
          const list = isOp(')') ? [] : args();
          if (!isOp(')')) throw new Bail('unclosed function call');
          pos++;
          if (arity !== -1 && list.length !== arity) throw new Bail('wrong argument count');
          if (!list.length) throw new Bail('no arguments');
          return guard(fn(...list));
        }
        // `sqrt 2704` — bare application, single argument only. Binds at
        // power level so `sqrt 4 + 1` is 3, not 2.23…
        if (arity === 1 && startsOperand()) return guard(fn(power()));
        throw new Bail('function without arguments');
      }
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) { pos++; return CONSTS[name]; }
      throw new Bail(`unknown name ${name}`);
    }
    throw new Bail('not a value');
  }

  function postfix() {
    let v = primary();
    for (;;) {
      step();
      if (isOp('!')) { pos++; v = guard(factorial(v)); continue; }
      // `%` is modulo when something follows it and "of one hundred" when
      // nothing does, so `100%` is 1 and `7%3` is 1.
      if (isOp('%') && !startsOperand(1)) { pos++; v = v / 100; continue; }
      return v;
    }
  }

  function power() {
    const base = postfix();
    if (isOp('^')) { pos++; return guard(Math.pow(base, unary())); }
    return base;
  }

  function unary() {
    step();
    if (isOp('-')) { pos++; return -unary(); }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  }

  function term() {
    let v = unary();
    for (;;) {
      step();
      if (isOp('*') || isOp('/') || isOp('%')) {
        const op = peek().v; pos++;
        const rhs = unary();
        if (op === '*') v = guard(v * rhs);
        else if (op === '/') { if (rhs === 0) throw new Bail('divide by zero'); v = guard(v / rhs); }
        else { if (rhs === 0) throw new Bail('mod by zero'); v = guard(v % rhs); }
        continue;
      }
      // Implicit multiplication — but never across a `|`, which would make
      // `|3|4|` ambiguous, and never onto a bare `,`.
      if (startsOperand() && !isOp('|')) { v = guard(v * unary()); continue; }
      return v;
    }
  }

  function expression() {
    let v = term();
    for (;;) {
      step();
      if (isOp('+')) { pos++; v = guard(v + term()); continue; }
      if (isOp('-')) { pos++; v = guard(v - term()); continue; }
      return v;
    }
  }

  try {
    const v = expression();
    if (pos !== toks.length) return null;   // trailing junk: not one expression
    return guard(v);
  } catch (e) {
    if (e instanceof Bail) return null;
    return null;
  }
}

// ─── Other ways people write a number ────────────────────────────────────────

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
/**
 * Roman numerals, because a counting server hits 50 and someone types `L`.
 * Validated by round-tripping rather than by a regex: `IIII` and `IC` parse
 * arithmetically but are not how the number is written, and accepting them
 * would mean accepting readings the writer did not intend.
 */
function romanToNumber(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || !/^[ivxlcdm]+$/.test(t) || t.length > 15) return null;
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = ROMAN[t[i]], next = ROMAN[t[i + 1]];
    total += next && next > cur ? -cur : cur;
  }
  return numberToRoman(total) === t.toUpperCase() ? total : null;
}

function numberToRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return null;
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
  return out;
}

const SMALL_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90 };
const SCALE_WORDS = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

/** "fifty two", "fifty-two", "one hundred and one". */
function wordsToNumber(s) {
  const words = String(s || '').toLowerCase().replace(/[-–]/g, ' ')
    .replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w && w !== 'and');
  if (!words.length || words.length > 8) return null;
  let total = 0, current = 0, saw = false;
  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(SMALL_WORDS, w)) { current += SMALL_WORDS[w]; saw = true; continue; }
    if (Object.prototype.hasOwnProperty.call(SCALE_WORDS, w)) {
      const scale = SCALE_WORDS[w];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      saw = true;
      continue;
    }
    return null;   // a word that is not part of a number: this is not one
  }
  return saw ? total + current : null;
}

// Longest first, so `fourteen` is not matched as `four` with `teen` left over.
const NUM_WORDS = [...Object.keys(SMALL_WORDS), ...Object.keys(SCALE_WORDS)]
  .sort((a, b) => b.length - a.length);
// A maximal run of number-words. Words joined by a space or a bare hyphen are
// one number (`fifty two`, `fifty-two`); a spaced hyphen is left alone so
// `five - two` stays a subtraction.
const WORD_NUM_RE = new RegExp(
  `\\b(?:${NUM_WORDS.join('|')})(?:(?: +|-)(?:and|${NUM_WORDS.join('|')}))*\\b`, 'g');

/**
 * Turns runs of number-words into digits in place, so words can be mixed with
 * symbols: `two squared` is `2^2`, and `twenty plus thirty two` is `20+32`
 * rather than `20+30 2`. Run by run — the whole string is rarely one number.
 */
function numberWordsToDigits(s) {
  return s.replace(WORD_NUM_RE, run => {
    const v = wordsToNumber(run);
    return v === null ? run : ` ${v} `;
  });
}

// ─── Readings of a message ───────────────────────────────────────────────────
/**
 * Every way this message might be a number, and whether that reading accounts
 * for the WHOLE message.
 *
 * The distinction is the whole point. A `whole` reading that comes out wrong is
 * a genuine miscount and resets the streak. A partial reading is only ever
 * allowed to say "correct" — so `100 iq play` can pass at 100 but can never
 * reset the count on the strength of a number buried in a sentence.
 */
function readings(raw) {
  const out = [];
  const add = (expr, whole) => {
    if (expr == null) return;
    const s = String(expr).trim();
    if (s && s.length <= MAX_INPUT && !out.some(r => r.expr === s && r.whole === whole)) out.push({ expr: s, whole });
  };

  const norm = normalize(raw);
  add(norm, true);

  // A trailing "!!!" or "🎉" or "." is excitement, not arithmetic — but `52!`
  // is also a valid factorial, so both readings exist and the correct one wins.
  add(norm.replace(/[!?.,;:~\s]+$/, ''), true);
  add(norm.replace(/^[\s.,;:~]+/, ''), true);

  // Comments and asides: `13*4 // easy`, `52 (nice)`, `52 - lets go`.
  for (const cut of [/\/\//, /--\s/, /\|/, /\(/]) {
    const i = norm.search(cut);
    if (i > 0) add(norm.slice(0, i), true);
  }
  // `50 = 25*2` — both sides are claims about the same number.
  if (norm.includes('=')) for (const half of norm.split('=')) add(half, true);

  // The leading run of maths, for `52 lets go`. Partial by construction: this
  // reading may confirm a correct count and may never reset one.
  const lead = /^[0-9+\-*/^%!().,|\s]*[0-9)!%|]/.exec(norm);
  if (lead) add(lead[0], false);

  return out;
}

/**
 * Did this message count correctly?
 *
 *   correct — some reading equals `expected`
 *   wrong   — no reading does, and at least one reading of the WHOLE message
 *             is a number, so this was an attempt and it missed
 *   chatter — nothing here is a number at all; not a count, so not a mistake
 */
function readCount(raw, expected) {
  const text = String(raw == null ? '' : raw);
  const reads = readings(text);
  let wholeValue = null, wholeExpr = null;

  for (const r of reads) {
    const v = evaluate(r.expr);
    if (v === null) continue;
    if (nearlyEqual(v, expected)) return { verdict: 'correct', value: expected, via: r.expr };
    if (r.whole && wholeValue === null) { wholeValue = v; wholeExpr = r.expr; }
  }

  // Only for confirming, never for rejecting — someone typing "L" or "one" in
  // conversation should not be judged as a miscount.
  const stripped = normalize(text).replace(/[^a-z0-9 ]/g, ' ').trim();
  for (const alt of [romanToNumber(stripped), wordsToNumber(stripped)]) {
    if (alt !== null && nearlyEqual(alt, expected)) return { verdict: 'correct', value: expected, via: stripped };
  }

  if (wholeValue !== null) return { verdict: 'wrong', value: wholeValue, via: wholeExpr };
  return { verdict: 'chatter', value: null, via: null };
}

module.exports = {
  MAX_INPUT, MAX_STEPS, MAX_MAGNITUDE, FACT_MAX,
  normalize, stripDecoration, tokenize, evaluate, nearlyEqual,
  romanToNumber, numberToRoman, wordsToNumber, factorial,
  readings, readCount, FUNCS, CONSTS,
};
