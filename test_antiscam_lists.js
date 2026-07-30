// ─── test_antiscam_lists.js ──────────────────────────────────────────────────
// The allow-list added for klipy.com is the only part of the anti-scam module
// that can be turned INSIDE OUT by a hostile input: a naive `includes()` check
// would let `klipy.com.evil.ru` through, which is worse than having no
// allow-list at all. These assertions pin that down, plus the rule that an
// allowed link must not launder a scam pitch pasted beside it.
//
//   node test_antiscam_lists.js
'use strict';

const { _internals, ALLOWED_LINKS } = require('./modules/antiscam');
const { stripAllowedLinks, isAllowedUrl, hasProfanity, hasBannedLink } = _internals;

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

section('allow-list hostname matching');
ok('klipy.com is allowed',                       isAllowedUrl('https://klipy.com/gif/123'));
ok('a subdomain of an allowed host is allowed',  isAllowedUrl('https://cdn.klipy.com/x.gif'));
ok('bare hostname (no scheme) is allowed',       isAllowedUrl('klipy.com/gif/123'));
ok('a lookalike SUFFIX is NOT allowed',          !isAllowedUrl('https://klipy.com.evil.ru/x'));
ok('a lookalike PREFIX is NOT allowed',          !isAllowedUrl('https://evilklipy.com/x'));
ok('the domain in a path is NOT allowed',        !isAllowedUrl('https://evil.ru/klipy.com'));
ok('an unrelated host is not allowed',           !isAllowedUrl('https://stake.com'));

section('stripping, not skipping');
const scamPitch = 'promo code CENAT — claim your bonus at https://stake.com';
const withGif   = `https://klipy.com/gif/abc ${scamPitch}`;
ok('the allowed gif link is removed',            !stripAllowedLinks(withGif).includes('klipy.com'));
ok('the scam pitch beside it SURVIVES',          hasBannedLink(stripAllowedLinks(withGif)).found);
ok('a banned link is left untouched',            stripAllowedLinks('go to stake.com now').includes('stake.com'));
ok('a lookalike is left for the scanner',        stripAllowedLinks('http://klipy.com.evil.ru/x').includes('evil.ru'));
ok('plain text is unchanged',                    stripAllowedLinks('hello there') === 'hello there');
ok('empty/nullish input does not throw',         stripAllowedLinks(null) === '' && stripAllowedLinks(undefined) === '');

section('a message that is ONLY an allowed gif');
const gifOnly = stripAllowedLinks('https://tenor.com/view/funny-gif-123');
ok('nothing bannable is left behind',            !hasBannedLink(gifOnly).found && !hasProfanity(gifOnly).found);

section('banned words report WHICH word matched');
const hit = hasProfanity('you are a bitch');
ok('a match reports found',                      hit.found === true);
ok('and names the word, for the mod log',        typeof hit.word === 'string' && hit.word.length > 0);
ok('word boundaries hold (no substring hits)',   !hasProfanity('classic').found && !hasProfanity('scunthorpe').found);
ok('a clean message is clean',                   hasProfanity('good morning everyone').found === false);

section('defaults');
ok('klipy.com ships in the allow-list',          ALLOWED_LINKS.includes('klipy.com'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
