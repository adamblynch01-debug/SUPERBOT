// ─── test_status_panel_perguild.js ───────────────────────────────────────────
// "/POST-STATUS KEEPS GETTING DELETED FOR SOME REASON. LIKE IF I DO
// /POST-STATUS ON ONE SERVER, NOW WHEN I POST ON ONE SECOND SERVER IT GETS
// REMOVE ON THE OTHER SERVER."
//
// It was doing exactly what it was written to do. The panel reference lived
// under a single backend key, `status`, holding one channel id and one list of
// message ids. Posting on the second server read that key, found the FIRST
// server's messages, deleted them as "the previous panel", and wrote itself
// over the key. Two servers could never hold a panel at once, and the server
// that lost one was never told.
//
// This is the same shape as the bug in round 33 (`client.channels.fetch` is
// bot-wide): state that reads as "the bot's panel" when it means "this
// server's panel". So what is pinned here is the KEYING, in both directions —
// that every read and write carries a guild, and that the refresher visits
// every guild rather than the first one it finds.
//
//   node test_status_panel_perguild.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name); throw e; }
}

// Comments in this area quote the very rules being pinned, so they would
// satisfy a source check while the code below them broke it.
const nocomments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

function slice(from, to) {
  const a = src.indexOf(from);
  assert.ok(a > 0, `${from} not found in index.js — re-point this test`);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `${to} not found after ${from}`);
  return nocomments(src.slice(a, b));
}

// ─── The key itself ──────────────────────────────────────────────────────────
const statusKind = (() => {
  const m = src.match(/const statusKind = \(guildId\) => (.+);/);
  assert.ok(m, 'statusKind is gone — the panel key is no longer built in one place');
  // eslint-disable-next-line no-new-func
  return new Function('guildId', `const LEGACY_STATUS_KIND = 'status'; return ${m[1]};`);
})();

check('two servers get two different keys', () => {
  assert.notStrictEqual(statusKind('1242128831092101201'), statusKind('1511517606954139711'));
});

check('the key still says what it is, so an old blob stays readable', () => {
  assert.ok(statusKind('123').startsWith('status:'),
    'the refresher finds panels by this prefix — changing it strands every posted panel');
  assert.strictEqual(statusKind('123'), 'status:123');
});

check('no guild is not the same key as some guild', () => {
  // A missing guildId must not collapse onto the legacy key and start
  // stomping a real panel again.
  assert.notStrictEqual(statusKind(undefined), 'status');
});

// ─── Every read and every write carries a guild ──────────────────────────────
check('the panel reference cannot be read without saying which server', () => {
  assert.ok(/async function loadStatusPanelRef\(guildId\)/.test(src),
    'loadStatusPanelRef takes no guild — this is the original bug');
});

check('the panel reference cannot be written without saying which server', () => {
  assert.ok(/async function saveStatusPanelRef\(guildId, channelId, messageIds\)/.test(src),
    'saveStatusPanelRef takes no guild — a save would land on whatever key is hardcoded');
});

check('no call site forgot the guild argument', () => {
  const body = nocomments(src);
  const loads = [...body.matchAll(/loadStatusPanelRef\(([^)]*)\)/g)].map(m => m[1].trim());
  const saves = [...body.matchAll(/saveStatusPanelRef\(([^)]*)\)/g)].map(m => m[1].trim());
  for (const a of loads) {
    if (a === 'guildId') continue;
    assert.ok(a.length > 0, 'loadStatusPanelRef is being called with no guild');
  }
  for (const a of saves) {
    assert.ok(a.split(',').length === 3, `saveStatusPanelRef(${a}) is missing an argument`);
  }
  assert.ok(saves.length >= 3, 'the save call sites vanished — re-point this test');
});

check('/post-status looks up and writes THIS guild', () => {
  const body = slice("if (cmd === 'post-status') {", "if (cmd === 'post-status-vault')");
  assert.ok(/loadStatusPanelRef\(interaction\.guildId\)/.test(body),
    'the command reads the panel without a guild, so it will find another server\'s and delete it');
  assert.ok(/saveStatusPanelRef\(interaction\.guildId,/.test(body),
    'the command saves the panel without a guild');
});

// ─── The refresher visits every server ───────────────────────────────────────
check('the unchanged-check is per guild, not one variable for the whole bot', () => {
  assert.ok(/const statusPanelSignatures = new Map\(\)/.test(src),
    'one signature for every server means the second server\'s panel is skipped as "unchanged"');
  assert.ok(!/\blet statusPanelSignature\b/.test(src), 'the old single signature is still there');
});

check('the refresher picks up every guild that has a panel', () => {
  const body = slice('async function refreshStatusPanel(', 'async function refreshOneStatusPanel(');
  const m = body.match(/const targets = ([\s\S]*?);\n/);
  assert.ok(m, 'the target list is gone — re-point this test');
  const pick = new Function('panels', `
    const LEGACY_STATUS_KIND = 'status';
    return ${m[1]};
  `);
  const targets = pick({
    'status:AAA': { channel_id: 'c1', message_ids: ['m1'] },
    'status:BBB': { channel_id: 'c2', message_ids: ['m2', 'm3'] },
    'status:CCC': { channel_id: null, message_ids: [] },   // forgotten
    'status:DDD': { channel_id: 'c4', message_ids: [] },   // never finished posting
    'vault': { channel_id: 'c9', message_ids: ['m9'] },    // a different panel entirely
    'status': { channel_id: 'c0', message_ids: ['m0'] },   // the legacy key
  });
  assert.deepStrictEqual(targets.map(t => t.guildId).sort(), ['AAA', 'BBB'],
    'the refresher is not visiting exactly the servers that have a live panel');
});

check('one server failing does not stop the next', () => {
  const body = slice('async function refreshStatusPanel(', 'async function refreshOneStatusPanel(');
  assert.ok(/for \(const \{ guildId, ref \} of targets\)/.test(body), 'the per-guild loop is gone');
  const loop = body.slice(body.indexOf('for (const { guildId, ref } of targets)'));
  assert.ok(/try \{[\s\S]*catch/.test(loop),
    'a throw in one guild would abandon every guild after it — they are separate servers');
});

check('forgetting a dead panel forgets only that server\'s', () => {
  const body = slice('async function refreshOneStatusPanel(', '// ─── Announced status');
  for (const m of body.matchAll(/saveStatusPanelRef\(([^,]+),\s*null/g)) {
    assert.strictEqual(m[1].trim(), 'guildId',
      'a dead channel on one server is clearing the panel reference of another');
  }
  assert.ok(/statusPanelSignatures\.delete\(guildId\)/.test(body),
    'the signature outlives the panel it described, so a re-post would be skipped as unchanged');
});

// ─── The panel posted before any of this existed ─────────────────────────────
check('the old shared panel is adopted, not orphaned', () => {
  const body = slice('async function adoptLegacyStatusPanel(', 'async function refreshStatusPanel(');
  assert.ok(/channels\.fetch\(legacy\.channel_id\)/.test(body)
    && /ch && ch\.guildId/.test(body),
    'the guild is being guessed rather than asked of the channel — guessing wrong adopts one server\'s panel into another');
  assert.ok(/!panels\[statusKind\(guildId\)\]/.test(body),
    'adoption would overwrite a panel that server has already posted properly');
  assert.ok(/delete panels\[LEGACY_STATUS_KIND\]/.test(body),
    'the legacy key is left behind, so it is adopted again on every single tick');
});

console.log(`\n${passed} checks passed`);
