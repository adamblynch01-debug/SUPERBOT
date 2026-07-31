// ─── test_status_categories.js ───────────────────────────────────────────────
// The website's Downloads page listed 53 products while its Status page listed
// 63, for one catalog. The rule that settles it — accounts, custom orders and
// services carry no software build, so they belong on neither — now lives in
// the storefront AND here, because /post-status is documented as being "in
// sync w/ site" and a filter applied on only one side just moves the mismatch
// into Discord.
//
// So this pins the category list itself, not just the function: if the
// storefront's window.NON_SOFTWARE_CATEGORIES changes, this has to change too.
//
//   node test_status_categories.js
'use strict';

// Defined in index.js, which connects to Discord and Postgres on load — pull
// the constant + function out by source rather than starting a bot.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

const cStart = src.indexOf('const NON_STATUS_CATEGORIES');
if (cStart === -1) { console.error('NON_STATUS_CATEGORIES not found in index.js'); process.exit(1); }
const fStart = src.indexOf('function isNonStatusCategory(', cStart);
if (fStart === -1) { console.error('isNonStatusCategory not found in index.js'); process.exit(1); }
let depth = 0, end = -1;
for (let i = src.indexOf('{', fStart); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const chunk = src.slice(cStart, end);
const { isNonStatusCategory, NON_STATUS_CATEGORIES } =
  new Function(chunk + '; return { isNonStatusCategory, NON_STATUS_CATEGORIES };')();

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name); process.exitCode = 1; }
}

console.log('\nstatus categories — accounts / custom order / services only');

// ── The three the user named, and nothing wider ──────────────────────────────
check('the list is exactly the three named categories',
  NON_STATUS_CATEGORIES.length === 3 &&
  ['accounts', 'services', 'custom order'].every(c => NON_STATUS_CATEGORIES.includes(c)));

for (const c of ['Accounts', 'accounts', 'ACCOUNTS', 'Services', 'SERVICES', 'Custom Order', 'CUSTOM ORDER']) {
  check(`'${c}' is excluded`, isNonStatusCategory(c) === true);
}

// The storefront's custom-order banner is labelled several ways; all of them
// name the same non-software thing.
check("'Donation / Custom Order' is excluded", isNonStatusCategory('Donation / Custom Order') === true);
check("'Donation' is excluded", isNonStatusCategory('Donation') === true);

// ── Every real game category stays ───────────────────────────────────────────
// These are the live categories from /api/products; all of them ship a build.
const KEEP = [
  'Call of Duty: Warzone', 'Fortnite', 'Apex Legends', 'Arc Raiders', 'Rust',
  'Escape From Tarkov', 'GTA V', 'HWID Spoofer', 'Valorant', 'DayZ',
  'Delta Force', 'Marvel Rivals', 'Battlefield 2042', 'CS2 / CSGO',
  'Sea of Thieves', 'Active Matter', 'ARK Ascended', 'Dark & Darker',
  'Dead by Daylight', 'Deadside', 'Dune Awakening', 'Farlight 84',
  'Gray Zone Warfare', 'Hell Let Loose', 'Hunt Showdown', 'Off The Grid',
  'SCUM', 'Squad', 'War Thunder', 'Arena Breakout Infinite',
];
for (const g of KEEP) check(`'${g}' is kept`, isNonStatusCategory(g) === false);

// HWID Spoofer is the trap: it isn't a game, but it IS a downloadable build,
// so it must not get swept up with "services".
check('HWID Spoofer is not treated as a service', isNonStatusCategory('HWID Spoofer') === false);

// ── Nothing throws on the empty / missing cases ──────────────────────────────
check('an empty category is kept, not excluded', isNonStatusCategory('') === false);
check('null does not throw', isNonStatusCategory(null) === false);
check('undefined does not throw', isNonStatusCategory(undefined) === false);
check('whitespace is trimmed', isNonStatusCategory('  Services  ') === true);

// ── The counts the user reported ─────────────────────────────────────────────
// 63 products in status, of which 6 are Services → 57 on both pages.
const LIVE = [].concat(
  Array(6).fill('Services'),
  Array(6).fill('Call of Duty: Warzone'),
  Array(6).fill('Fortnite'),
  Array(45).fill('Rust'),
);
check('63 live products filter down to 57',
  LIVE.length === 63 && LIVE.filter(g => !isNonStatusCategory(g)).length === 57);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
