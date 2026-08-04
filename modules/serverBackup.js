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

/**
 * A snapshot restored into a server that is not empty can be a big change, and
 * the person clicking it deserves the number before it happens rather than a
 * progress log afterwards.
 */
function describePlan(rolePlan, channelPlan, snap) {
  const lines = [];
  const n = (x) => String(x);
  if (rolePlan.create.length) lines.push(`Create ${n(rolePlan.create.length)} role(s)`);
  if (rolePlan.update.length) lines.push(`Update ${n(rolePlan.update.length)} existing role(s)`);
  if (rolePlan.skipped.length) lines.push(`Skip ${n(rolePlan.skipped.length)} bot/integration role(s)`);
  const newCats = channelPlan.create.filter(c => c.type === CH.GuildCategory).length;
  const newChs = channelPlan.create.length - newCats;
  if (newCats) lines.push(`Create ${n(newCats)} categor(y/ies)`);
  if (newChs) lines.push(`Create ${n(newChs)} channel(s)`);
  if (channelPlan.update.length) lines.push(`Update ${n(channelPlan.update.length)} existing channel(s)`);
  if ((snap.emojis || []).length) lines.push(`Re-upload up to ${n(snap.emojis.length)} emoji(s)`);
  if (!lines.length) lines.push('Nothing to do — this server already matches the snapshot.');
  lines.push('Nothing is ever deleted.');
  return lines;
}

module.exports = {
  CH, THREAD_TYPES,
  snapshotGuild, snapshotGuildMeta, snapshotRole, snapshotChannel, snapshotOverwrite, snapshotCounts,
  isEveryone, isRestorableRole,
  planRoles, planChannels, orderChannelsForCreation,
  remapOverwrites, maskPermissions, namePermissions,
  channelCreatePayload, describePlan,
};
