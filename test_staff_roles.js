// Round 30 — staff roles resolved per guild.
//
// The bug this pins: the bot serves two servers, `STAFF_ROLE_ID` is a single
// value, and it names Ticket Staff in the FIRST server. In the second, that id
// matches no role at all — so the 👁️ OVERSEER role created there granted
// nothing, and Administrator was the only way in. That is the same permission
// the whole access audit exists to complain about, and the failure was silent:
// from the outside it looks exactly like "the bot ignores my role".
//
// So the properties worth holding onto are about BLAST RADIUS in both
// directions — a guild's own roles must work, and one guild's ids must not
// leak into another's.
//
//   node test_staff_roles.js
'use strict';

const assert = require('assert');
const { parseStaffRoleMap, makeStaffRoleResolver, STAFF_ROLE_DEFAULTS } = require('./modules/staffRoles');

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

const HACKING = '1242128831092101201';   // 𝗨𝗻𝗸𝗻𝗼𝘄𝗻 𝗛𝗮𝗰𝗸𝗶𝗻𝗴™ — the original guild
const STORE   = '1511517606954139711';   // 𝐎𝐧𝐓𝐨𝐩 | 𝐃𝐢𝐠𝐢𝐭𝐚𝐥 𝐒𝐭𝐨𝐫𝐞
const TICKET_STAFF   = '1242149320095170570';  // == STAFF_ROLE_ID in prod
const OVERSEER_HACK  = '1518372339115360358';
const OVERSEER_STORE = '1534313431547510865';

// Production's actual configuration, so these checks describe the live bot.
const prod = () => makeStaffRoleResolver({
  primaryGuildId: HACKING,
  staffRoleId: TICKET_STAFF,
  legacyOverseerRoleId: OVERSEER_HACK,
});

// ─── The bug ─────────────────────────────────────────────────────────────────
check("the store server's own OVERSEER grants access", () => {
  // Before this change staffRoleIdsFor(STORE) was [TICKET_STAFF] — an id that
  // does not exist in that guild — so this role was worth nothing.
  assert.ok(prod().staffRoleIdsFor(STORE).includes(OVERSEER_STORE));
});

check("the first server's ids do not leak into the second", () => {
  const ids = prod().staffRoleIdsFor(STORE);
  assert.ok(!ids.includes(TICKET_STAFF), 'STAFF_ROLE_ID escaped the guild it was set for');
  assert.ok(!ids.includes(OVERSEER_HACK), "the other guild's OVERSEER escaped");
});

check('nobody who has access today loses it', () => {
  // Ticket Staff have had these commands all along via STAFF_ROLE_ID. Taking
  // that away is not a fix, it is an outage for whoever is on shift.
  const ids = prod().staffRoleIdsFor(HACKING);
  assert.ok(ids.includes(TICKET_STAFF));
  assert.ok(ids.includes(OVERSEER_HACK));
});

check('a guild the bot has never seen resolves to nothing, not to someone else', () => {
  // Falling back to "the first guild's staff role" here would hand a stranger's
  // server a role id that means nothing — or worse, one that happens to exist.
  assert.deepStrictEqual(prod().staffRoleIdsFor('999999999999999999'), []);
});

// ─── The settings cache ──────────────────────────────────────────────────────
check('a panel-set OVERSEER wins, and is tried first', () => {
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, staffRoleId: TICKET_STAFF,
    getCachedOverseerRoleId: (g) => (g === STORE ? 'PANEL_SET' : null),
  });
  assert.strictEqual(r.staffRoleIdsFor(STORE)[0], 'PANEL_SET');
});

check('a cold cache falls back instead of denying everyone', () => {
  // This resolver is deliberately synchronous, so it will often be asked
  // before any settings load has happened. Returning [] there would lock the
  // whole staff out of the first command after every restart.
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, staffRoleId: TICKET_STAFF,
    getCachedOverseerRoleId: () => null,
  });
  assert.deepStrictEqual(r.staffRoleIdsFor(STORE), [OVERSEER_STORE]);
});

check('a throwing cache lookup cannot take the gate down with it', () => {
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, staffRoleId: TICKET_STAFF,
    getCachedOverseerRoleId: () => { throw new Error('cache exploded'); },
  });
  assert.deepStrictEqual(r.staffRoleIdsFor(STORE), [OVERSEER_STORE]);
});

// ─── STAFF_ROLE_IDS parsing ──────────────────────────────────────────────────
check('the env map takes several roles per guild and several guilds', () => {
  assert.deepStrictEqual(
    parseStaffRoleMap('G1:R1:R2, G2:R3'),
    { G1: ['R1', 'R2'], G2: ['R3'] });
});

check('malformed entries are dropped, never half-parsed', () => {
  // This string decides who can run /config and /web-balance adjust. A guild
  // id with no roles after it must not become "everyone" or "the last guild".
  assert.deepStrictEqual(parseStaffRoleMap('G1:'), {});
  assert.deepStrictEqual(parseStaffRoleMap(':R1'), {});
  assert.deepStrictEqual(parseStaffRoleMap(''), {});
  assert.deepStrictEqual(parseStaffRoleMap(undefined), {});
  assert.deepStrictEqual(parseStaffRoleMap('  ,  ,'), {});
});

check('the env map overrides the built-in defaults for that guild', () => {
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, envMapRaw: `${STORE}:CUSTOM`, staffRoleId: TICKET_STAFF,
  });
  assert.deepStrictEqual(r.staffRoleIdsFor(STORE), ['CUSTOM']);
  // …and only for that guild.
  assert.ok(r.staffRoleIdsFor(HACKING).includes(OVERSEER_HACK));
});

check('ids are deduped and stringified', () => {
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, staffRoleId: OVERSEER_HACK,      // same as the default
    getCachedOverseerRoleId: () => OVERSEER_HACK,             // and again
  });
  assert.deepStrictEqual(r.staffRoleIdsFor(HACKING), [OVERSEER_HACK]);
});

// ─── defaultOverseerRoleId — the async callers (stock access, gen limits) ────
check('each guild gets its own OVERSEER for stock access and gen limits', () => {
  const r = prod();
  assert.strictEqual(r.defaultOverseerRoleId(HACKING), OVERSEER_HACK);
  assert.strictEqual(r.defaultOverseerRoleId(STORE),   OVERSEER_STORE);
  assert.strictEqual(r.defaultOverseerRoleId('7777'),  null);
});

check('the legacy single OVERSEER_ROLE_ID only ever applies to the primary guild', () => {
  const r = makeStaffRoleResolver({
    primaryGuildId: HACKING, legacyOverseerRoleId: 'LEGACY', defaults: {},
  });
  assert.strictEqual(r.defaultOverseerRoleId(HACKING), 'LEGACY');
  assert.strictEqual(r.defaultOverseerRoleId(STORE), null);
});

// ─── The shipped defaults ────────────────────────────────────────────────────
check('both live guilds have a default staff role and they are different', () => {
  const ids = Object.values(STAFF_ROLE_DEFAULTS).flat();
  assert.ok(STAFF_ROLE_DEFAULTS[HACKING] && STAFF_ROLE_DEFAULTS[STORE]);
  assert.strictEqual(new Set(ids).size, ids.length, 'two guilds share a role id — that is the bug');
});

console.log(`\n${passed} checks passed`);
