// ─── Who counts as staff, PER GUILD ──────────────────────────────────────────
//
// The bot serves two servers and each has its own 👁️ OVERSEER role with its own
// id. Every gate here used to compare against ONE id, so it was correct in at
// most one of them: `STAFF_ROLE_ID` is Ticket Staff in 𝗨𝗻𝗸𝗻𝗼𝘄𝗻 𝗛𝗮𝗰𝗸𝗶𝗻𝗴™, an id
// that does not exist in the store server at all. An OVERSEER role created
// there therefore granted nothing, and the only thing letting anyone in was
// Administrator — the exact permission the access audit was raised about. The
// symptom of that bug is indistinguishable from "the bot ignores my role", and
// nothing anywhere said so.
//
// A single id shared between two guilds is not a config value. It is a
// coincidence that held while there was one guild.
'use strict';

// `guildId:roleId:roleId,guildId:roleId` — several roles per guild, several
// guilds per string. Anything malformed is dropped rather than guessed at:
// this string decides who can run /config and /web-balance adjust.
function parseStaffRoleMap(raw) {
  const out = {};
  for (const chunk of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [guildId, ...roleIds] = chunk.split(':').map(s => s.trim()).filter(Boolean);
    if (guildId && roleIds.length) out[guildId] = roleIds;
  }
  return out;
}

const STAFF_ROLE_DEFAULTS = {
  '1242128831092101201': ['1518372339115360358'], // 𝗨𝗻𝗸𝗻𝗼𝘄𝗻 𝗛𝗮𝗰𝗸𝗶𝗻𝗴™ · 👁️ OVERSEER
  '1511517606954139711': ['1534313431547510865'], // 𝐎𝐧𝐓𝐨𝐩 | 𝐃𝐢𝐠𝐢𝐭𝐚𝐥 𝐒𝐭𝐨𝐫𝐞 · 👁️ OVERSEER
};

/**
 * @param {object} o
 * @param {string} o.primaryGuildId          GUILD_ID — the server the bot was written for
 * @param {string} [o.envMapRaw]             STAFF_ROLE_IDS
 * @param {string} [o.staffRoleId]           STAFF_ROLE_ID — the legacy single id
 * @param {string} [o.legacyOverseerRoleId]  OVERSEER_ROLE_ID — the legacy single id
 * @param {function} [o.getCachedOverseerRoleId] (guildId) => roleId|null, from the
 *        settings cache. Consulted only when already warm — see below.
 * @param {object} [o.defaults]              override STAFF_ROLE_DEFAULTS (tests)
 */
function makeStaffRoleResolver({
  primaryGuildId, envMapRaw, staffRoleId, legacyOverseerRoleId,
  getCachedOverseerRoleId, defaults = STAFF_ROLE_DEFAULTS,
} = {}) {
  const envMap = parseStaffRoleMap(envMapRaw);

  // For the async callers that already load settings (stock access, gen
  // limits): this guild's OVERSEER, falling back to something sensible so a
  // server nobody has opened the panel for still behaves.
  function defaultOverseerRoleId(guildId) {
    const configured = (envMap[guildId] || defaults[guildId] || [])[0];
    if (configured) return configured;
    return guildId === primaryGuildId ? (legacyOverseerRoleId || null) : null;
  }

  // Deliberately SYNCHRONOUS. hasAccess() is sync at ~70 call sites and every
  // one of them reads `if (!hasAccess(interaction))`. Making it async without
  // touching all of them returns a Promise, `!Promise` is false, and the gate
  // silently opens to everyone — the worst possible failure for this exact
  // function. So the settings cache is read only when it is already warm, and
  // everything else needs no I/O.
  function staffRoleIdsFor(guildId) {
    const ids = [];
    if (typeof getCachedOverseerRoleId === 'function') {
      try { const c = getCachedOverseerRoleId(guildId); if (c) ids.push(c); } catch (_) {}
    }
    ids.push(...(envMap[guildId] || defaults[guildId] || []));
    // Kept, and kept SCOPED to the guild it was actually set for. It is Ticket
    // Staff there and those people have had access all along; widening it to a
    // second server was never intended, and narrowing it in the first would
    // take access away from someone who has it today.
    if (guildId === primaryGuildId && staffRoleId) ids.push(String(staffRoleId));
    return [...new Set(ids.filter(Boolean).map(String))];
  }

  return { staffRoleIdsFor, defaultOverseerRoleId, envMap };
}

module.exports = { parseStaffRoleMap, makeStaffRoleResolver, STAFF_ROLE_DEFAULTS };
