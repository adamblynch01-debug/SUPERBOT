// ─── test_sms_channel_split.js ───────────────────────────────────────────────
// "SMS VERIFY IS WHERE SMS MODAL IS POSTED. USER GENS #, SMS NUMBER GENERATED
// GOES TO THE 'SMS-NUMBER-GENERATED' CHANNEL. BUT BOTH IS GOING TO SAME
// CHANNEL."
//
// They are two channels doing two jobs: #sms-verify holds the panel a member
// clicks, #sms-number-generated holds the card with their number on it. The
// card was landing in #sms-verify, and #sms-number-generated was empty.
//
// Three separate ways that happened, all pinned below:
//
//   1. The panel field was labelled "Where the SMS generator runs", which reads
//      as "where the panel goes" — so it was set to the panel's own channel,
//      and the code loyally posted the card there.
//   2. Nothing configured fell through to an id that is one value for the whole
//      bot. `client.channels.fetch` is BOT-WIDE, so on the second server that
//      resolves to the FIRST server's channel and posts a member's number
//      somewhere they cannot see it. Same class as round 33.
//   3. There was no name lookup at all, so a server that had simply made the
//      channel and not filled a form got nothing from it.
//
//   node test_sms_channel_split.js
'use strict';

const assert = require('assert');
const sms = require('./modules/sms-gen');
const { resolveOrderChannel, usableIn, setSmsSettingsProvider, setSmsChannelFinder,
        SMS_ORDER_CHANNEL_NAME } = sms._internals;

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name); throw e; }
}

// ─── Fakes ───────────────────────────────────────────────────────────────────
const chan = (id, guildId) => ({ id, guildId, send: async () => ({ id: 'sent' }) });

function world(spec) {
  // spec: { guilds: { g1: ['a','b'] }, ... } — every channel knows its guild,
  // and the client can reach all of them, which is the whole problem.
  const all = new Map();
  const guilds = {};
  for (const [gid, ids] of Object.entries(spec)) {
    const cache = new Map();
    for (const id of ids) { const c = chan(id, gid); all.set(id, c); cache.set(id, c); }
    guilds[gid] = { id: gid, channels: { cache } };
  }
  const client = { channels: { fetch: async (id) => { const c = all.get(String(id)); if (!c) throw new Error('Unknown Channel'); return c; } } };
  return { client, guilds };
}

const interactionIn = (guild, channelId) => ({
  guild, channelId, channel: guild.channels.cache.get(channelId),
});

function configure({ panel = null, byName = null } = {}) {
  setSmsSettingsProvider(async () => ({ smsGenChannelId: panel }));
  setSmsChannelFinder(() => byName);
}

(async () => {

// ─── The setting, and the way it was misread ─────────────────────────────────
await check('a configured channel is where the card goes', async () => {
  const { client, guilds } = world({ G1: ['verify', 'numbers'] });
  configure({ panel: 'numbers' });
  const ch = await resolveOrderChannel(client, interactionIn(guilds.G1, 'verify'));
  assert.strictEqual(ch.id, 'numbers');
});

await check('the setting pointing at the panel channel is not obeyed', async () => {
  // This is the live symptom. Somebody read "Where the SMS generator runs" and
  // typed the channel the panel is in. The card would be posted next to the
  // panel and #sms-number-generated would stay empty forever, which is exactly
  // what was reported.
  const { client, guilds } = world({ G1: ['verify', 'numbers'] });
  configure({ panel: 'verify', byName: chan('numbers', 'G1') });
  const ch = await resolveOrderChannel(client, interactionIn(guilds.G1, 'verify'));
  assert.strictEqual(ch.id, 'numbers', 'the card is being posted in the panel channel');
});

// ─── Nothing configured ──────────────────────────────────────────────────────
await check('with nothing set, the channel is found by name in this server', async () => {
  const { client, guilds } = world({ G1: ['verify', 'numbers'] });
  configure({ byName: chan('numbers', 'G1') });
  const ch = await resolveOrderChannel(client, interactionIn(guilds.G1, 'verify'));
  assert.strictEqual(ch.id, 'numbers', 'a server that made the channel but filled no form gets nothing');
});

await check('the name it looks for is the one the channel actually has', async () => {
  assert.strictEqual(SMS_ORDER_CHANNEL_NAME, 'sms-number-generated');
});

await check('with nothing set and no such channel, the card still gets posted', async () => {
  // A number that has already cost real provider credit must never be dropped
  // because a channel is missing.
  const { client, guilds } = world({ G1: ['verify'] });
  configure({});
  const ch = await resolveOrderChannel(client, interactionIn(guilds.G1, 'verify'));
  assert.strictEqual(ch.id, 'verify');
});

// ─── The bot-wide fallback ───────────────────────────────────────────────────
await check('a channel in another server is never used, however it was reached', async () => {
  // `client.channels.fetch` resolves it perfectly well. That is the trap: it
  // does not fail, it succeeds at the wrong thing.
  const { client, guilds } = world({ G1: ['numbers'], G2: ['verify'] });
  configure({ panel: 'numbers' });   // left over from the first server
  const ch = await resolveOrderChannel(client, interactionIn(guilds.G2, 'verify'));
  assert.strictEqual(ch.guildId, 'G2', "a member's number was posted in a server they may not even be in");
});

await check('usableIn refuses a channel outside the asking guild', async () => {
  const { client, guilds } = world({ G1: ['a'], G2: ['b'] });
  assert.strictEqual(await usableIn(client, guilds.G2, 'a'), null);
  assert.ok(await usableIn(client, guilds.G2, 'b'));
  assert.strictEqual(await usableIn(client, guilds.G2, 'nope'), null, 'an id that resolves to nothing is not a channel');
  assert.strictEqual(await usableIn(client, guilds.G2, null), null);
});

await check('the second server prefers its own name match over a global id', async () => {
  const { client, guilds } = world({ G1: ['g1-numbers'], G2: ['verify', 'g2-numbers'] });
  configure({ panel: null, byName: chan('g2-numbers', 'G2') });
  process.env.SMS_GEN_CHANNEL_ID = 'g1-numbers';
  try {
    const ch = await resolveOrderChannel(client, interactionIn(guilds.G2, 'verify'));
    assert.strictEqual(ch.id, 'g2-numbers');
  } finally { delete process.env.SMS_GEN_CHANNEL_ID; }
});

// ─── The label that started it ───────────────────────────────────────────────
await check('the panel field no longer describes itself as where the generator runs', async () => {
  const src = require('fs').readFileSync('./modules/panel.js', 'utf8');
  const m = src.match(/\['sms_gen_channel_id',([^\]]*)\]/);
  assert.ok(m, 'the SMS channel field is gone from the panel');
  assert.ok(!/Where the SMS generator runs/.test(m[1]),
    'the field still reads as "where the panel goes", which is how it got set to the wrong channel');
  assert.ok(/POSTED/.test(m[1]), 'the field does not say it is a destination');
});

console.log(`\n${passed} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
