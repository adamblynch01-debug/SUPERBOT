// ─── Server snapshot & restore ───────────────────────────────────────────────
//
// "Clone the whole server as it is, then get it back when I need it."
//
// What that means in practice, and what it deliberately does NOT mean:
//
//   • A snapshot is the SHAPE of a server — roles, channels, categories, who
//     can see what, the emojis, the guild's own settings. Not its messages.
//     Discord gives no supported way to bulk-export message history, and a
//     restore that re-posted years of chat under a webhook wearing other
//     people's names would be a forgery, not a backup.
//
//   • A restore NEVER DELETES ANYTHING. Not one channel, not one role. The
//     entire point of this feature is not losing things, and a "restore" that
//     wipes first is one mis-clicked snapshot id away from being the disaster
//     it was supposed to protect against. Everything is matched by name and
//     merged; what is already there is updated, what is missing is created,
//     what exists but is not in the snapshot is left alone.
//
// The two ways this can be used follow from that:
//   1. Same server, later — undo a bad afternoon of channel edits.
//   2. A DIFFERENT, empty server — the actual disaster case, and the reason
//      every id in a snapshot has to be treated as meaningless on the way back
//      in. A role id from the old guild names nothing in the new one, so
//      permission overwrites are remapped through a name-matched id table, and
//      an overwrite that cannot be remapped is dropped rather than applied to
//      whatever that id happens to mean here.
//
// This file is the part that can be reasoned about without a live gateway:
// what to capture, what to create, what to skip and why. The Discord calls
// live in index.js, driven by the plan these functions produce.
'use strict';

// discord.js ChannelType values, spelled out so this module can be tested and
// reasoned about without importing the library.
const CH = {
  GuildText: 0, GuildVoice: 2, GuildCategory: 4, GuildAnnouncement: 5,
  AnnouncementThread: 10, PublicThread: 11, PrivateThread: 12,
  GuildStageVoice: 13, GuildDirectory: 14, GuildForum: 15, GuildMedia: 16,
};

// Threads are not snapshotted. They are conversations, not structure: a thread
// with no messages in it is an empty shell, and restoring one into a fresh
// server produces exactly that.
const THREAD_TYPES = new Set([CH.AnnouncementThread, CH.PublicThread, CH.PrivateThread]);

// ─── Capture ─────────────────────────────────────────────────────────────────

function snapshotRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: !!role.hoist,
    position: role.position,
    // A bitfield, as a STRING. Discord permission bitfields exceed 2^53 —
    // JSON.parse would round a Number one silently, and the permission that
    // gets lost is whichever happens to sit in a high bit.
    permissions: String(role.permissions && role.permissions.bitfield != null
      ? role.permissions.bitfield : (role.permissions || 0n)),
    mentionable: !!role.mentionable,
    // Recorded so restore can SKIP it, not recreate it. See isRestorableRole.
    managed: !!role.managed,
    unicodeEmoji: role.unicodeEmoji || null,
    iconURL: typeof role.iconURL === 'function' ? (role.iconURL({ size: 256 }) || null) : null,
  };
}

function snapshotOverwrite(ow) {
  return {
    id: ow.id,
    // 0 = role, 1 = member.
    type: typeof ow.type === 'number' ? ow.type : (ow.type === 'member' ? 1 : 0),
    allow: String(ow.allow && ow.allow.bitfield != null ? ow.allow.bitfield : (ow.allow || 0n)),
    deny:  String(ow.deny  && ow.deny.bitfield  != null ? ow.deny.bitfield  : (ow.deny  || 0n)),
  };
}

function snapshotChannel(ch) {
  const overwrites = ch.permissionOverwrites && ch.permissionOverwrites.cache
    ? [...ch.permissionOverwrites.cache.values()].map(snapshotOverwrite)
    : [];
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    parentId: ch.parentId || null,
    position: ch.rawPosition != null ? ch.rawPosition : (ch.position || 0),
    topic: ch.topic || null,
    nsfw: !!ch.nsfw,
    rateLimitPerUser: ch.rateLimitPerUser || 0,
    bitrate: ch.bitrate || null,
    userLimit: ch.userLimit || null,
    rtcRegion: ch.rtcRegion || null,
    defaultAutoArchiveDuration: ch.defaultAutoArchiveDuration || null,
    overwrites,
  };
}

// The guild's own settings. Small, and the part nobody remembers to write
// down — which channel was the rules channel, what the verification level was.
function snapshotGuildMeta(guild) {
  return {
    name: guild.name,
    description: guild.description || null,
    iconURL: typeof guild.iconURL === 'function' ? (guild.iconURL({ size: 512 }) || null) : null,
    bannerURL: typeof guild.bannerURL === 'function' ? (guild.bannerURL({ size: 1024 }) || null) : null,
    splashURL: typeof guild.splashURL === 'function' ? (guild.splashURL({ size: 1024 }) || null) : null,
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afkTimeout: guild.afkTimeout || null,
    afkChannelId: guild.afkChannelId || null,
    systemChannelId: guild.systemChannelId || null,
    rulesChannelId: guild.rulesChannelId || null,
    publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
    preferredLocale: guild.preferredLocale || null,
    premiumTier: guild.premiumTier || 0,
  };
}

// Builds the whole snapshot from a live guild. Takes the guild rather than the
// client so a test can hand it a plain object with the same shape.
function snapshotGuild(guild) {
  const roles = [...guild.roles.cache.values()]
    .map(snapshotRole)
    // Highest first. Restore walks this order so a role's position lands
    // sensibly even when Discord clamps it under the bot's own top role.
    .sort((a, b) => b.position - a.position);

  const channels = [...guild.channels.cache.values()]
    .filter(c => !THREAD_TYPES.has(c.type))
    .map(snapshotChannel)
    .sort((a, b) => a.position - b.position);

  const emojis = guild.emojis && guild.emojis.cache
    ? [...guild.emojis.cache.values()].map(e => ({
        name: e.name,
        animated: !!e.animated,
        url: typeof e.imageURL === 'function' ? e.imageURL({ size: 128 }) : (e.url || null),
      })).filter(e => e.url)
    : [];

  const stickers = guild.stickers && guild.stickers.cache
    ? [...guild.stickers.cache.values()].map(s => ({
        name: s.name,
        description: s.description || null,
        tags: s.tags || null,
        url: typeof s.url === 'string' ? s.url : null,
      })).filter(s => s.url)
    : [];

  return {
    version: 1,
    sourceGuildId: guild.id,
    guild: snapshotGuildMeta(guild),
    roles, channels, emojis, stickers,
  };
}

function snapshotCounts(snap) {
  const chans = snap.channels || [];
  return {
    roles: (snap.roles || []).filter(isRestorableRole).length,
    categories: chans.filter(c => c.type === CH.GuildCategory).length,
    channels: chans.filter(c => c.type !== CH.GuildCategory).length,
    overwrites: chans.reduce((n, c) => n + (c.overwrites || []).length, 0),
    emojis: (snap.emojis || []).length,
    stickers: (snap.stickers || []).length,
  };
}

// ─── Restore ─────────────────────────────────────────────────────────────────

// @everyone is the guild id, always. It cannot be created and must not be
// treated as missing — its permissions ARE the server's baseline, so it is the
// single most important role in the snapshot and the one a naive
// "create what isn't there" pass would skip entirely.
const isEveryone = (role, sourceGuildId) => role.id === sourceGuildId || role.name === '@everyone';

// A managed role belongs to a bot or an integration. Discord refuses to create
// or edit one, and it comes back on its own when that bot is re-invited —
// trying is a guaranteed error for no gain.
function isRestorableRole(role) {
  return !role.managed;
}

/**
 * Which roles to create, which to update, which to leave alone.
 * Matched by NAME, because an id from another guild means nothing here.
 *
 * Duplicate names are real (two roles called "Member" is legal), so the live
 * side is indexed first-wins and a snapshot role that matches an already-taken
 * live role is treated as a second, separate role to create — rather than two
 * snapshot roles both updating one live role and the second silently undoing
 * the first.
 */
function planRoles(snap, liveRoles) {
  const create = [], update = [], skipped = [];
  const taken = new Set();
  const byName = new Map();
  for (const r of liveRoles) if (!byName.has(r.name)) byName.set(r.name, r);

  for (const role of (snap.roles || [])) {
    if (isEveryone(role, snap.sourceGuildId)) {
      const live = liveRoles.find(r => r.name === '@everyone');
      if (live) update.push({ from: role, to: live, everyone: true });
      continue;
    }
    if (!isRestorableRole(role)) { skipped.push({ role, why: 'managed by a bot or integration' }); continue; }

    const live = byName.get(role.name);
    if (live && !taken.has(live.id)) { taken.add(live.id); update.push({ from: role, to: live }); }
    else create.push(role);
  }
  return { create, update, skipped };
}

/**
 * Categories before the channels inside them — a channel cannot be given a
 * parent that does not exist yet, and Discord will happily create it at the
 * top level instead, which looks like a successful restore and isn't.
 */
function orderChannelsForCreation(channels) {
  const cats = channels.filter(c => c.type === CH.GuildCategory).sort((a, b) => a.position - b.position);
  const rest = channels.filter(c => c.type !== CH.GuildCategory).sort((a, b) => a.position - b.position);
  return cats.concat(rest);
}

/**
 * Same name-matching rule as roles, but scoped to the PARENT: two channels
 * called "general" in different categories are two different channels, and
 * matching on name alone would merge them and lose one.
 */
function planChannels(snap, liveChannels, categoryNameOf) {
  const create = [], update = [];
  const taken = new Set();
  const key = (name, parentName, type) =>
    `${String(parentName || '').toLowerCase()} ${String(name).toLowerCase()} ${type === CH.GuildCategory ? 'cat' : 'ch'}`;

  const snapCatName = new Map();
  for (const c of (snap.channels || [])) if (c.type === CH.GuildCategory) snapCatName.set(c.id, c.name);

  const liveByKey = new Map();
  for (const c of liveChannels) {
    const k = key(c.name, categoryNameOf(c), c.type);
    if (!liveByKey.has(k)) liveByKey.set(k, c);
  }

  for (const ch of orderChannelsForCreation(snap.channels || [])) {
    const parentName = ch.parentId ? (snapCatName.get(ch.parentId) || null) : null;
    const live = liveByKey.get(key(ch.name, parentName, ch.type));
    const entry = { ...ch, parentName };
    if (live && !taken.has(live.id)) { taken.add(live.id); update.push({ from: entry, to: live }); }
    else create.push(entry);
  }
  return { create, update };
}

/**
 * Rewrites a snapshot's permission overwrites for the guild being restored
 * into.
 *
 * `idMap` is old-id → new-id, built from the roles that were created or
 * matched. An overwrite whose subject is not in it is DROPPED, and that is the
 * important half: a role id from another guild is not "probably fine", it is a
 * number that may well name something completely different here, and applying
 * a deny to the wrong role is how a restore locks a server's own staff out of
 * its own channels.
 *
 * Member overwrites (type 1) are kept only when the member id resolves in the
 * target guild — restoring into a fresh server usually means they do not.
 */
function remapOverwrites(overwrites, idMap, memberExists) {
  const kept = [], dropped = [];
  for (const ow of (overwrites || [])) {
    if (ow.type === 1) {
      if (typeof memberExists === 'function' && memberExists(ow.id)) kept.push({ ...ow });
      else dropped.push({ ...ow, why: 'that member is not in this server' });
      continue;
    }
    const mapped = idMap.get(ow.id);
    if (!mapped) { dropped.push({ ...ow, why: 'no matching role in this server' }); continue; }
    kept.push({ ...ow, id: mapped });
  }
  return { kept, dropped };
}

/**
 * Discord refuses to grant a permission the actor does not hold itself, and
 * refuses the whole request when it does — so one permission the bot lacks
 * fails the entire role, not just that bit.
 *
 * Masking here turns "restore failed" into "restore succeeded, minus two
 * permissions we told you about", which is the outcome someone rebuilding a
 * dead server actually wants. The caller reports what was dropped.
 */
function maskPermissions(wanted, botPermissions) {
  const w = BigInt(wanted || 0);
  const b = BigInt(botPermissions || 0);
  const granted = w & b;
  return { granted: granted.toString(), missing: (w & ~b).toString() };
}

/** Names the bits in a bitfield, for telling someone what was dropped. */
function namePermissions(bits, flags) {
  const v = BigInt(bits || 0);
  const out = [];
  for (const [name, flag] of Object.entries(flags || {})) {
    if (typeof flag !== 'bigint' && typeof flag !== 'number') continue;
    const f = BigInt(flag);
    if (f && (v & f) === f) out.push(name);
  }
  return out.sort();
}

/**
 * What a channel-create call needs, filtered to the fields that channel type
 * actually accepts. Sending `bitrate` to a text channel is a 400, and sending
 * `topic` to a voice channel used to be — building the payload per type is
 * what keeps one odd channel from failing the whole restore.
 */
function channelCreatePayload(ch, parentId, overwrites) {
  const base = { name: ch.name, type: ch.type };
  if (parentId) base.parent = parentId;
  if (overwrites && overwrites.length) base.permissionOverwrites = overwrites;

  if (ch.type === CH.GuildText || ch.type === CH.GuildAnnouncement || ch.type === CH.GuildForum || ch.type === CH.GuildMedia) {
    if (ch.topic) base.topic = ch.topic;
    if (ch.nsfw) base.nsfw = true;
    if (ch.rateLimitPerUser) base.rateLimitPerUser = ch.rateLimitPerUser;
  }
  if (ch.type === CH.GuildVoice || ch.type === CH.GuildStageVoice) {
    if (ch.bitrate) base.bitrate = ch.bitrate;
    if (ch.userLimit) base.userLimit = ch.userLimit;
    if (ch.rtcRegion) base.rtcRegion = ch.rtcRegion;
  }
  return base;
}

// ─── Which parts to restore ──────────────────────────────────────────────────
//
// A restore used to be all of it or nothing, and the most common ask is not
// either of those: "put the ROLES back, leave my channels alone." A snapshot
// already counts five separate things on the way in, so those five are what it
// can put back one at a time.
//
// They are not independent, though, and the dependencies are the reason this is
// one selector with warnings attached rather than five separate commands:
//
//   • Permission rules are written in terms of ROLES. Restoring them without
//     the roles is legal and sometimes exactly right — the roles are already
//     here, only the channel permissions were wrecked — but any rule naming a
//     role this server does not have is dropped, because an id from the old
//     guild is not a hint, it is a number that means something else here.
//
//   • A channel's parent is a CATEGORY. Restore channels without categories and
//     anything whose category is missing is created at the top level.
//
//   • Leaving permission rules OUT is the safe direction, not the risky one:
//     `permissionOverwrites.set` is the single call in this whole feature that
//     removes anything. Unticking it means existing channels keep exactly the
//     permissions they have now.
const PART = {
  roles:       { code: 'R', label: 'Roles',            emoji: '🎭', hint: 'Names, colours, permissions. Bot roles are skipped.' },
  categories:  { code: 'C', label: 'Categories',       emoji: '📂', hint: 'The category headers channels live under.' },
  channels:    { code: 'H', label: 'Channels',         emoji: '💬', hint: 'Text, voice, forum. Never any messages.' },
  permissions: { code: 'P', label: 'Permission rules', emoji: '🔒', hint: 'Who can see and do what, per channel.' },
  emojis:      { code: 'E', label: 'Emojis',           emoji: '😀', hint: 'Re-uploaded by name; existing ones are left alone.' },
};
const PART_KEYS = Object.keys(PART);
const ALL_PARTS = PART_KEYS.slice();
const CODE_TO_PART = new Map(PART_KEYS.map(k => [PART[k].code, k]));

// Packed into a button's customId — there is no session store here on purpose,
// so the choice has to survive in the 100 characters Discord allows.
const encodeParts = (parts) => normalizeParts(parts).map(k => PART[k].code).join('');

// Unknown codes are ignored rather than throwing: a button from a message
// posted before a part existed should still restore the parts it does name.
const decodeParts = (s) => {
  const out = [];
  for (const ch of String(s || '')) {
    const k = CODE_TO_PART.get(ch);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
};

// null/undefined means "everything" — that is what a restore was before this
// existed, and what an old button with no parts segment still means. An empty
// LIST is a real, different answer (nothing selected) and stays empty.
function normalizeParts(parts) {
  if (parts == null) return ALL_PARTS.slice();
  const want = new Set(Array.isArray(parts) ? parts : decodeParts(parts));
  return PART_KEYS.filter(k => want.has(k));
}

const hasPart = (parts, key) => normalizeParts(parts).includes(key);

/**
 * A snapshot restored into a server that is not empty can be a big change, and
 * the person clicking it deserves the number before it happens rather than a
 * progress log afterwards.
 *
 * Every line is filtered by what was actually ticked — a plan that promises to
 * create 66 channels when only "Roles" is selected is worse than no plan.
 */
function describePlan(rolePlan, channelPlan, snap, parts) {
  const sel = normalizeParts(parts);
  const on = (k) => sel.includes(k);
  const lines = [];
  const n = (x) => String(x);
  const isCat = (c) => c.type === CH.GuildCategory;

  if (on('roles')) {
    if (rolePlan.create.length) lines.push(`Create ${n(rolePlan.create.length)} role(s)`);
    if (rolePlan.update.length) lines.push(`Update ${n(rolePlan.update.length)} existing role(s)`);
    if (rolePlan.skipped.length) lines.push(`Skip ${n(rolePlan.skipped.length)} bot/integration role(s)`);
  }

  const newCats = channelPlan.create.filter(isCat).length;
  const newChs = channelPlan.create.length - newCats;
  const oldCats = channelPlan.update.filter(u => isCat(u.from)).length;
  const oldChs = channelPlan.update.length - oldCats;

  if (on('categories')) {
    if (newCats) lines.push(`Create ${n(newCats)} categor${newCats === 1 ? 'y' : 'ies'}`);
    // A category has no topic. With the permission rules unticked there is
    // nothing left for an existing one to be updated WITH, so saying it would
    // be updated would be a lie.
    if (oldCats && on('permissions')) lines.push(`Update ${n(oldCats)} existing categor${oldCats === 1 ? 'y' : 'ies'}`);
  }
  if (on('channels')) {
    if (newChs) lines.push(`Create ${n(newChs)} channel(s)`);
    if (oldChs) {
      lines.push(on('permissions')
        ? `Update ${n(oldChs)} existing channel(s)`
        : `Update the topic on ${n(oldChs)} existing channel(s)`);
    }
  }
  if (on('permissions')) {
    const touched = (on('categories') ? newCats + oldCats : 0) + (on('channels') ? newChs + oldChs : 0);
    if (touched) lines.push(`Write the snapshot's permission rules onto ${n(touched)} channel(s)`);
  }
  if (on('emojis') && (snap.emojis || []).length) lines.push(`Re-upload up to ${n(snap.emojis.length)} emoji(s)`);

  if (!lines.length) {
    lines.push(sel.length
      ? 'Nothing to do — this server already matches the snapshot.'
      : 'Nothing selected — tick at least one thing to restore.');
  }
  lines.push('Nothing is ever deleted.');
  return lines;
}

/**
 * What the parts left UNTICKED will do to the parts that were ticked. Said
 * before the button, because every one of these reads as a bug afterwards.
 */
function partWarnings(parts) {
  const sel = normalizeParts(parts);
  const on = (k) => sel.includes(k);
  const out = [];
  if (on('permissions') && !on('roles')) {
    out.push('**Permission rules** without **Roles**: a rule naming a role this server does not already have is dropped. Ids are meaningless across servers, so roles are matched by name.');
  }
  if (on('channels') && !on('categories')) {
    out.push('**Channels** without **Categories**: a new channel whose category is missing here is created at the top level.');
  }
  if (!on('permissions') && (on('channels') || on('categories'))) {
    out.push('**Permission rules** left out: existing channels keep the permissions they have right now — only topics are written. New channels inherit from their category.');
  }
  if (on('permissions') && !on('channels') && !on('categories')) {
    out.push('**Permission rules** with no channels selected: there is nothing to write them onto.');
  }
  return out;
}

module.exports = {
  CH, THREAD_TYPES,
  snapshotGuild, snapshotGuildMeta, snapshotRole, snapshotChannel, snapshotOverwrite, snapshotCounts,
  isEveryone, isRestorableRole,
  planRoles, planChannels, orderChannelsForCreation,
  remapOverwrites, maskPermissions, namePermissions,
  channelCreatePayload, describePlan,
  PART, PART_KEYS, ALL_PARTS, encodeParts, decodeParts, normalizeParts, hasPart, partWarnings,
};
