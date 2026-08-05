// Round 33 — "everyhting on web panel does not cover evrything , all the channel
// id setting etc.. second server has all the same channels but ofc different
// channel id as is a different server."
//
// The complaint is structural, not cosmetic. Every channel below existed only as
// an env var, and an env var is one value for the whole process while the bot is
// in two servers. Worse, client.channels.fetch is BOT-WIDE: it resolves a
// channel in any guild the bot is in without complaint. So the second server's
// restocks, orders, gen logs and hand-delivered orders were not failing — they
// were being posted into the FIRST server's channels.
//
// What this file pins is the chain, end to end, because each link on its own
// looks finished and the gap between two of them is invisible:
//
//   column exists → panel allows it → panel renders a picker for it
//     → getGuildSettings reads it → a module actually consumes it
//
// The last arrow is the one that broke last time. Seven columns had existed
// since the panel was written; the panel validated them, saved them and said
// "Saved 19 field(s)"; nothing read them. A field that saves, shows a green
// toast and does nothing is worse than a missing one — a missing one at least
// looks missing.
//
//   node test_panel_settings.js
'use strict';

const assert = require('assert');
const fs = require('fs');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// Comments stripped everywhere below. A module that documents the bug it avoids
// by quoting the broken shape must not fail a scan that cannot tell an
// explanation from the thing it explains. The [^:] guard keeps https:// intact.
const read = (f) => fs.readFileSync(f, 'utf8');
const code = (f) => (f.endsWith('.sql')
  ? read(f).replace(/--.*$/gm, '')
  : read(f).replace(/(^|[^:])\/\/.*$/gm, '$1'));

const PANEL   = read('modules/panel.js');
const INDEX   = code('index.js');
const SCHEMA  = read('schema.sql');
const MIGRATE = read('migrations/panel_channel_coverage.sql');

// [column, camelCase key in getGuildSettings, the file that consumes it]
const NEW = [
  ['orders_channel_id',          'ordersChannelId',         'modules/internalEvents.js'],
  ['restock_channel_id',         'restockChannelId',        'modules/internalEvents.js'],
  ['vault_restock_channel_id',   'vaultRestockChannelId',   'modules/internalEvents.js'],
  ['manual_delivery_channel_id', 'manualDeliveryChannelId', 'modules/manualDelivery.js'],
  ['sms_gen_channel_id',         'smsGenChannelId',         'modules/sms-gen.js'],
  ['gen_log_channel_id',         'genLogChannelId',         'modules/genLog.js'],
  ['alerts_channel_id',          'alertsChannelId',         'modules/internalEvents.js'],
  ['rank_boost_log_channel',     'rankBoostLogChannel',     'modules/support.js'],
  ['rank_boost_role_id',         'rankBoostRoleId',         'modules/support.js'],
  ['ticket_staff_role_id',       'ticketStaffRoleId',       'modules/support.js'],
  ['customer_role_id',           'customerRoleId',          'index.js'],
];

console.log('\nthe column exists, in both places');

check('the migration adds every one of them', () => {
  for (const [col] of NEW) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\b`).test(MIGRATE), col);
  }
});

check('and a fresh database gets them too', () => {
  // A migration alone means schema.sql and production drift, and the next
  // person to run schema.sql on a new database gets a panel whose save 500s.
  for (const [col] of NEW) {
    assert.ok(new RegExp(`^\\s+${col}\\s+TEXT`, 'm').test(SCHEMA), `${col} missing from schema.sql`);
  }
});

check('TEXT, never BIGINT', () => {
  // A snowflake is 19 digits, past Number.MAX_SAFE_INTEGER. Round-trip one
  // through a JS number and it comes back subtly wrong (…341396 → …341400),
  // after which every lookup silently misses. That has cost a round already.
  for (const [col] of NEW) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\s+TEXT;`).test(MIGRATE), `${col} is not TEXT`);
  }
});

console.log('\nthe panel will accept and show it');

check('every column is in the save allow-list', () => {
  const allow = PANEL.slice(PANEL.indexOf('const SETTINGS_ALLOWED'), PANEL.indexOf('const SETTINGS_NUMERIC'));
  for (const [col] of NEW) assert.ok(allow.includes(`'${col}'`), `${col} cannot be saved`);
});

check('every column has a field in the form', () => {
  const groups = PANEL.slice(PANEL.indexOf('var SETTINGS_GROUPS'), PANEL.indexOf('var SETTINGS_FIELDS = []'));
  for (const [col] of NEW) assert.ok(groups.includes(`'${col}'`), `${col} has no field in the UI`);
});

check('a snowflake field is validated as digits, whatever it is named', () => {
  // ticket_log_channel does not end in _id. It was a hand-written special case,
  // rank_boost_log_channel would have been a second one, and a snowflake that
  // slips past the check is stored as free text and then never resolves.
  assert.ok(/key\.endsWith\('_id'\) \|\| key\.endsWith\('_channel'\)/.test(PANEL),
    'the validator went back to naming columns one at a time');
});

check('every field declares a kind the renderer understands', () => {
  const groups = PANEL.slice(PANEL.indexOf('var SETTINGS_GROUPS'), PANEL.indexOf('var SETTINGS_FIELDS = []'));
  const kinds = groups.match(/',\s*'(channel|role|grant|number)',/g) || [];
  const fields = groups.match(/\n\s+\['[a-z_]+',/g) || [];
  assert.strictEqual(kinds.length, fields.length,
    `${fields.length} fields but ${kinds.length} recognised kinds — a typo'd kind renders as a text box`);
  assert.ok(fields.length >= 29, `only ${fields.length} settings in the form`);
});

check('the role picker offers roles above the bot, and flags them', () => {
  // Staff / OVERSEER / Ticket Staff / Rank Booster are only ever TESTED for
  // (member.roles.cache.has), and those are exactly the roles an admin keeps
  // above the bot. Filtering them out left the field unusable, which is why
  // people were pasting ids by hand.
  assert.ok(/assignable: !r\.managed && r\.position < top/.test(PANEL),
    '/roles no longer reports assignability');
  assert.ok(!/\.filter\(r => r\.position < top\)/.test(PANEL),
    '/roles is filtering on hierarchy again');
});

check('but a role the bot must GRANT is filtered to the assignable ones', () => {
  assert.ok(/kind === 'grant' && !o\.assignable/.test(PANEL),
    "a 'grant' field would offer a role the bot cannot hand out");
  assert.ok(/d\.roles\.filter\(function\(r\) \{\s*return r\.assignable;/.test(PANEL),
    'the Keys tab lost its assignable filter — a key for an unassignable role fails at /redeem');
});

check('a saved id this server does not have is kept, not silently blanked', () => {
  // Blanking it would read as "not set", and the next save would then genuinely
  // unset it — losing a setting by opening the page.
  assert.ok(/not in this server/.test(PANEL), 'an unknown saved id is dropped from the picker');
  assert.ok(/if \(saved && !found\)/.test(PANEL), 'nothing preserves an unmatched saved value');
});

console.log('\nthe bot reads it');

check('getGuildSettings returns every column', () => {
  for (const [col, key] of NEW) {
    assert.ok(new RegExp(`${key}:\\s*row\\?\\.${col}`).test(INDEX), `${key} is not read from ${col}`);
  }
});

check('and returns null rather than the env value', () => {
  // Env-defaulting these on the original guild would be the bug, not the fix:
  // the second server would inherit the first server's channel ids. null means
  // "the panel has nothing to say about this guild" and each module then applies
  // its own env fallback, so the original server is untouched.
  for (const [col, key] of NEW) {
    const line = INDEX.split('\n').find(l => l.includes(`${key}:`) && l.includes(col));
    assert.ok(line && /\|\|\s*null,?\s*$/.test(line.trim()), `${key} is env-defaulted: ${line}`);
  }
});

check('the ticket rota is not the money gate', () => {
  // staff_role_id gates /web-balance, /addstock, /clearstock and /giveaway.
  // Ticket staff need Reply and Close. Falling back from one to the other would
  // hand the till to everyone on the ticket rota.
  assert.ok(/ticketStaffRoleId:\s*s\.ticketStaffRoleId/.test(INDEX),
    'the ticket-staff role is being served from staff_role_id again');
});

check('no provider still hardcodes null where a column now exists', () => {
  assert.ok(!/rankBoostLogChannel:\s*null/.test(INDEX), 'rankBoostLogChannel is still stubbed');
  assert.ok(!/rankBoostRoleId:\s*null/.test(INDEX), 'rankBoostRoleId is still stubbed');
});

console.log('\nsomething actually consumes it');

check('every column has a reader', () => {
  // The whole point. Adding a column and a form field is half the job: the other
  // half is a module that reads it, and nothing about the first half looks
  // unfinished without the second.
  for (const [col, key, file] of NEW) {
    const src = code(file);
    assert.ok(src.includes(key) || src.includes(`'${col}'`),
      `${col} saves and shows a green toast, but ${file} never reads it`);
  }
});

check('each consumer is installed with a provider', () => {
  for (const setter of [
    'setModConfigProvider', 'setSupportSettingsProvider',
    'setGenLogSettingsProvider', 'setManualSettingsProvider', 'setSmsSettingsProvider',
  ]) {
    assert.ok(new RegExp(`${setter}\\(`).test(INDEX), `${setter} is never called`);
  }
});

check('the order log keeps exactly one source of truth', () => {
  // Settled in July: ORDER_LOG_CHANNEL_ID is a Railway variable, it carries
  // customer emails, and there is deliberately no panel field for it. The
  // panel's orders_channel_id therefore sits BELOW it in the chain and above
  // the bot-wide ORDERS_CHANNEL_ID env var, which is the position that matters.
  const allow = PANEL.slice(PANEL.indexOf('const SETTINGS_ALLOWED'), PANEL.indexOf('const SETTINGS_NUMERIC'));
  assert.ok(!allow.includes('order_log_channel'), 'a panel field for ORDER_LOG_CHANNEL_ID appeared');
  assert.ok(!SCHEMA.includes('order_log_channel'), 'ORDER_LOG_CHANNEL_ID got a column');

  const ev = code('modules/internalEvents.js');
  const chain = ev.slice(ev.indexOf('const ordersChannel'), ev.indexOf('const alertsChannel'));
  assert.ok(chain.indexOf('orderLogEnv()') < chain.indexOf("'orders_channel_id'"),
    'the panel now overrides ORDER_LOG_CHANNEL_ID');
});

check('a per-guild value is ahead of every bot-wide one', () => {
  const ev = code('modules/internalEvents.js');
  for (const [chain, col, env] of [
    ['const restockChannel',      'restock_channel_id',       'RESTOCK_CHANNEL_ID'],
    ['const vaultRestockChannel', 'vault_restock_channel_id', 'VAULT_RESTOCK_CHANNEL_ID'],
    ['const manualChannel',       'manual_delivery_channel_id', 'MANUAL_DELIVERY_CHANNEL_ID'],
  ]) {
    const at = ev.indexOf(chain);
    const body = ev.slice(at, ev.indexOf(']);', at));
    assert.ok(body.indexOf(`'${col}'`) !== -1, `${chain} does not consult ${col}`);
    assert.ok(body.indexOf(`'${col}'`) < body.indexOf(env),
      `${chain} checks the bot-wide ${env} before this guild's own setting`);
  }
});

check('no support_channel_id anywhere — it would have had no reader', () => {
  // /panel posts the ticket panel into the channel it is run in. A column for
  // it would save, report success and change nothing.
  for (const f of ['schema.sql', 'migrations/panel_channel_coverage.sql', 'modules/panel.js', 'index.js']) {
    assert.ok(!/support_channel_id/.test(code(f)), `support_channel_id is back in ${f}`);
  }
  assert.ok(!/const SUPPORT_CHANNEL\s*=/.test(code('modules/support.js')),
    'the unread SUPPORT_CHANNEL const is back');
});

console.log('\nthe async guards that a passing suite cannot see');

check('resolveCustomerRole is awaited at every call site', () => {
  // It reads guild settings now, so it returns a Promise. `if (!role)` on a
  // Promise is always false — the claim would then try to grant a Promise as a
  // role and report a failure nobody can act on.
  const calls = INDEX.match(/[\w. ]*resolveCustomerRole\(interaction\.guild\)/g) || [];
  assert.ok(calls.length >= 2, `only ${calls.length} call sites found`);
  for (const c of calls) assert.ok(/await resolveCustomerRole/.test(c), c);
});

check('genLogChannelId is awaited wherever it is interpolated', () => {
  const src = code('modules/genLog.js');
  const uses = src.match(/[\w ]*genLogChannelId\(/g) || [];
  for (const u of uses) {
    if (/function genLogChannelId/.test(u)) continue;
    assert.ok(/await genLogChannelId\(/.test(u), `${u.trim()} — a Promise would print as [object Promise]`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
