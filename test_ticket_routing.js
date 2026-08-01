// Rank Boosting tickets are handled by a different team in a different
// channel. The only thing that makes that true is TICKET_ROUTES, so this
// asserts both halves of it: the log goes somewhere else, and the people who
// own that channel can actually work the ticket.
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

// Minimal member stand-in — only .roles.cache.has and .permissions.has are used.
function member(roleIds, manageMessages = false) {
  return {
    roles: { cache: { has: id => roleIds.includes(String(id)) } },
    permissions: { has: () => manageMessages },
  };
}

console.log('\nticket routing — Rank Boosting');

// ── Where the log goes ────────────────────────────────────────────────────
const boost = routeFor('Rank Boosting');
check('rank boost logs to the rank-booster channel', boost.channel === RANK_BOOST_LOG_CHANNEL);
check('rank boost channel is the ID the user gave', RANK_BOOST_LOG_CHANNEL === '1532134443433721928');
check('rank boost pings the rank-booster role', boost.role === RANK_BOOST_ROLE_ID);
check('rank boost role is the ID the user gave', RANK_BOOST_ROLE_ID === '1532108479454515341');

// The point of the feature: general staff are NOT told about these.
check('rank boost does not use the general log channel', boost.channel !== process.env.TICKET_LOG_CHANNEL);
check('rank boost does not ping general staff', boost.role !== process.env.STAFF_ROLE_ID);

// ── Every other type is untouched ─────────────────────────────────────────
for (const t of ['HWID Reset', 'Purchase', 'Resell', 'Support']) {
  const r = routeFor(t);
  check(`${t} still logs to the general channel`, r.channel === process.env.TICKET_LOG_CHANNEL);
  check(`${t} still pings general staff`, r.role === process.env.STAFF_ROLE_ID);
}

// An unrouted / unknown type must fall back rather than silently stop logging.
const unknown = routeFor('Something Nobody Added Yet');
check('unknown type falls back to the general channel', unknown.channel === process.env.TICKET_LOG_CHANNEL);
check('a missing ticket type does not produce a null channel', !!unknown.channel);

// ── Who can work the ticket ───────────────────────────────────────────────
// The Quick Reply / Close buttons sit in the booster channel, so a booster
// with no general staff role has to be able to press them.
const booster = member([RANK_BOOST_ROLE_ID]);
const staff   = member([process.env.STAFF_ROLE_ID]);
const nobody  = member([]);

check('a booster can work a rank boost ticket', isStaffFor(booster, 'Rank Boosting') === true);
check('general staff can still work a rank boost ticket', isStaffFor(staff, 'Rank Boosting') === true);
check('a random member cannot work a rank boost ticket', isStaffFor(nobody, 'Rank Boosting') === false);

// A booster gains nothing anywhere else — the role only unlocks its own type.
check('a booster cannot work an HWID ticket', isStaffFor(booster, 'HWID Reset') === false);
check('a booster cannot work a Purchase ticket', isStaffFor(booster, 'Purchase') === false);
check('general staff still work an HWID ticket', isStaffFor(staff, 'HWID Reset') === true);

// A closed ticket has no type left to look up; the check must not throw and
// must not hand out access to it either.
check('an unknown-type ticket still admits general staff', isStaffFor(staff, undefined) === true);
check('an unknown-type ticket refuses a booster', isStaffFor(booster, undefined) === false);
check('a null member is refused', isStaffFor(null, 'Rank Boosting') === false);

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

// ── TICKET_STAFF_ROLE_ID is separate from the money gate ──────────────────
// The guild has two roles named "Ticket Staff"; the env pointed at the wrong
// one. Repointing STAFF_ROLE_ID would have fixed the ping and also handed
// /web-balance, /addstock and /clearstock to the whole ticket team, because
// index.js hasAccess() reads STAFF_ROLE_ID. These assert the split holds.
console.log('\nticket ping role is independent of the permission gate');

// Everything above ran with TICKET_STAFF_ROLE_ID unset — so it fell back.
check('unset TICKET_STAFF_ROLE_ID falls back to STAFF_ROLE_ID',
  routeFor('Support').role === process.env.STAFF_ROLE_ID);

// Re-load the module with the var set, the way production reads env at boot.
const TICKET_ROLE = '333333333333333333';
process.env.TICKET_STAFF_ROLE_ID = TICKET_ROLE;
delete require.cache[require.resolve('./modules/support')];
const support2 = require('./modules/support');

check('a set TICKET_STAFF_ROLE_ID is what gets pinged',
  support2.routeFor('Support').role === TICKET_ROLE);
check('the ping role is NOT the permission gate role',
  support2.routeFor('Support').role !== process.env.STAFF_ROLE_ID);
check('every general ticket type pings it',
  ['HWID Reset', 'Purchase', 'Resell', 'Support', 'Nothing Routed']
    .every(t => support2.routeFor(t).role === TICKET_ROLE));
check('rank boosting still pings its own team, not ticket staff',
  support2.routeFor('Rank Boosting').role === RANK_BOOST_ROLE_ID);

// Ticket staff must be able to press Quick Reply / Close on their own tickets.
const ticketStaff = member([TICKET_ROLE]);
check('ticket staff can work a general ticket', support2.isStaffFor(ticketStaff, 'Support') === true);
check('ticket staff can work an HWID ticket', support2.isStaffFor(ticketStaff, 'HWID Reset') === true);
// ...but the role grants nothing on the rank-boost team's tickets, and holding
// it is NOT the same as holding the money-gate role.
check('ticket staff do not inherit rank boost tickets',
  support2.isStaffFor(ticketStaff, 'Rank Boosting') === false);
check('holding the ping role is not holding STAFF_ROLE_ID',
  ticketStaff.roles.cache.has(process.env.STAFF_ROLE_ID) === false);
// Restore, so a later require in the same process sees the original world.
delete process.env.TICKET_STAFF_ROLE_ID;

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
