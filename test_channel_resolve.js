// Round 33 — why nothing worked on the second server, and where the invite
// panel had been going on the first.
//
// Two findings, one file:
//
//   1. The second server names its channels in MATHEMATICAL BOLD —
//      "📩︱𝐈𝐧𝐯𝐢𝐭𝐞𝐬". Those are letters to \p{L} and survived the strip, but
//      toLowerCase() has no mapping for them, so the normalized name stayed
//      "𝐈𝐧𝐯𝐢𝐭𝐞𝐬" and never equalled "invites". Every name-based fallback in the
//      bot resolved to nothing there, silently — which is most of what "how
//      everything not working properly as it should on second server" was.
//
//   2. One setting, invites_channel_id, served both the reward PANEL and the
//      join/leave LOG. On the main server it pointed at the log, so
//      /setup-invites buried the panel in the tracker. On the second it was
//      unset, so both fell back to the name and the log filled #invites.
//
// The functions live in index.js, which connects to Discord on require. They
// are lifted out of the source instead — so what is tested is the shipped text,
// and a rewrite that drops the normalize() call fails here.
//
//   node test_channel_resolve.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function lift(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.notStrictEqual(at, -1, `${name} is gone from index.js`);
  // Brace-match rather than regex: these bodies contain braces of their own.
  let i = SRC.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  return SRC.slice(at, end);
}

const { normalizeChannelName, findChannelByName, ChannelType } = new Function(
  `${lift('normalizeChannelName')}\n${lift('findChannelByName')}\n` +
  'const ChannelType = { GuildText: 0 };\n' +
  'return { normalizeChannelName, findChannelByName, ChannelType };'
)();

// The second server, read off the live guild on 2026-08-05.
const guild = (names) => ({
  channels: { cache: { values: () => names.map((n, i) => ({ id: String(i), name: n, type: 0 })) } },
});
const STORE = guild([
  '📩︱𝐈𝐧𝐯𝐢𝐭𝐞𝐬', '📊︱𝐈𝐍𝐕𝐈𝐓𝐄_𝐓𝐑𝐀𝐂𝐊𝐄𝐑', '👋︱𝐖𝐞𝐥𝐜𝐨𝐦𝐞', 'general',
  '💰︱𝐏𝐚𝐲𝐦𝐞𝐧𝐭-𝐦𝐞𝐭𝐡𝐨𝐝𝐬', '🌐︱𝐖𝐞𝐛𝐬𝐢𝐭𝐞', '💙︱𝐕𝐨𝐮𝐜𝐡𝐞𝐬', 'counting-game',
]);

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

console.log('\nfancy channel names resolve like the plain ones they imitate');

check('mathematical bold folds to ascii', () => {
  assert.strictEqual(normalizeChannelName('📩︱𝐈𝐧𝐯𝐢𝐭𝐞𝐬'), 'invites');
  assert.strictEqual(normalizeChannelName('👋︱𝐖𝐞𝐥𝐜𝐨𝐦𝐞'), 'welcome');
});

check('bold italic and other styled blocks too', () => {
  // ✅︱𝑮𝑬𝑻-𝑽𝑬𝑹𝑰𝑭𝑰𝑬𝑫 uses a different block again.
  assert.strictEqual(normalizeChannelName('✅︱𝑮𝑬𝑻-𝑽𝑬𝑹𝑰𝑭𝑰𝑬𝑫'), 'getverified');
});

check('an underscore and a hyphen are the same separator', () => {
  // The log channel is INVITE_TRACKER; the setting says invite-tracker.
  assert.strictEqual(normalizeChannelName('📊︱𝐈𝐍𝐕𝐈𝐓𝐄_𝐓𝐑𝐀𝐂𝐊𝐄𝐑'), normalizeChannelName('invite-tracker'));
});

check('a plain ascii name still normalizes to itself', () => {
  assert.strictEqual(normalizeChannelName('general'), 'general');
  assert.strictEqual(normalizeChannelName('counting-game'), 'countinggame');
});

console.log('\nthe panel and the log are two different channels');

check('#invites resolves to the panel channel, not the tracker', () => {
  const ch = findChannelByName(STORE, 'invites', 0);
  assert.ok(ch, 'nothing matched — this is the second-server bug');
  assert.strictEqual(ch.name, '📩︱𝐈𝐧𝐯𝐢𝐭𝐞𝐬');
});

check('#invite-tracker resolves to the log, not to #invites', () => {
  const ch = findChannelByName(STORE, 'invite-tracker', 0);
  assert.ok(ch, 'nothing matched');
  assert.strictEqual(ch.name, '📊︱𝐈𝐍𝐕𝐈𝐓𝐄_𝐓𝐑𝐀𝐂𝐊𝐄𝐑');
});

check('looking for "invites" never returns the tracker by contains', () => {
  // The contains fallback is loose on purpose. It must still not answer the
  // panel lookup with the log — that is exactly the channel pair in question.
  assert.strictEqual(findChannelByName(guild(['📊︱𝐈𝐍𝐕𝐈𝐓𝐄_𝐓𝐑𝐀𝐂𝐊𝐄𝐑']), 'invites', 0), null);
});

check('the two storefront panels find their channels', () => {
  // /setup-website and /setup-payments default to these by name. On server 2
  // both are styled, and before the NFKD fold both fell through to "post it in
  // whatever channel the command was typed in" — which is how a payment panel
  // ends up somewhere it was never meant to be.
  assert.strictEqual(findChannelByName(STORE, 'website', 0).name, '🌐︱𝐖𝐞𝐛𝐬𝐢𝐭𝐞');
  assert.strictEqual(findChannelByName(STORE, 'payment-methods', 0).name, '💰︱𝐏𝐚𝐲𝐦𝐞𝐧𝐭-𝐦𝐞𝐭𝐡𝐨𝐝𝐬');
});

check('an exact match wins over a substring one', () => {
  const g = guild(['𝐖𝐞𝐥𝐜𝐨𝐦𝐞-𝐚𝐫𝐜𝐡𝐢𝐯𝐞', '👋︱𝐖𝐞𝐥𝐜𝐨𝐦𝐞']);
  assert.strictEqual(findChannelByName(g, 'welcome', 0).name, '👋︱𝐖𝐞𝐥𝐜𝐨𝐦𝐞');
});

console.log('\nthe two settings are wired to different things');

check('index.js reads a separate id for the log', () => {
  assert.ok(/INVITE_LOG_CHANNEL_ID/.test(SRC), 'the log channel has no setting of its own');
  assert.ok(/inviteLogChannelId:\s*row\?\.invite_log_channel_id/.test(SRC),
    'guild_settings.invite_log_channel_id is not read');
});

check('join and leave announcements go through the log resolver', () => {
  // Both handlers, and neither reaching for invitesChannelId any more.
  const uses = SRC.match(/const ch = inviteLogChannel\(member\.guild, settings\);/g) || [];
  assert.strictEqual(uses.length, 2, `expected join and leave, found ${uses.length}`);
});

check('the log resolver does not fall back to the panel channel', () => {
  const body = lift('inviteLogChannel');
  assert.ok(!/invitesChannel/.test(body),
    'the log still falls back to #invites — that is the second-server symptom');
});

check('/setup-invites still posts to the panel channel', () => {
  assert.ok(/let invCh = \(settings\.invitesChannelId/.test(SRC));
});

check('the panel can set both ids', () => {
  const panel = fs.readFileSync(path.join(__dirname, 'modules', 'panel.js'), 'utf8');
  assert.ok(/'invite_log_channel_id'/.test(panel), 'not in SETTINGS_ALLOWED');
  assert.ok(/\['invite_log_channel_id',/.test(panel), 'not in the settings form');
});

console.log(`\n${passed} passed, ${failed} failed`);
