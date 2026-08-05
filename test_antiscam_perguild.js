// The panel has had five moderation inputs since it was written — warnings
// before ban, mute duration, spam limit, spam window, log channel. They
// validated, they saved to guild_settings, and the save toast said "Saved 19
// field(s)". Nothing read any of them. antiscam.js took its numbers from env at
// require time: ONE set of thresholds for the whole bot, no matter how many
// servers it was in.
//
// That is not a cosmetic gap. The bot is in two servers. LOG_CHANNEL_ID names a
// channel in the FIRST one, and guild.channels.cache.get() on the second one
// returns undefined rather than throwing — so moderation on the second server
// ran completely unlogged, forever, with no error line anywhere to notice.
//
//   node test_antiscam_perguild.js
'use strict';

// Set before requiring: ENV_MOD_CONFIG is built at module load, same as in
// production. These are the numbers the bot has actually been enforcing.
process.env.WARNINGS_BEFORE_BAN   = '3';
process.env.MUTE_DURATION_MINUTES = '30';
process.env.SPAM_MESSAGE_LIMIT    = '3';
process.env.SPAM_TIME_WINDOW      = '10';
process.env.LOG_CHANNEL_ID        = '111111111111111111';

const assert = require('assert');
const antiscam = require('./modules/antiscam');
const { modConfig, ENV_MOD_CONFIG, modKey, isSpamFlood, userScamTimes } = antiscam._config;

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

const G1 = '1242128831092101201';   // the server the env vars describe
const G2 = '1511517606954139711';   // the second server

main();
async function main() {

console.log('\nthe env values are the floor, not the law');

await check('with no provider installed, every guild gets the env numbers', async () => {
  const c = await modConfig(G2);
  assert.strictEqual(c.warningsBeforeBan, 3);
  assert.strictEqual(c.muteDurationMinutes, 30);
  assert.strictEqual(c.spamMessageLimit, 3);
  assert.strictEqual(c.spamTimeWindow, 10);
  assert.strictEqual(c.logChannelId, '111111111111111111');
});

await check('the log channel id stays a string', () => {
  // A Discord snowflake is 19 digits — bigger than Number.MAX_SAFE_INTEGER — so
  // parseInt rounds it (…341396 → …341400) and channels.cache.get() then misses
  // every single time. Moderation logs went nowhere for as long as this was a
  // number, and nothing about that failure is loud.
  assert.strictEqual(typeof ENV_MOD_CONFIG.logChannelId, 'string');
});

console.log('\na saved value wins, a blank one does not');

const SAVED = {};
antiscam.setModConfigProvider(async (gid) => SAVED[gid] || null);

await check('the second server gets its own log channel', async () => {
  SAVED[G2] = { logChannelId: '1512124609963622522' };
  const c = await modConfig(G2);
  assert.strictEqual(c.logChannelId, '1512124609963622522');
  // ...and the first server is untouched by it.
  assert.strictEqual((await modConfig(G1)).logChannelId, '111111111111111111');
});

await check('saved thresholds replace the env ones', async () => {
  SAVED[G2] = { warningsBeforeBan: 5, muteDurationMinutes: 120, spamMessageLimit: 8, spamTimeWindow: 60 };
  const c = await modConfig(G2);
  assert.strictEqual(c.warningsBeforeBan, 5);
  assert.strictEqual(c.muteDurationMinutes, 120);
  assert.strictEqual(c.spamMessageLimit, 8);
  assert.strictEqual(c.spamTimeWindow, 60);
});

await check('a null column does not blank the env value', async () => {
  // This is what an unwritten column reads as. Spreading it over the default
  // would leave the guild with no threshold at all — and `undefined >= x` is
  // false, so the ban would simply never fire and nothing would say why.
  SAVED[G2] = { warningsBeforeBan: null, muteDurationMinutes: undefined, logChannelId: null };
  const c = await modConfig(G2);
  assert.strictEqual(c.warningsBeforeBan, 3);
  assert.strictEqual(c.muteDurationMinutes, 30);
  assert.strictEqual(c.logChannelId, '111111111111111111');
});

await check('an empty input box does not blank it either', async () => {
  // The panel posts '' for a field the user cleared. Same requirement.
  SAVED[G2] = { logChannelId: '' };
  assert.strictEqual((await modConfig(G2)).logChannelId, '111111111111111111');
});

await check('a settings read that throws still yields a usable config', async () => {
  antiscam.setModConfigProvider(async () => { throw new Error('db is down'); });
  const c = await modConfig(G2);
  assert.strictEqual(c.warningsBeforeBan, 3);
  assert.strictEqual(c.logChannelId, '111111111111111111');
  antiscam.setModConfigProvider(async (gid) => SAVED[gid] || null);
});

console.log('\nwarnings belong to a member, not a person');

await check('the two maps are keyed by guild AND user', () => {
  assert.strictEqual(modKey(G1, '42'), `${G1}:42`);
  assert.notStrictEqual(modKey(G1, '42'), modKey(G2, '42'));
});

await check('a first offence on one server is a first offence on the other', () => {
  // Keyed on the user alone, three servers' worth of first offences got you
  // banned from a server you had never misbehaved in.
  const w = antiscam.userWarnings;
  w.clear();
  w.set(modKey(G1, '42'), 2);
  assert.strictEqual(w.get(modKey(G2, '42')) || 0, 0);
  assert.strictEqual(w.get(modKey(G1, '42')), 2);
  w.clear();
});

await check('a flood on one server does not trip the other', () => {
  userScamTimes.clear();
  const cfg = { spamMessageLimit: 3, spamTimeWindow: 10 };
  assert.strictEqual(isSpamFlood(G1, '42', cfg), false);
  assert.strictEqual(isSpamFlood(G1, '42', cfg), false);
  // Two on server one; the first on server two must not be the third.
  assert.strictEqual(isSpamFlood(G2, '42', cfg), false);
  // ...and the third on server one still is.
  assert.strictEqual(isSpamFlood(G1, '42', cfg), true);
  userScamTimes.clear();
});

await check('each guild floods at its OWN limit', () => {
  userScamTimes.clear();
  const strict = { spamMessageLimit: 2, spamTimeWindow: 10 };
  const loose  = { spamMessageLimit: 5, spamTimeWindow: 10 };
  assert.strictEqual(isSpamFlood(G1, '7', strict), false);
  assert.strictEqual(isSpamFlood(G1, '7', strict), true);
  for (let i = 0; i < 4; i++) assert.strictEqual(isSpamFlood(G2, '7', loose), false);
  assert.strictEqual(isSpamFlood(G2, '7', loose), true);
  userScamTimes.clear();
});

console.log('\nthe numbers the panel offers must be the numbers the bot uses');

await check('the schema defaults match antiscam\'s env defaults', () => {
  // They did not, and nothing read the columns so nothing noticed. Wiring the
  // columns up would have dropped the main server's mute from 30 minutes to 10
  // and loosened its spam trigger from 3 messages to 5, on deploy, with nobody
  // having touched a setting. A default nobody chose is not a policy.
  const sql = require('fs').readFileSync('schema.sql', 'utf8');
  const def = (col) => {
    const m = sql.match(new RegExp(`${col}\\s+INTEGER DEFAULT (\\d+)`));
    return m ? Number(m[1]) : null;
  };
  assert.strictEqual(def('warnings_before_ban'),   3);
  assert.strictEqual(def('mute_duration_minutes'), 30);
  assert.strictEqual(def('spam_message_limit'),    3);
  assert.strictEqual(def('spam_time_window'),      10);
});

await check('index.js hands all five fields to the provider', () => {
  // A field missing here is the original bug wearing a new hat: it saves, it
  // shows a green toast, and it does nothing.
  const src = require('fs').readFileSync('index.js', 'utf8');
  const block = src.slice(src.indexOf('antiscam.setModConfigProvider'), src.indexOf('support.setSupportSettingsProvider'));
  assert.ok(block.length > 100, 'the provider is not installed in index.js at all');
  for (const k of ['warningsBeforeBan', 'muteDurationMinutes', 'spamMessageLimit', 'spamTimeWindow', 'logChannelId']) {
    assert.ok(block.includes(k), `the provider never passes ${k}`);
  }
});

await check('getGuildSettings reads the seven columns that had no reader', () => {
  const src = require('fs').readFileSync('index.js', 'utf8');
  for (const col of ['log_channel_id', 'staff_role_id', 'ticket_log_channel',
                     'warnings_before_ban', 'mute_duration_minutes',
                     'spam_message_limit', 'spam_time_window']) {
    assert.ok(new RegExp(`row\\?\\.${col}`).test(src), `${col} is still write-only`);
  }
});

await check('the four numeric ones use ?? so that zero survives', () => {
  // 0 warnings before a ban means "ban on the first offence" and a 0-minute
  // mute means "delete only" — both are real choices, and both are falsy.
  const src = require('fs').readFileSync('index.js', 'utf8');
  for (const col of ['warnings_before_ban', 'mute_duration_minutes',
                     'spam_message_limit', 'spam_time_window']) {
    assert.ok(new RegExp(`row\\?\\.${col}\\s*\\?\\?`).test(src), `${col} uses || and would eat a 0`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}
