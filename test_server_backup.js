// Server snapshot & restore.
//
// A restore writes to a live Discord server, and the two ways it can go wrong
// are not symmetrical. Creating a channel too many is an afternoon's tidying.
// Applying a deny to the WRONG role — because an id from the old guild happens
// to name something here — locks staff out of their own server, and looks like
// a successful restore while doing it.
//
// So most of what is pinned below is about ids not being trusted across
// guilds, and about one bad entry never being able to fail the whole job.
//
//   node test_server_backup.js
'use strict';

const assert = require('assert');
const B = require('./modules/serverBackup');
const { CH } = B;

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

const GUILD = '1242128831092101201';

// discord.js hands out Collections; a Map with .values() is all this module
// touches, so a plain one stands in.
const coll = (arr) => new Map(arr.map(x => [x.id, x]));

const role = (id, name, o = {}) => ({
  id, name, color: 0, hoist: false, position: 1, mentionable: false, managed: false,
  permissions: { bitfield: 0n }, unicodeEmoji: null, iconURL: () => null, ...o,
});

const chan = (id, name, type, o = {}) => ({
  id, name, type, parentId: null, rawPosition: 0, topic: null, nsfw: false,
  rateLimitPerUser: 0, permissionOverwrites: { cache: coll([]) }, ...o,
});

const guildOf = (roles, channels, extra = {}) => ({
  id: GUILD, name: 'Test Server',
  iconURL: () => null, bannerURL: () => null, splashURL: () => null,
  verificationLevel: 2, explicitContentFilter: 1, defaultMessageNotifications: 1,
  roles: { cache: coll(roles) }, channels: { cache: coll(channels) },
  emojis: { cache: coll([]) }, stickers: { cache: coll([]) },
  ...extra,
});

// ─── Capture ─────────────────────────────────────────────────────────────────
check('a permission bitfield survives the round trip as a string', () => {
  // Administrator is bit 3, but MANAGE_EVENTS and friends live above 2^53.
  // Stored as a Number, the high bits round away silently and the permission
  // that vanishes is whichever one happened to be up there.
  const big = (1n << 52n) | (1n << 55n) | 8n;
  const snap = B.snapshotRole(role('r1', 'Staff', { permissions: { bitfield: big } }));
  assert.strictEqual(typeof snap.permissions, 'string');
  assert.strictEqual(BigInt(snap.permissions), big);
  assert.strictEqual(BigInt(JSON.parse(JSON.stringify(snap)).permissions), big,
    'the bitfield did not survive JSON, which is how it is stored');
});

check('threads are not snapshotted', () => {
  // A thread is a conversation, not structure. Restored into a fresh server it
  // is an empty shell with a name.
  const snap = B.snapshotGuild(guildOf(
    [role(GUILD, '@everyone')],
    [chan('c1', 'general', CH.GuildText), chan('t1', 'some-thread', CH.PublicThread)]));
  assert.deepStrictEqual(snap.channels.map(c => c.name), ['general']);
});

check('the guild\'s own settings are captured, not just its contents', () => {
  const snap = B.snapshotGuild(guildOf([role(GUILD, '@everyone')], []));
  assert.strictEqual(snap.guild.verificationLevel, 2);
  assert.strictEqual(snap.guild.explicitContentFilter, 1);
  assert.strictEqual(snap.sourceGuildId, GUILD);
});

// ─── Roles ───────────────────────────────────────────────────────────────────
check('@everyone is updated, never created', () => {
  // Its id IS the guild id, so it looks like any other role in the snapshot —
  // and it holds the server's entire permission baseline. A pass that only
  // creates what is missing skips the most important role there is.
  const snap = { sourceGuildId: GUILD, roles: [B.snapshotRole(role(GUILD, '@everyone'))] };
  const plan = B.planRoles(snap, [{ id: 'NEW_GUILD', name: '@everyone' }]);
  assert.strictEqual(plan.create.length, 0);
  assert.strictEqual(plan.update.length, 1);
  assert.ok(plan.update[0].everyone);
  assert.strictEqual(plan.update[0].to.id, 'NEW_GUILD', 'must target the LIVE @everyone, not the snapshot id');
});

check('bot and integration roles are skipped with a reason, not attempted', () => {
  // Discord refuses to create or edit a managed role. It reappears on its own
  // when that bot is re-invited, so trying is a guaranteed error for no gain.
  const snap = { sourceGuildId: GUILD, roles: [
    B.snapshotRole(role('r1', 'MEE6', { managed: true })),
    B.snapshotRole(role('r2', 'Staff')),
  ]};
  const plan = B.planRoles(snap, []);
  assert.deepStrictEqual(plan.create.map(r => r.name), ['Staff']);
  assert.strictEqual(plan.skipped.length, 1);
  assert.ok(/managed/i.test(plan.skipped[0].why));
});

check('two roles with the same name do not collapse into one', () => {
  // Duplicate names are legal and common. Matching both onto one live role
  // means the second update silently undoes the first.
  const snap = { sourceGuildId: GUILD, roles: [
    B.snapshotRole(role('r1', 'Member', { position: 5 })),
    B.snapshotRole(role('r2', 'Member', { position: 4 })),
  ]};
  const plan = B.planRoles(snap, [{ id: 'L1', name: 'Member' }]);
  assert.strictEqual(plan.update.length, 1);
  assert.strictEqual(plan.create.length, 1, 'the second "Member" should be created, not merged');
});

check('an existing role is updated rather than duplicated', () => {
  const snap = { sourceGuildId: GUILD, roles: [B.snapshotRole(role('r1', 'Staff'))] };
  const plan = B.planRoles(snap, [{ id: 'L9', name: 'Staff' }]);
  assert.strictEqual(plan.create.length, 0);
  assert.strictEqual(plan.update[0].to.id, 'L9');
});

// ─── Overwrites — the part that can lock a server ────────────────────────────
check('an unmappable role overwrite is DROPPED, never applied as-is', () => {
  // This is the whole reason the remap exists. '999' is a role id from the old
  // guild; in the new one it is just a number, and it may well name something
  // real. Applying a deny to it is how a restore locks the staff out.
  const idMap = new Map([['r1', 'NEW_r1']]);
  const { kept, dropped } = B.remapOverwrites(
    [{ id: 'r1', type: 0, allow: '1024', deny: '0' },
     { id: '999', type: 0, allow: '0', deny: '1024' }], idMap);
  assert.deepStrictEqual(kept.map(k => k.id), ['NEW_r1']);
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].id, '999');
});

check('a member overwrite is kept only when that member is actually here', () => {
  const idMap = new Map();
  const here = (id) => id === 'u_present';
  const { kept, dropped } = B.remapOverwrites(
    [{ id: 'u_present', type: 1, allow: '8', deny: '0' },
     { id: 'u_gone',    type: 1, allow: '8', deny: '0' }], idMap, here);
  assert.deepStrictEqual(kept.map(k => k.id), ['u_present']);
  assert.strictEqual(dropped[0].id, 'u_gone');
});

check('member ids are not looked up in the role map', () => {
  // A member id and a role id are both snowflakes. If type is ignored, a
  // member overwrite can collide with a role entry and be rewritten into a
  // completely unrelated role.
  const idMap = new Map([['555', 'SOME_ROLE']]);
  const { kept, dropped } = B.remapOverwrites([{ id: '555', type: 1, allow: '8', deny: '0' }], idMap, () => false);
  assert.strictEqual(kept.length, 0);
  assert.strictEqual(dropped.length, 1, 'a member overwrite was resolved through the ROLE map');
});

// ─── Permissions the bot does not hold ───────────────────────────────────────
check('permissions the bot lacks are masked off instead of failing the role', () => {
  // Discord rejects the WHOLE request when it is asked to grant a permission
  // the actor does not hold — so one missing bit fails the entire role, not
  // just that bit. Masking turns "restore failed" into "restore succeeded,
  // minus two permissions, and here they are".
  const wanted = 0b1111n, botHas = 0b0101n;
  const { granted, missing } = B.maskPermissions(wanted, botHas);
  assert.strictEqual(BigInt(granted), 0b0101n);
  assert.strictEqual(BigInt(missing), 0b1010n);
});

check('masking is exact at bit widths a Number cannot hold', () => {
  const wanted = (1n << 60n) | 8n;
  const botHas = (1n << 60n);
  const { granted, missing } = B.maskPermissions(wanted.toString(), botHas.toString());
  assert.strictEqual(BigInt(granted), 1n << 60n);
  assert.strictEqual(BigInt(missing), 8n);
});

check('the dropped permissions can be named, not just counted', () => {
  const flags = { Administrator: 8n, ManageGuild: 32n, BanMembers: 4n };
  assert.deepStrictEqual(B.namePermissions(40n, flags), ['Administrator', 'ManageGuild']);
  assert.deepStrictEqual(B.namePermissions(0n, flags), []);
});

// ─── Channels ────────────────────────────────────────────────────────────────
check('categories are created before the channels inside them', () => {
  // A channel given a parent that does not exist yet lands at the top level
  // instead. That is a successful-looking restore with the structure missing.
  const chans = [
    { id: 'c1', name: 'general', type: CH.GuildText, position: 0, parentId: 'cat1' },
    { id: 'cat1', name: 'INFO', type: CH.GuildCategory, position: 9 },
  ];
  assert.deepStrictEqual(B.orderChannelsForCreation(chans).map(c => c.name), ['INFO', 'general']);
});

check('same channel name under different categories stays two channels', () => {
  const snap = { sourceGuildId: GUILD, channels: [
    { id: 'catA', name: 'STAFF', type: CH.GuildCategory, position: 0 },
    { id: 'catB', name: 'PUBLIC', type: CH.GuildCategory, position: 1 },
    { id: 'c1', name: 'general', type: CH.GuildText, parentId: 'catA', position: 0 },
    { id: 'c2', name: 'general', type: CH.GuildText, parentId: 'catB', position: 1 },
  ]};
  const plan = B.planChannels(snap, [], () => null);
  assert.strictEqual(plan.create.filter(c => c.name === 'general').length, 2,
    'the two "general" channels were merged into one');
});

check('an existing channel under the same category is updated, not duplicated', () => {
  const snap = { sourceGuildId: GUILD, channels: [
    { id: 'catA', name: 'STAFF', type: CH.GuildCategory, position: 0 },
    { id: 'c1', name: 'general', type: CH.GuildText, parentId: 'catA', position: 0 },
  ]};
  const live = [
    { id: 'L_cat', name: 'STAFF', type: CH.GuildCategory },
    { id: 'L_gen', name: 'general', type: CH.GuildText, parentId: 'L_cat' },
  ];
  const plan = B.planChannels(snap, live, (c) => (c.parentId === 'L_cat' ? 'STAFF' : null));
  assert.strictEqual(plan.create.length, 0);
  assert.deepStrictEqual(plan.update.map(u => u.to.id).sort(), ['L_cat', 'L_gen']);
});

check('a category and a text channel of the same name are not confused', () => {
  const snap = { sourceGuildId: GUILD, channels: [
    { id: 'x1', name: 'support', type: CH.GuildCategory, position: 0 },
    { id: 'x2', name: 'support', type: CH.GuildText, position: 1 },
  ]};
  const plan = B.planChannels(snap, [{ id: 'L1', name: 'support', type: CH.GuildCategory }], () => null);
  assert.strictEqual(plan.update.length, 1);
  assert.strictEqual(plan.create.length, 1);
  assert.strictEqual(plan.create[0].type, CH.GuildText);
});

check('a create payload only carries fields that channel type accepts', () => {
  // Sending bitrate to a text channel is a 400, and one 400 in the middle of a
  // restore is a half-built server.
  const text = B.channelCreatePayload({ name: 'g', type: CH.GuildText, topic: 'hi', bitrate: 64000, userLimit: 5 }, null, []);
  assert.strictEqual(text.topic, 'hi');
  assert.ok(!('bitrate' in text) && !('userLimit' in text));

  const voice = B.channelCreatePayload({ name: 'v', type: CH.GuildVoice, topic: 'hi', bitrate: 64000, userLimit: 5 }, null, []);
  assert.strictEqual(voice.bitrate, 64000);
  assert.strictEqual(voice.userLimit, 5);
  assert.ok(!('topic' in voice));
});

check('a parent is only sent when there is one', () => {
  const top = B.channelCreatePayload({ name: 'rules', type: CH.GuildText }, null, []);
  assert.ok(!('parent' in top), 'a null parent would be rejected rather than ignored');
});

// ─── What the operator is told before they press the button ──────────────────
check('the plan is described up front and promises no deletions', () => {
  const rolePlan = { create: [1, 2], update: [1], skipped: [1] };
  const chanPlan = { create: [{ type: CH.GuildCategory }, { type: CH.GuildText }], update: [] };
  const lines = B.describePlan(rolePlan, chanPlan, { emojis: [] }).join('\n');
  assert.ok(/Create 2 role/.test(lines));
  assert.ok(/Skip 1 bot/.test(lines));
  assert.ok(/Nothing is ever deleted/.test(lines));
});

check('a snapshot that matches the server says so instead of listing nothing', () => {
  const lines = B.describePlan({ create: [], update: [], skipped: [] }, { create: [], update: [] }, {});
  assert.ok(/already matches/.test(lines.join('\n')));
});

check('the counts shown in /serverbackup list exclude what will never restore', () => {
  const snap = {
    sourceGuildId: GUILD,
    roles: [B.snapshotRole(role('r1', 'Staff')), B.snapshotRole(role('r2', 'MEE6', { managed: true }))],
    channels: [
      { id: 'cat', name: 'A', type: CH.GuildCategory, overwrites: [{ id: 'r1' }] },
      { id: 'c1', name: 'b', type: CH.GuildText, overwrites: [{ id: 'r1' }, { id: 'r2' }] },
    ],
    emojis: [{ name: 'e' }], stickers: [],
  };
  const c = B.snapshotCounts(snap);
  assert.strictEqual(c.roles, 1, 'a managed role was counted as restorable');
  assert.strictEqual(c.categories, 1);
  assert.strictEqual(c.channels, 1);
  assert.strictEqual(c.overwrites, 3);
  assert.strictEqual(c.emojis, 1);
});

// ─── Restoring only part of a snapshot ───────────────────────────────────────
//
// "What if I want to restore just the roles?" A restore that is all-or-nothing
// is the wrong shape for the commonest repair, and the parts are not
// independent — permission rules are written in terms of roles, channels live
// under categories — so most of what is pinned here is that leaving one out
// degrades honestly instead of silently.

check('nothing selected is a different answer from nothing said', () => {
  // null is what an old button with no parts segment means, and it meant
  // everything when that button was posted. An empty LIST is a real choice.
  assert.deepStrictEqual(B.normalizeParts(null), B.ALL_PARTS);
  assert.deepStrictEqual(B.normalizeParts(undefined), B.ALL_PARTS);
  assert.deepStrictEqual(B.normalizeParts([]), []);
});

check('a selection survives a round trip through a customId', () => {
  for (const parts of [['roles'], ['roles', 'emojis'], B.ALL_PARTS, ['permissions', 'channels']]) {
    assert.deepStrictEqual(B.normalizeParts(B.encodeParts(parts)), B.normalizeParts(parts));
  }
  // Discord allows 100 characters for the whole id; the snapshot id and the
  // cross-guild flag share it.
  assert.ok(B.encodeParts(B.ALL_PARTS).length <= 8, B.encodeParts(B.ALL_PARTS));
});

check('an unknown code is ignored rather than throwing away the rest', () => {
  // A button posted before a sixth part existed still restores the five it
  // names.
  assert.deepStrictEqual(B.decodeParts('R?E'), ['roles', 'emojis']);
  assert.deepStrictEqual(B.decodeParts(''), []);
  assert.deepStrictEqual(B.decodeParts('RR'), ['roles']);
});

check('the order is the order things must happen in, whatever order they were ticked', () => {
  // Roles before channels because a permission rule names a role; categories
  // before channels because a channel needs its parent to exist.
  assert.deepStrictEqual(B.normalizeParts(['emojis', 'channels', 'roles']), ['roles', 'channels', 'emojis']);
  assert.strictEqual(B.PART_KEYS.indexOf('roles'), 0);
  assert.ok(B.PART_KEYS.indexOf('categories') < B.PART_KEYS.indexOf('channels'));
});

const ROLE_PLAN = { create: [1, 2], update: [1], skipped: [1] };
const CHAN_PLAN = {
  create: [{ type: CH.GuildCategory }, { type: CH.GuildText }, { type: CH.GuildVoice }],
  update: [{ from: { type: CH.GuildCategory } }, { from: { type: CH.GuildText } }],
};
const SNAP = { emojis: [{ name: 'a' }, { name: 'b' }] };
const plan = (parts) => B.describePlan(ROLE_PLAN, CHAN_PLAN, SNAP, parts).join('\n');

check('the plan describes only what was ticked', () => {
  const roles = plan(['roles']);
  assert.ok(/Create 2 role/.test(roles), roles);
  assert.ok(!/channel/i.test(roles), `a roles-only restore promised channels:\n${roles}`);
  assert.ok(!/emoji/i.test(roles), roles);

  const emojis = plan(['emojis']);
  assert.ok(/Re-upload up to 2 emoji/.test(emojis), emojis);
  assert.ok(!/role/i.test(emojis), emojis);
});

check('categories and channels are counted apart, because they are ticked apart', () => {
  const cats = plan(['categories']);
  assert.ok(/Create 1 category/.test(cats), cats);
  assert.ok(!/Create 2 channel/.test(cats), `unticking channels still promised them:\n${cats}`);

  const chans = plan(['channels']);
  assert.ok(/Create 2 channel/.test(chans), chans);
  assert.ok(!/categor/i.test(chans), chans);
});

check('without permission rules, an existing channel is not claimed to be updated', () => {
  // It is not. With the rules unticked the only thing left to write is a
  // topic, and a category has not even got that.
  const chans = plan(['channels']);
  assert.ok(/Update the topic on 1 existing channel/.test(chans), chans);
  assert.ok(!/permission rule/i.test(chans), chans);

  const cats = plan(['categories']);
  assert.ok(!/Update .* existing categor/.test(cats), `a category with no topic and no rules had nothing to update:\n${cats}`);
});

check('everything ticked still reads like the old plan', () => {
  const all = plan(B.ALL_PARTS);
  for (const re of [/Create 2 role/, /Update 1 existing role/, /Skip 1 bot/, /Create 1 category/,
                    /Update 1 existing category/, /Create 2 channel/, /Update 1 existing channel/,
                    /permission rules onto 5 channel/, /Re-upload up to 2 emoji/]) {
    assert.ok(re.test(all), `${re} missing from:\n${all}`);
  }
  assert.ok(/Nothing is ever deleted/.test(all));
});

check('an empty selection says so rather than "already matches"', () => {
  const none = plan([]);
  assert.ok(/Nothing selected/.test(none), none);
  assert.ok(!/already matches/.test(none), none);
});

check('leaving a part out is explained before the button, not after', () => {
  const noRoles = B.partWarnings(['permissions', 'channels']).join('\n');
  assert.ok(/matched by name/i.test(noRoles), noRoles);

  const noCats = B.partWarnings(['channels']).join('\n');
  assert.ok(/top level/i.test(noCats), noCats);

  // The important one: unticking permission rules is the SAFE direction, and
  // someone needs to know their channels keep the permissions they have.
  const noPerms = B.partWarnings(['channels']).join('\n');
  assert.ok(/keep the permissions they have/i.test(noPerms), noPerms);

  assert.deepStrictEqual(B.partWarnings(B.ALL_PARTS), [], 'everything ticked warns about nothing');
});

check('permission rules with nothing to write them onto is called out', () => {
  assert.ok(/nothing to write them onto/i.test(B.partWarnings(['roles', 'permissions']).join('\n')));
});

// ─── The two ways a partial restore could quietly destroy something ──────────

check('the id table is built from the plan, not from what was restored', () => {
  // Restoring "permission rules but not roles" has to find the roles that are
  // already here — planRoles.update pairs them by name. If the caller only
  // built the map from roles it CREATED, every rule in the snapshot would be
  // dropped and the restore would report success.
  const snap = {
    sourceGuildId: GUILD,
    roles: [B.snapshotRole(role('old1', 'Staff')), B.snapshotRole(role('old2', 'Nowhere'))],
    channels: [],
  };
  const p = B.planRoles(snap, [role('new1', 'Staff')]);
  assert.strictEqual(p.update.length, 1);
  assert.strictEqual(p.update[0].from.id, 'old1');
  assert.strictEqual(p.update[0].to.id, 'new1');

  const idMap = new Map(p.update.map(u => [u.from.id, u.to.id]));
  const { kept, dropped } = B.remapOverwrites(
    [{ id: 'old1', type: 0, allow: '8', deny: '0' }, { id: 'old2', type: 0, allow: '8', deny: '0' }],
    idMap, () => false);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].id, 'new1');
  assert.strictEqual(dropped.length, 1, 'a rule for a role that was never created was applied anyway');
});

check('unticking permission rules must skip the call, never send an empty list', () => {
  // permissionOverwrites.set REPLACES what is on the channel. Passing [] to
  // "leave it alone" would clear every permission on every channel in the
  // snapshot — the one way this feature could delete something.
  const src = require('fs').readFileSync('index.js', 'utf8');
  // Comments in here quote the rule they are explaining, so they would satisfy
  // this check while the code broke it.
  const body = src.slice(src.indexOf('async function runRestore'), src.indexOf('function hasAccess'))
    .replace(/^\s*\/\/.*$/gm, '');
  const at = body.indexOf('await to.permissionOverwrites.set(');
  assert.ok(at > 0, 'the overwrite write moved — re-point this check at it');
  assert.ok(/on\('permissions'\)/.test(body.slice(at - 120, at)),
    'the overwrite write is not behind the permissions tick');
  assert.ok(!/permissionOverwrites\.set\(\s*\[\s*\]/.test(body), 'an empty overwrite list is being sent');
});

check('the restore honours every part it offers', () => {
  const src = require('fs').readFileSync('index.js', 'utf8');
  const body = src.slice(src.indexOf('async function runRestore'), src.indexOf('function hasAccess'));
  for (const k of B.PART_KEYS) {
    assert.ok(body.includes(`on('${k}')`), `runRestore never checks ${k} — the option would do nothing`);
  }
  // And the dropdown is what feeds it.
  assert.ok(/sbparts::/.test(src), 'no what-to-restore dropdown is posted');
  assert.ok(/sbrestore::\$\{tag\}::\$\{serverBackup\.encodeParts/.test(src),
    'the confirm button does not carry the selection');
});

console.log(`\n${passed} checks passed`);
