// Counting game — reading what someone meant.
//
// Every case in the first block is a real thing a person types that the old
// evaluator rejected, and every rejection reset the whole server's streak. They
// are pinned individually rather than in a loop so a regression names the exact
// notation that broke, which is the only useful thing to know at that point.
//
//   node test_counting.js
'use strict';

const assert = require('assert');
const C = require('./modules/counting');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};
// `input` should be read as `want`, whatever else it also is.
const reads = (input, want) => {
  const r = C.readCount(input, want);
  assert.strictEqual(r.verdict, 'correct',
    `${JSON.stringify(input)} should count as ${want}, got ${r.verdict} (${r.value})`);
};

// ─── The regressions: what a phone keyboard and Discord actually produce ─────
check('× and ÷ — the characters the phone keyboard inserts', () => {
  // The single likeliest cause of "the equation was correct and it reset
  // anyway". Nobody types these deliberately; the multiply key produces them.
  reads('5 × 5', 25);
  reads('50 ÷ 2', 25);
  reads('30 − 5', 25);
});

check('x as multiply', () => { reads('5x5', 25); reads('5 X 5', 25); });

check('Discord markdown does not change the number', () => {
  // `**52**` is bold. It was rejected outright, and `**` is also the exponent
  // operator, so it cannot simply be deleted everywhere.
  reads('**52**', 52);
  reads('||52||', 52);
  reads('`52`', 52);
  reads('~~52~~', 52);
  reads('__52__', 52);
});

check('superscripts survive Unicode normalisation', () => {
  // NFKD flattens ² to a plain 2, which silently turns 5² into 52 — a WRONG
  // answer that looks right. Superscripts are converted before that happens.
  reads('5²', 25);
  reads('2³', 8);
  reads('2⁻¹', 0.5);
  assert.strictEqual(C.evaluate(C.normalize('5²')), 25, '5² must not read as 52');
});

check('fancy text and fullwidth digits are still digits', () => {
  // This server writes its own name in them (𝗨𝗻𝗸𝗻𝗼𝘄𝗻 𝗛𝗮𝗰𝗸𝗶𝗻𝗴™).
  reads('５２', 52);
  reads('𝟓𝟐', 52);
  reads('𝟱𝟮', 52);
});

check('keycap emoji digits', () => { reads('5️⃣2️⃣', 52); });

check('thousands separators are one number, not two arguments', () => {
  reads('1,000', 1000);
  reads('1 000', 1000);
  reads('1_000', 1000);
});

check('an equals sign is someone showing their working', () => {
  reads('50 = 25*2', 50);
  reads('50=25*2', 50);
});

check('trailing excitement is not arithmetic', () => {
  reads('52!', 52);      // and 52! is also a real factorial — both are read
  reads('52 🎉', 52);
  reads('52...', 52);
  reads('52 lets go', 52);
  reads('#52', 52);
  reads('52nd', 52);
});

check('a factorial is still a factorial where it matters', () => {
  assert.strictEqual(C.evaluate('5!'), 120);
  reads('5!', 120);
});

check('implicit multiplication', () => {
  reads('2(26)', 52);
  reads('(2)(26)', 52);
  reads('4(3)(2)', 24);
});

check('** as exponent', () => { reads('2**5', 32); });

check('a leading plus', () => { reads('+52', 52); });

check('comments and asides', () => {
  reads('13*4 // easy', 52);
  reads('13*4 -- easy', 52);
  reads('52 (nice)', 52);
});

// ─── Floating point ──────────────────────────────────────────────────────────
check('correct arithmetic is not rejected by a rounding error', () => {
  // 1/49*49 is 0.9999999999999999 in a double and 4.35*100 is
  // 434.99999999999994. Exact comparison calls both wrong and resets a streak
  // over the sixteenth digit of a sum that is right.
  assert.notStrictEqual(1 / 49 * 49, 1, 'the premise of this test');
  assert.notStrictEqual(4.35 * 100, 435, 'the premise of this test');
  reads('1/49*49', 1);
  reads('4.35*100', 435);
  reads('0.1+0.2', 0.3);
  reads('1/3*156', 52);
});

// ─── Chatter is not a miscount ───────────────────────────────────────────────
check('talking in the channel does not reset the count', () => {
  // The other half of "the bot keeps messing up": anything unparseable was
  // treated as a wrong answer, so "gg" ended the streak.
  for (const s of ['gg', 'nice one', 'lets goooo', '🔥🔥', 'wait what', '']) {
    assert.strictEqual(C.readCount(s, 52).verdict, 'chatter', `${JSON.stringify(s)} should be ignored`);
  }
});

check('a number buried in a sentence can confirm but never reset', () => {
  // "100 iq play" at 100 is someone counting with a joke attached. The same
  // message at 52 is not evidence they miscounted.
  assert.strictEqual(C.readCount('100 iq play', 100).verdict, 'correct');
  assert.strictEqual(C.readCount('100 iq play', 52).verdict, 'chatter');
});

check('a genuine miscount still resets', () => {
  // The whole feature would be pointless otherwise.
  const r = C.readCount('53', 52);
  assert.strictEqual(r.verdict, 'wrong');
  assert.strictEqual(r.value, 53);
  assert.strictEqual(C.readCount('26*3', 52).verdict, 'wrong');
  assert.strictEqual(C.readCount('**53**', 52).verdict, 'wrong');
});

// ─── Breadth ─────────────────────────────────────────────────────────────────
check('roots, logs and the rest of the function table', () => {
  reads('sqrt(2704)', 52);
  reads('sqrt 2704', 52);      // people write it without brackets
  reads('√2704', 52);
  reads('cbrt(27)', 3);
  reads('log(100)', 2);
  reads('log(8,2)', 3);
  reads('ln(e)', 1);
  reads('abs(-52)', 52);
  reads('floor(52.9)', 52);
  reads('round(51.6)', 52);
  reads('min(52,99)', 52);
  reads('max(1,52)', 52);
  reads('gcd(104,156)', 52);
  reads('lcm(4,13)', 52);
  reads('hypot(3,4)', 5);
});

check('combinatorics', () => {
  reads('ncr(5,2)', 10);
  reads('choose(5,2)', 10);
  reads('npr(5,2)', 20);
  reads('fact(4)', 24);
});

check('constants', () => {
  reads('pi', Math.PI);
  reads('π', Math.PI);
  reads('2pi', Math.PI * 2);
  reads('tau', Math.PI * 2);
  reads('e', Math.E);
});

check('modulo, percent and absolute value', () => {
  reads('55%3', 1);          // binary: modulo
  reads('100%', 1);          // postfix: of one hundred
  reads('50% * 104', 52);
  reads('|-52|', 52);
});

check('other bases and scientific notation', () => {
  reads('0x34', 52);
  reads('0b110100', 52);
  reads('0o64', 52);
  reads('5.2e1', 52);
});

check('words', () => {
  reads('fifty two', 52);
  reads('fifty-two', 52);
  reads('one hundred', 100);
  reads('one hundred and one', 101);
  reads('20 plus 32', 52);
  reads('26 times 2', 52);
  reads('104 divided by 2', 52);
  reads('two squared', 4);
});

check('roman numerals', () => {
  reads('LII', 52);
  reads('L', 50);
  assert.strictEqual(C.romanToNumber('IIII'), null, 'IIII is not how 4 is written');
  assert.strictEqual(C.romanToNumber('IC'), null);
  assert.strictEqual(C.romanToNumber('MCMXCIV'), 1994);
  assert.strictEqual(C.romanToNumber('hello'), null);
});

check('nested and mixed', () => {
  reads('((2+3)*10)+2', 52);
  reads('2^5 + 20', 52);
  reads('-(-52)', 52);
  reads('sqrt(16)*13', 52);
  reads('1½*2', 3);
});

// ─── Safety ──────────────────────────────────────────────────────────────────
check('it is not eval — code is rejected, not run', () => {
  // This parses text any member of the server can write.
  global.__pwned = false;
  for (const s of ['process.exit(1)', 'global.__pwned=true', 'require("fs")',
                   'this.constructor.constructor("return 1")()', '__proto__', 'constructor']) {
    assert.strictEqual(C.evaluate(C.normalize(s)), null, `${s} should not evaluate`);
  }
  assert.strictEqual(global.__pwned, false);
});

check('a cheap-to-type, expensive-to-run expression is refused', () => {
  // `9^9^9^9` is eight characters. Without a budget it is a free way to stall
  // the process from inside a public channel.
  const t = Date.now();
  assert.strictEqual(C.evaluate('9^9^9^9'), null);
  assert.strictEqual(C.evaluate('999999999!'), null);
  assert.strictEqual(C.evaluate('(((((((((((1+1)))))))))))'.repeat(40)), null);
  assert.ok(Date.now() - t < 1000, 'the guards should be fast, not eventually-fast');
});

check('a huge result is not a count', () => {
  assert.strictEqual(C.evaluate('10^30'), null);
  assert.strictEqual(C.evaluate('170!'), null, '170! is finite but is not a number anyone is counting to');
});

check('division by zero is refused rather than reported as Infinity', () => {
  assert.strictEqual(C.evaluate('5/0'), null);
  assert.strictEqual(C.evaluate('5%0'), null);
});

check('an over-long message is not an expression', () => {
  assert.strictEqual(C.evaluate('1+'.repeat(400) + '1'), null);
  assert.strictEqual(C.readCount('1+'.repeat(400) + '1', 2).verdict, 'chatter');
});

check('malformed input is null, never a throw', () => {
  for (const s of ['(((', '5++', '*5', '5 5 5 )', '()', 'sqrt()', 'min()', '5,,3', '|5', '^2']) {
    assert.doesNotThrow(() => C.evaluate(s), `threw on ${JSON.stringify(s)}`);
  }
});

// --- Where the count is kept ------------------------------------------------
// Reported twice as "another reset for a CORRECT answer", and neither time was
// the evaluator wrong. The count was stored in counting.json under DATA_DIR,
// which defaults to the directory the bot runs from - INSIDE THE CONTAINER. A
// deploy built a new one without the file in it, the count silently became 0,
// and the next correct number was announced as a miscount that reset a streak
// nobody had broken. The high score went with it, so there was not even a
// record of what had been lost.
//
// These read the wiring out of index.js, because handleCountingMessage is not
// exported. They pin the RULE and not the wording: the count is written to and
// read back from Postgres, and the game refuses to judge before it knows.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');

check('the count is written to Postgres, not only to a file in the container', () => {
  assert.ok(/COUNTING_STATE/.test(src), 'nothing persists the count outside the container');
  const fn = src.slice(src.indexOf('function persistCounting'), src.indexOf('async function loadCountingFromDb'));
  assert.ok(/INSERT INTO config/.test(fn), 'the count is not written to the config table');
  assert.ok(/ON CONFLICT [(]guild_id, key[)] DO UPDATE/.test(fn),
    'the second save of a guild would collide instead of updating');
});

check('every save names the guild it is saving', () => {
  // saveCounting() with no argument writes the container-local file and nothing
  // else - which is the original bug, still there, just quieter.
  const sites = (src.match(/saveCounting[(][^)]*[)]/g) || []).filter(c => !/function/.test(c));
  assert.ok(sites.length >= 2, `only ${sites.length} save sites found`);
  for (const c of sites) assert.ok(/saveCounting[(]gid[)]/.test(c), `${c} does not persist`);
});

check('the saved count is read back before the bot can judge anyone', () => {
  const ready = src.slice(src.indexOf("client.once('ready'"));
  assert.ok(/await loadCountingFromDb[(][)]/.test(ready.slice(0, 2000)),
    'the count is never loaded from Postgres on boot');
  const load = src.slice(src.indexOf('async function loadCountingFromDb'));
  assert.ok(/FROM config/.test(load.slice(0, 600)), 'it does not read the table it writes');
});

const countingHandler = () => {
  const fn = src.slice(src.indexOf('async function handleCountingMessage'));
  return fn.slice(0, fn.indexOf('function getGuildData'));
};

check('a count that arrives before the state is known is not punished', () => {
  const body = countingHandler();
  assert.ok(/countingTruthKnown/.test(body), 'the handler judges against a state it may not have');
  assert.ok(body.indexOf('countingTruthKnown') < body.indexOf('state.count = 0'),
    'the streak is reset before the check that the state was ever loaded');
});

check('a channel mid-game with nothing saved is adopted, not reset', () => {
  const body = countingHandler();
  assert.ok(/countingData.has[(]gid[)]/.test(body),
    'the first count after a deploy is judged against 0 and announced as a miscount');
  assert.ok(body.indexOf('countingData.has(gid)') < body.indexOf('state.count = 0'),
    'the adoption is written after the reset, so it never runs');
});

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
