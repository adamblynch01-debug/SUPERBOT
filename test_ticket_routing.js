// Rank Boosting tickets are handled by a different team in a different
// channel. The only thing that makes that true is the routing table, so this
// asserts both halves of it: the log goes somewhere else, and the people who
// own that channel can actually work the ticket.
//
// Round 33 added a second axis. The bot is in two servers now, and every route
// here used to be a single bot-wide id resolved through client.channels.cache —
// which is bot-wide, not guild-scoped, so a ticket opened on the second server
// was logged into the FIRST server's ticket channel. Not "didn't work": worked,
// in the wrong building, with a customer's issue text in it. So the second half
// of this file asserts that a route follows the guild the button was pressed in,
// that the panel's saved value beats the env one, and — the part that actually
// stops the leak — that a channel id belonging to another server is refused
// rather than posted into.
'use strict';
const assert = require('assert');

// Set the general log/staff values BEFORE requiring the module — they are read
// once at module load, same as in production.
process.env.TICKET_LOG_CHANNEL = '111111111111111111';
process.env.STAFF_ROLE_ID      = '222222222222222222';

const support = require('./modules/support');
const { routeFor, isStaffFor, RANK_BOOST_LOG_CHANNEL, RANK_BOOST_ROLE_ID } = support;

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name); process.exitCode = 1; }
}

// Minimal member stand-in — only .roles.cache.has, .permissions.has and .guild
// are used. The guild matters now: isStaffFor resolves the route for the
// member's OWN server.
function member(roleIds, manageMessages = false, guildId = undefined) {
  return {
    roles: { cache: { has: id => roleIds.includes(String(id)) } },
    permissions: { has: () => manageMessages },
    guild: guildId ? { id: guildId } : undefined,
  };
}

main();
async function main() {

console.log('\nticket routing — Rank Boosting');

// ── Where the log goes ────────────────────────────────────────────────────
const boost = await routeFor('Rank Boosting');
check('rank boost logs to the rank-booster channel', boost.channel === RANK_BOOST_LOG_CHANNEL);
check('rank boost channel is the ID the user gave', RANK_BOOST_LOG_CHANNEL === '1532134443433721928');
check('rank boost pings the rank-booster role', boost.role === RANK_BOOST_ROLE_ID);
check('rank boost role is the ID the user gave', RANK_BOOST_ROLE_ID === '1532108479454515341');

// The point of the feature: general staff are NOT told about these.
check('rank boost does not use the general log channel', boost.channel !== process.env.TICKET_LOG_CHANNEL);
check('rank boost does not ping general staff', boost.role !== process.env.STAFF_ROLE_ID);

// ── Every other type is untouched ─────────────────────────────────────────
for (const t of ['HWID Reset', 'Purchase', 'Resell', 'Support']) {
  const r = await routeFor(t);
  check(`${t} still logs to the general channel`, r.channel === process.env.TICKET_LOG_CHANNEL);
  check(`${t} still pings general staff`, r.role === process.env.STAFF_ROLE_ID);
}

// An unrouted / unknown type must fall back rather than silently stop logging.
const unknown = await routeFor('Something Nobody Added Yet');
check('unknown type falls back to the general channel', unknown.channel === process.env.TICKET_LOG_CHANNEL);
check('a missing ticket type does not produce a null channel', !!unknown.channel);

// ── Who can work the ticket ───────────────────────────────────────────────
// The Quick Reply / Close buttons sit in the booster channel, so a booster
// with no general staff role has to be able to press them.
const booster = member([RANK_BOOST_ROLE_ID]);
const staff   = member([process.env.STAFF_ROLE_ID]);
const nobody  = member([]);

check('a booster can work a rank boost ticket', await isStaffFor(booster, 'Rank Boosting') === true);
check('general staff can still work a rank boost ticket', await isStaffFor(staff, 'Rank Boosting') === true);
check('a random member cannot work a rank boost ticket', await isStaffFor(nobody, 'Rank Boosting') === false);

// A booster gains nothing anywhere else — the role only unlocks its own type.
check('a booster cannot work an HWID ticket', await isStaffFor(booster, 'HWID Reset') === false);
check('a booster cannot work a Purchase ticket', await isStaffFor(booster, 'Purchase') === false);
check('general staff still work an HWID ticket', await isStaffFor(staff, 'HWID Reset') === true);

// A closed ticket has no type left to look up; the check must not throw and
// must not hand out access to it either.
check('an unknown-type ticket still admits general staff', await isStaffFor(staff, undefined) === true);
check('an unknown-type ticket refuses a booster', await isStaffFor(booster, undefined) === false);
check('a null member is refused', await isStaffFor(null, 'Rank Boosting') === false);

// isStaffFor is async now, and `if (!isStaffFor(...))` on a Promise is ALWAYS
// false — an un-awaited call hands every Quick Reply and Close button to
// everyone in the server. That is a bug you cannot see in a passing test suite,
// so assert on the source: every call site awaits.
{
  // Comments stripped, so an explanation that quotes the broken shape is not
  // mistaken for the broken shape.
  const src = require('fs').readFileSync('modules/support.js', 'utf8')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls = src.match(/[^ ]* *isStaffFor\(/g) || [];
  const guards = src.match(/if \(!\s*isStaffFor\(/g) || [];
  check('no call site tests the Promise instead of the answer', guards.length === 0);
  check('there are call sites to test at all', calls.length >= 3);
}

// ── The type name must survive the customId round trip ────────────────────
// game_select_<type with _ for spaces>, then issue_modal_<type>_<game>, which
// the submit handler splits on the FIRST underscore. A type name containing an
// underscore would silently truncate.
const TYPE = 'Rank Boosting';
const selectId = `game_select_${TYPE.replace(/\s/g, '_')}`;
const backFromSelect = selectId.replace('game_select_', '').replace(/_/g, ' ');
check('type survives the game-select customId', backFromSelect === TYPE);

const game = 'Call of Duty: Warzone';
const modalId = `issue_modal_${backFromSelect}_${game}`;
const rest = modalId.replace('issue_modal_', '');
const sep = rest.indexOf('_');
check('type survives the issue-modal customId', rest.slice(0, sep).replace(/_/g, ' ') === TYPE);
check('game survives the issue-modal customId', rest.slice(sep + 1) === game);
check('modal customId is within Discord\'s 100-char limit', modalId.length <= 100);

// ── Per-guild routing ─────────────────────────────────────────────────────
// The panel writes ticket_log_channel and staff_role_id per guild. Until this
// round nothing read them: the fields validated, saved, and reported "Saved 19
// field(s)" while every ticket kept going to the env channel.
console.log('\na second server gets its own route');

const G1 = '1242128831092101201';   // the original guild the env vars describe
const G2 = '1511517606954139711';   // the second server
const SAVED = {
  [G2]: { ticketLogChannel: '999999999999999999', ticketStaffRoleId: '888888888888888888' },
};
support.setSupportSettingsProvider(async (gid) => SAVED[gid] || null);

const r2 = await routeFor('Support', G2);
check('the second server logs to its own channel', r2.channel === '999999999999999999');
check('the second server pings its own staff role', r2.role === '888888888888888888');
check('...which is not the first server\'s channel', r2.channel !== process.env.TICKET_LOG_CHANNEL);
check('the route carries the guild it belongs to', r2.guildId === G2);

const r1 = await routeFor('Support', G1);
check('a guild that has saved nothing still uses the env route', r1.channel === process.env.TICKET_LOG_CHANNEL);
check('...and the env staff role', r1.role === process.env.STAFF_ROLE_ID);

// An empty input box posts '' , and a column nobody has written reads as null.
// Spreading either over the env value would blank a working route.
SAVED[G1] = { ticketLogChannel: '', ticketStaffRoleId: null };
const r1b = await routeFor('Support', G1);
check('a blank saved field falls back rather than blanking the route', r1b.channel === process.env.TICKET_LOG_CHANNEL);
check('a null saved field falls back too', r1b.role === process.env.STAFF_ROLE_ID);
delete SAVED[G1];

// Rank boosting is routed per-guild as well — otherwise the second server's
// boost tickets land in the first server's booster channel, which is the same
// leak wearing a different hat.
SAVED[G2].rankBoostLogChannel = '777777777777777777';
const b2 = await routeFor('Rank Boosting', G2);
check('the second server\'s boost tickets go to its own booster channel', b2.channel === '777777777777777777');
check('a boost route with no saved role still finds the env one', b2.role === RANK_BOOST_ROLE_ID);

// A provider that throws (database down) must not take tickets down with it.
support.setSupportSettingsProvider(async () => { throw new Error('db is down'); });
const degraded = await routeFor('Support', G2);
check('a settings read that throws degrades to the env route', degraded.channel === process.env.TICKET_LOG_CHANNEL);
support.setSupportSettingsProvider(async (gid) => SAVED[gid] || null);

// ── The leak itself ───────────────────────────────────────────────────────
// This is the assertion the round was about. client.channels.cache.get() finds
// a channel in ANY guild the bot is in, so a stale id from server 1 resolved
// perfectly while the ticket belonged to server 2. resolveLogChannel must look
// inside the ticket's own guild and refuse rather than fall back.
console.log('\na channel id from the wrong server is refused, not posted into');

const chan = (id) => ({ id, send: async () => {} });
const client = {
  guilds: { cache: new Map([
    [G1, { id: G1, name: 'server one', channels: { cache: new Map([['111111111111111111', chan('111111111111111111')]]) } }],
    [G2, { id: G2, name: 'server two', channels: { cache: new Map([['999999999999999999', chan('999999999999999999')]]) } }],
  ]) },
  // The bot-wide lookup that caused the leak. Left working on purpose: the test
  // is that resolveLogChannel does not REACH for it when it knows the guild.
  channels: {
    cache: new Map([
      ['111111111111111111', chan('111111111111111111')],
      ['999999999999999999', chan('999999999999999999')],
    ]),
    fetch: async (id) => chan(id),
  },
};

const okCh = await support.resolveLogChannel(client, { channel: '999999999999999999', guildId: G2 });
check('a channel in the ticket\'s own guild resolves', okCh && okCh.id === '999999999999999999');

const leaked = await support.resolveLogChannel(client, { channel: '111111111111111111', guildId: G2 });
check('server one\'s channel is NOT resolved for a server two ticket', leaked === null);

// Tickets saved before the guild was recorded have nothing to scope by. Those
// keep the old behaviour — logging into the wrong server is bad, logging
// nowhere is worse, and it only affects tickets already open at deploy time.
const legacy = await support.resolveLogChannel(client, { channel: '111111111111111111' });
check('a ticket with no guild recorded still logs somewhere', legacy && legacy.id === '111111111111111111');

const nothing = await support.resolveLogChannel(client, { channel: null, guildId: G2 });
check('no channel configured resolves to null rather than throwing', nothing === null);

// The bot is in a guild it has no cache entry for (it was kicked, or the
// ticket outlived the install). Falling back is right; throwing is not.
const gone = await support.resolveLogChannel(client, { channel: '111111111111111111', guildId: '404404404404404404' });
check('an unknown guild falls back instead of throwing', gone && gone.id === '111111111111111111');

// ── Permission follows the guild too ──────────────────────────────────────
// A staff role id is per-server; server two's ticket staff hold a role server
// one has never heard of. The check has to read the route for the member's own
// guild or the whole second server is locked out of its own tickets.
console.log('\nstaff on the second server can work the second server\'s tickets');

const g2staff = member(['888888888888888888'], false, G2);
const g1staff = member([process.env.STAFF_ROLE_ID], false, G1);
check('server two\'s ticket staff can work a server two ticket', await isStaffFor(g2staff, 'Support') === true);
check('server two\'s role does nothing on server one', await isStaffFor(member(['888888888888888888'], false, G1), 'Support') === false);
// STAFF_ROLE_ID is the money gate and still admits its holder everywhere — a
// ticket must never be strandable because the specialist team is away.
check('the general staff role still works on server one', await isStaffFor(g1staff, 'Support') === true);

support.setSupportSettingsProvider(async () => null);

// ── TICKET_STAFF_ROLE_ID is separate from the money gate ──────────────────
// The guild has two roles named "Ticket Staff"; the env pointed at the wrong
// one. Repointing STAFF_ROLE_ID would have fixed the ping and also handed
// /web-balance, /addstock and /clearstock to the whole ticket team, because
// index.js hasAccess() reads STAFF_ROLE_ID. These assert the split holds.
console.log('\nticket ping role is independent of the permission gate');

// Everything above ran with TICKET_STAFF_ROLE_ID unset — so it fell back.
check('unset TICKET_STAFF_ROLE_ID falls back to STAFF_ROLE_ID',
  (await routeFor('Support')).role === process.env.STAFF_ROLE_ID);

// Re-load the module with the var set, the way production reads env at boot.
const TICKET_ROLE = '333333333333333333';
process.env.TICKET_STAFF_ROLE_ID = TICKET_ROLE;
delete require.cache[require.resolve('./modules/support')];
const support2 = require('./modules/support');

check('a set TICKET_STAFF_ROLE_ID is what gets pinged',
  (await support2.routeFor('Support')).role === TICKET_ROLE);
check('the ping role is NOT the permission gate role',
  (await support2.routeFor('Support')).role !== process.env.STAFF_ROLE_ID);
check('every general ticket type pings it',
  (await Promise.all(['HWID Reset', 'Purchase', 'Resell', 'Support', 'Nothing Routed']
    .map(t => support2.routeFor(t)))).every(r => r.role === TICKET_ROLE));
check('rank boosting still pings its own team, not ticket staff',
  (await support2.routeFor('Rank Boosting')).role === RANK_BOOST_ROLE_ID);

// Ticket staff must be able to press Quick Reply / Close on their own tickets.
const ticketStaff = member([TICKET_ROLE]);
check('ticket staff can work a general ticket', await support2.isStaffFor(ticketStaff, 'Support') === true);
check('ticket staff can work an HWID ticket', await support2.isStaffFor(ticketStaff, 'HWID Reset') === true);
// ...but the role grants nothing on the rank-boost team's tickets, and holding
// it is NOT the same as holding the money-gate role.
check('ticket staff do not inherit rank boost tickets',
  await support2.isStaffFor(ticketStaff, 'Rank Boosting') === false);
check('holding the ping role is not holding STAFF_ROLE_ID',
  ticketStaff.roles.cache.has(process.env.STAFF_ROLE_ID) === false);
// Restore, so a later require in the same process sees the original world.
delete process.env.TICKET_STAFF_ROLE_ID;

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
}
