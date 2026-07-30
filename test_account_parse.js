// ─── test_account_parse.js ───────────────────────────────────────────────────
// The delivery DM either labels a buyer's credentials or dumps them as one
// undelimited blob, and the difference is entirely whether this parser matched.
// It used to insist on `user:pass|email:emailpass` and return null otherwise —
// while every account actually in stock is written with plain colons, so the
// raw-blob fallback was the only path that ever ran.
//
// The hard case is that a colon is both the separator AND legal inside a
// password, so the assertions below pin the email-anchored split rather than
// counting fields.
//
//   node test_account_parse.js
'use strict';

// The parser is defined in index.js, which connects to Discord and Postgres on
// load. Pulling the one function out by source is uglier than an export, but
// importing index.js here would start a bot.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
const start = src.indexOf('function parseStockAccountLine(');
if (start === -1) { console.error('parseStockAccountLine not found in index.js'); process.exit(1); }
// Walk braces to the end of the function so this survives edits to its body.
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const parseStockAccountLine = new Function(src.slice(start, end) + '; return parseStockAccountLine;')();

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

section('the format that is actually in stock');
// Straight from the screenshot the user sent.
const real = parseStockAccountLine('shyWasp58160:4J5mVFHgdK1n:MichenerExel48@hotmail.com:7ZNAC7qEh');
ok('a colon-separated line parses at all', !!real);
ok('username',       real && real.username === 'shyWasp58160');
ok('password',       real && real.password === '4J5mVFHgdK1n');
ok('email',          real && real.email === 'MichenerExel48@hotmail.com');
ok('email password', real && real.emailPassword === '7ZNAC7qEh');
ok('no phantom extra field', real && real.extra === null);

section('the pipe format still works');
const piped = parseStockAccountLine('bob:hunter2|bob@mail.com:mailpass');
ok('username', piped && piped.username === 'bob');
ok('password', piped && piped.password === 'hunter2');
ok('email',    piped && piped.email === 'bob@mail.com');
ok('email password', piped && piped.emailPassword === 'mailpass');

section('a colon inside the password does not shift every field');
// The whole reason the split anchors on the email instead of counting parts.
const colonPass = parseStockAccountLine('user1:pa:ss:word:user1@mail.com:mp');
ok('username stays first',        colonPass && colonPass.username === 'user1');
ok('password keeps its colons',   colonPass && colonPass.password === 'pa:ss:word');
ok('email is still the email',    colonPass && colonPass.email === 'user1@mail.com');
ok('email password is not eaten', colonPass && colonPass.emailPassword === 'mp');

section('short and odd lines');
const bare = parseStockAccountLine('onlyuser:onlypass');
ok('user:pass parses',            bare && bare.username === 'onlyuser' && bare.password === 'onlypass');
ok('and reports no email rather than an empty one', bare && bare.email === null);
ok('and no email password',       bare && bare.emailPassword === null);

const emailLogin = parseStockAccountLine('me@mail.com:secret');
ok('an email-as-login is not mislabelled a username', emailLogin && emailLogin.email === 'me@mail.com');
ok('and its password is right',   emailLogin && emailLogin.password === 'secret');

section('nothing is silently dropped');
const extra = parseStockAccountLine('u:p:u@m.com:mp:STEAMGUARDSECRET');
ok('trailing data is kept, not lost', extra && extra.extra === 'STEAMGUARDSECRET');
ok('and does not corrupt the email password', extra && extra.emailPassword === 'mp');

const phoned = parseStockAccountLine('u:p:u@m.com:mp (+1 555 0100)');
ok('a trailing (phone) is split off',  phoned && phoned.phone === '+1 555 0100');
ok('and is not left on the email pw',  phoned && phoned.emailPassword === 'mp');

section('genuinely unparseable input still returns null');
ok('empty string',      parseStockAccountLine('') === null);
ok('whitespace only',   parseStockAccountLine('   ') === null);
ok('no separator',      parseStockAccountLine('justonetoken') === null);
ok('not a string',      parseStockAccountLine(null) === null && parseStockAccountLine(undefined) === null);
ok('a null return is what triggers the raw-blob fallback, so it must stay reachable',
   parseStockAccountLine('a-single-word-with-no-colon') === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
