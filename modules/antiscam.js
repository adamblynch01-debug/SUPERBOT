// ─── Anti-Scam Module (ported from Python) ────────────────────────────────────
'use strict';

const { EmbedBuilder } = require('discord.js');
const db = require('../db');

// ─── Config ────────────────────────────────────────────────────────────────
// These four numbers and the log channel used to be module constants read from
// env at require time — ONE set of thresholds for the whole bot, no matter how
// many servers it was in. The panel has had inputs for all five since it was
// written, they validated, they saved to guild_settings, and the save toast
// said "Saved 19 field(s)". Nothing read them. A setting that persists and is
// never consulted is worse than a missing one: the missing one at least looks
// missing.
//
// They are per-guild now, resolved through a provider index.js installs (see
// setModConfigProvider). The env values below stay as the fallback, so a guild
// that has saved nothing behaves exactly as before.
const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

// LOG_CHANNEL_ID is kept as a STRING. Discord snowflakes are 19 digits — larger
// than Number.MAX_SAFE_INTEGER — so parseInt() silently rounds them
// (…341396 → …341400) and channels.cache.get() then misses every time.
// Moderation logs went nowhere for as long as this was a number.
const ENV_MOD_CONFIG = {
  warningsBeforeBan:   intOr(process.env.WARNINGS_BEFORE_BAN, 3),
  muteDurationMinutes: intOr(process.env.MUTE_DURATION_MINUTES, 30),
  spamMessageLimit:    intOr(process.env.SPAM_MESSAGE_LIMIT, 3),
  spamTimeWindow:      intOr(process.env.SPAM_TIME_WINDOW, 10), // seconds
  logChannelId: process.env.LOG_CHANNEL_ID ? String(process.env.LOG_CHANNEL_ID).trim() : null,
};

// index.js installs the real one; the stub keeps this module usable on its own
// (the tests require it without a database).
let modConfigProvider = async () => null;
function setModConfigProvider(fn) { if (typeof fn === 'function') modConfigProvider = fn; }

// A saved value wins over the env one, but only if it is actually a value —
// `null` is what an unset column reads as, and spreading that over a default
// would blank it.
async function modConfig(guildId) {
  let saved = null;
  try { saved = await modConfigProvider(guildId); }
  catch (e) { console.error('[AntiScam] could not read guild settings:', e.message); }
  const out = { ...ENV_MOD_CONFIG };
  if (saved) for (const [k, v] of Object.entries(saved)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

// ─── Mutable lists (can be changed via commands) ───────────────────────────
let BANNED_LINKS = [
  'stake.com','bc.game','rollbit.com','duelbits.com','prizepicks.com',
  'bovada.lv','pokerbros.net','pulsecasino.com','pedanex.com','pedanet.com',
  'bit.ly','tinyurl.com',
];

let BANNED_WORDS = [
  'nigger','nigga','faggot','retard','chink','spic','kike',
  'fuck','fucking','fucked','fucker','fuck you','shit','bitch',
  'pussy','asshole','bastard','cunt','dick','cock','whore','slut',
];

// ─── Allow-list ────────────────────────────────────────────────────────────
// Links from these hosts are cut out of a message BEFORE any scanning runs.
// klipy.com is the case that prompted this: gif links were being eaten by the
// scam scanner, and there was no way to make an exception short of a code
// change and a redeploy. `!allowlink <domain>` is that way now.
//
// Stripping rather than "skip the whole message" is deliberate — an allowed gif
// pasted next to a scam pitch must not launder the scam pitch.
let ALLOWED_LINKS = [
  'klipy.com',
  'tenor.com', 'giphy.com', 'media.giphy.com',
  'cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net',
  'uhservices.xyz',
];

// How long a banned word costs you. Escalates with repeat offences.
let WORD_TIMEOUT_MINUTES = parseInt(process.env.WORD_TIMEOUT_MINUTES || '10');

// ─── Persistence ───────────────────────────────────────────────────────────
// These lists were memory-only: every `!addlink` / `!addword` staff ran was
// discarded on the next deploy, back to the hardcoded defaults above, with no
// warning that it had happened.
const MOD_GUILD_ID = process.env.GUILD_ID || null;
const LIST_BY_NAME = () => ({
  banned_links:  BANNED_LINKS,
  allowed_links: ALLOWED_LINKS,
  banned_words:  BANNED_WORDS,
});

async function loadModLists() {
  if (!MOD_GUILD_ID) return;
  try {
    const { rows } = await db.query(
      `SELECT list, value FROM mod_lists WHERE guild_id = $1`, [MOD_GUILD_ID]
    );
    // Stored entries are additions on top of the defaults, so a default can
    // never be resurrected by a redeploy after staff removed it: removals are
    // stored too, as a tombstone list.
    const removed = new Set();
    for (const r of rows) {
      if (r.list.startsWith('-')) { removed.add(`${r.list.slice(1)}:${r.value}`); continue; }
      const target = LIST_BY_NAME()[r.list];
      if (target && !target.includes(r.value)) target.push(r.value);
    }
    for (const [name, arr] of Object.entries(LIST_BY_NAME())) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (removed.has(`${name}:${arr[i]}`)) arr.splice(i, 1);
      }
    }
    console.log(`[AntiScam] lists loaded — ${BANNED_LINKS.length} banned links, ${ALLOWED_LINKS.length} allowed, ${BANNED_WORDS.length} words`);
  } catch (e) {
    console.error('[AntiScam] could not load lists:', e.message);
  }
  try {
    const { rows } = await db.query(
      `SELECT word_timeout_minutes FROM mod_settings WHERE guild_id = $1`, [MOD_GUILD_ID]
    );
    if (rows[0]) WORD_TIMEOUT_MINUTES = rows[0].word_timeout_minutes;
  } catch (e) {
    console.error('[AntiScam] could not load settings:', e.message);
  }
}

async function persistListChange(list, value, added, byUserId) {
  if (!MOD_GUILD_ID) return;
  try {
    // Adding clears any tombstone for the same value and vice versa, so the
    // last action staff took is always the one that survives a restart.
    await db.query(`DELETE FROM mod_lists WHERE guild_id = $1 AND list = $2 AND value = $3`,
      [MOD_GUILD_ID, added ? `-${list}` : list, value]);
    await db.query(
      `INSERT INTO mod_lists (guild_id, list, value, added_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id, list, value) DO NOTHING`,
      [MOD_GUILD_ID, added ? list : `-${list}`, value, byUserId ? String(byUserId) : null]
    );
  } catch (e) {
    console.error('[AntiScam] could not persist list change:', e.message);
  }
}

async function persistWordTimeout(minutes) {
  if (!MOD_GUILD_ID) return;
  try {
    await db.query(
      `INSERT INTO mod_settings (guild_id, word_timeout_minutes, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (guild_id) DO UPDATE SET word_timeout_minutes = EXCLUDED.word_timeout_minutes, updated_at = now()`,
      [MOD_GUILD_ID, minutes]
    );
  } catch (e) {
    console.error('[AntiScam] could not persist word timeout:', e.message);
  }
}

const SCAM_KEYWORD_PATTERNS = [
  /\bpromo\s*code\b/i,/\bactivate\s*code\b/i,/\bbonus\s*code\b/i,
  /\bcasino\b/i,/\bgambling\b/i,/\bsports?bet\b/i,/\bpokerbros\b/i,
  /\bpulse\s*casino\b/i,/\bstake\.com\b/i,/\bbc\.game\b/i,
  /\brollbit\b/i,/\bduelbits\b/i,/\bprizepicks\b/i,/\bbovada\b/i,
  /\bgiving away\s*\$[\d,]+\b/i,/\bclaim\s*(your\s*)?(reward|bonus|prize)\b/i,
  /\bwithdrawal\s*success\b/i,/\bwithdraw\s*(instantly|now)\b/i,
  /\bfree\s*(crypto|bitcoin|btc|eth|usdt)\b/i,/\bsend\s*\d+\s*(btc|eth|usdt|crypto)\b/i,
  /\bdouble\s*your\s*(crypto|bitcoin|money)\b/i,/\bkai\s*cenat\b/i,
  /\b@kaicenat\b/i,/\bcenat\b/i,/\bany\s*means\s*possible\b/i,
  /bit\.ly\//i,/tinyurl\.com\//i,/t\.co\/[a-z0-9]+/i,
  /\bclick\s*here\s*to\s*claim\b/i,/\b(pedanex|pedanet|pedanes)\.com\b/i,
  /\b\w+(casino|bet|stake|gambling)\w*\.com\b/i,
];
const KEYWORD_THRESHOLD = 2;

const INSTANT_DELETE_PHRASES = [
  'withdrawal success','activate code for bonus','enter the promo code',
  'giving away $2,500','giving away $2500','promo code: cenat','promo code cenat',
  'launch of my very own crypto casino',
];

// ─── State ─────────────────────────────────────────────────────────────────
// Keyed by GUILD and user, not user alone. With one key per user, a warning
// earned on the store server counted towards a ban on the second one — three
// servers' worth of first offences and you are banned from a server you have
// never misbehaved in. Warnings are a fact about a member, and a member is a
// person in a particular guild.
const userWarnings   = new Map(); // `${guildId}:${userId}` -> count
const userScamTimes  = new Map(); // `${guildId}:${userId}` -> [timestamps]
const modKey = (guildId, userId) => `${guildId}:${userId}`;

// ─── Detection helpers ─────────────────────────────────────────────────────
// Cut every allow-listed URL out of the text before anything looks at it. Note
// the host check is anchored to the end of the hostname: an allow-list entry of
// `tenor.com` must not also permit `tenor.com.evil.ru`, which is the standard
// way an allow-list gets turned inside out.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi;

function isAllowedUrl(raw) {
  let host;
  try {
    host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_LINKS.some(d => {
    const dom = String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return host === dom || host.endsWith(`.${dom}`);
  });
}

function stripAllowedLinks(content) {
  return String(content || '').replace(URL_RE, m => (isAllowedUrl(m) ? ' ' : m));
}

function isScam(content) {
  const text = content.toLowerCase();
  for (const phrase of INSTANT_DELETE_PHRASES) {
    if (text.includes(phrase)) return { scam: true, reason: `Instant-delete phrase: "${phrase}"` };
  }
  const matched = SCAM_KEYWORD_PATTERNS.filter(p => p.test(content));
  if (matched.length >= KEYWORD_THRESHOLD)
    return { scam: true, reason: `${matched.length} scam patterns matched` };
  return { scam: false, reason: '' };
}

function hasBannedLink(content) {
  const text = content.toLowerCase();
  for (const domain of BANNED_LINKS)
    if (text.includes(domain)) return { found: true, reason: `Banned link: ${domain}` };
  return { found: false, reason: '' };
}

function hasProfanity(content) {
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(content)) return { found: true, word };
  }
  return { found: false, word: null };
}

function isSpamFlood(guildId, userId, cfg) {
  const now  = Date.now();
  const key  = modKey(guildId, userId);
  const cutoff = now - cfg.spamTimeWindow * 1000;
  const times = (userScamTimes.get(key) || []).filter(t => t > cutoff);
  times.push(now);
  userScamTimes.set(key, times);
  return times.length >= cfg.spamMessageLimit;
}

// ─── Embed builders ────────────────────────────────────────────────────────
function banEmbed(user, reason, warnCount, channel, maxWarn) {
  const e = new EmbedBuilder()
    .setTitle('🔨 User Banned').setColor(0xFF0000).setTimestamp()
    .setAuthor({ name: `${user.tag} was banned`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',     value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',  value: `\`${user.id}\``,           inline: true },
      { name: '⚠️ Warnings', value: `\`${warnCount}/${maxWarn}\``, inline: true },
      { name: '📋 Reason',   value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Ban Log' });
  if (channel) e.addFields({ name: '📍 Channel', value: channel.toString(), inline: true });
  return e;
}

function timeoutEmbed(user, reason, durMins, channel) {
  const e = new EmbedBuilder()
    .setTitle('🔇 User Timed Out').setColor(0xFF8C00).setTimestamp()
    .setAuthor({ name: `${user.tag} was timed out`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',      value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',   value: `\`${user.id}\``,           inline: true },
      { name: '⏱️ Duration',  value: `\`${durMins} minutes\``,   inline: true },
      { name: '📋 Reason',    value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Timeout Log' });
  if (channel) e.addFields({ name: '📍 Channel', value: channel.toString(), inline: true });
  return e;
}

function scamDeleteEmbed(user, reason, content, warnCount, channel, maxWarn) {
  const e = new EmbedBuilder()
    .setTitle('🚨 Scam Message Deleted').setColor(0xFFA500).setTimestamp()
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',     value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',  value: `\`${user.id}\``,           inline: true },
      { name: '⚠️ Warnings', value: `\`${warnCount}/${maxWarn}\``, inline: true },
      { name: '📍 Channel',  value: channel.toString(),         inline: true },
      { name: '📋 Reason',   value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Scam Log' });
  if (content) e.addFields({ name: '💬 Message', value: `\`\`\`${content.slice(0, 400)}\`\`\``, inline: false });
  return e;
}

function spamBanEmbed(user, reason, deletedCount) {
  return new EmbedBuilder()
    .setTitle('🚫 Spammer Banned').setColor(0x8B0000).setTimestamp()
    .setAuthor({ name: `${user.tag} was banned for spam flooding`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',                value: `\`${user.tag}\``,     inline: true },
      { name: '🪪 User ID',             value: `\`${user.id}\``,      inline: true },
      { name: '🗑️ Messages Deleted',   value: `\`${deletedCount}\``, inline: true },
      { name: '📋 Reason',              value: `Spam flood — ${reason.slice(0, 400)}`, inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Spam Ban Log' });
}

// ─── Handlers ──────────────────────────────────────────────────────────────
// A guild only complains about its missing log channel once per boot. Silence
// was the whole problem here: on the second server the configured id belonged
// to the FIRST server, so channels.cache.get() missed on every single call and
// moderation ran invisibly. That lookup is per-guild, so it was never going to
// throw — it just returned undefined, forever.
const warnedNoLog = new Set();
async function sendLog(guild, client, embed, cfg) {
  const id = cfg && cfg.logChannelId;
  if (!id) {
    if (!warnedNoLog.has(guild.id)) {
      warnedNoLog.add(guild.id);
      console.warn(`[AntiScam] ${guild.name}: no log channel — set it in the panel (Settings → Log channel). Moderation is running unlogged.`);
    }
    return;
  }
  const ch = guild.channels.cache.get(String(id));
  if (!ch) {
    if (!warnedNoLog.has(guild.id)) {
      warnedNoLog.add(guild.id);
      console.warn(`[AntiScam] ${guild.name}: log channel ${id} is not a channel in this server — it probably belongs to another one. Set it in the panel.`);
    }
    return;
  }
  try { await ch.send({ embeds: [embed] }); } catch (_) {}
}

async function handleSpamFlood(message, reason, client, cfg) {
  const { guild, author } = message;
  let deletedCount = 0;
  for (const [, ch] of guild.channels.cache) {
    if (ch.type !== 0) continue; // GuildText only
    try {
      const msgs = [];
      const fetched = await ch.messages.fetch({ limit: 100 });
      fetched.forEach(m => { if (m.author.id === author.id) msgs.push(m); });
      if (msgs.length === 1) { await msgs[0].delete(); deletedCount++; }
      else if (msgs.length > 1) { await ch.bulkDelete(msgs); deletedCount += msgs.length; }
    } catch (_) {}
  }
  try {
    await guild.ban(author, { reason: `Spam flood: ${reason}`, deleteMessageSeconds: 86400 });
    await sendLog(guild, client, spamBanEmbed(author, reason, deletedCount), cfg);
    userScamTimes.delete(modKey(guild.id, author.id));
    userWarnings.delete(modKey(guild.id, author.id));
  } catch (_) {}
}

async function handleViolation(message, reason, client, cfg) {
  const { guild, author, channel } = message;
  try { await message.delete(); } catch (_) { return; }

  const key = modKey(guild.id, author.id);
  const count = (userWarnings.get(key) || 0) + 1;
  userWarnings.set(key, count);
  await sendLog(guild, client, scamDeleteEmbed(author, reason, message.content, count, channel, cfg.warningsBeforeBan), cfg);

  if (cfg.warningsBeforeBan > 0 && count >= cfg.warningsBeforeBan) {
    try { await author.send(`🔨 **You have been banned from ${guild.name}.**\nReason: ${count} violations — ${reason}`); } catch (_) {}
    try {
      await guild.ban(author, { reason: `${count} warnings: ${reason}`, deleteMessageSeconds: 86400 });
      await sendLog(guild, client, banEmbed(author, reason, count, channel, cfg.warningsBeforeBan), cfg);
      userWarnings.delete(key);
      userScamTimes.delete(key);
    } catch (_) {}
    return;
  }

  try {
    await author.send(
      `⚠️ **Your message in ${guild.name} was removed.**\nReason: ${reason}\nWarning **${count}/${cfg.warningsBeforeBan}** — continued violations will result in a ban.`
    );
  } catch (_) {}

  if (count === 1 && cfg.muteDurationMinutes > 0) {
    try {
      const until = new Date(Date.now() + cfg.muteDurationMinutes * 60 * 1000);
      await message.member.timeout(until.getTime() - Date.now(), reason);
      await sendLog(guild, client, timeoutEmbed(author, reason, cfg.muteDurationMinutes, channel), cfg);
    } catch (_) {}
  }
}

// Banned words get their own path. The generic violation handler only ever
// timed a member out on their FIRST offence (`count === 1`) and let every
// subsequent one through with a DM, which is backwards — a repeat offender
// served less time than a first-timer. Here the timeout always applies and
// doubles with each offence, and the ban threshold still ends it.
async function handleBannedWord(message, word, client, cfg) {
  const { guild, author, channel, member } = message;
  try { await message.delete(); } catch (_) { /* already gone */ }

  const key    = modKey(guild.id, author.id);
  const count  = (userWarnings.get(key) || 0) + 1;
  userWarnings.set(key, count);
  const reason = `Banned word — "${word}"`;

  await sendLog(guild, client, scamDeleteEmbed(author, reason, message.content, count, channel, cfg.warningsBeforeBan), cfg);

  if (cfg.warningsBeforeBan > 0 && count >= cfg.warningsBeforeBan) {
    try { await author.send(`🔨 **You have been banned from ${guild.name}.**\nReason: ${count} violations — ${reason}`); } catch (_) {}
    try {
      await guild.ban(author, { reason: `${count} warnings: ${reason}`, deleteMessageSeconds: 86400 });
      await sendLog(guild, client, banEmbed(author, reason, count, channel, cfg.warningsBeforeBan), cfg);
      userWarnings.delete(key);
      userScamTimes.delete(key);
    } catch (_) {}
    return;
  }

  // Discord's own ceiling is 28 days; nothing here should approach it, but the
  // doubling makes that worth clamping rather than assuming.
  const mins = Math.min(WORD_TIMEOUT_MINUTES * Math.pow(2, count - 1), 60 * 24 * 7);
  let timedOut = false;
  if (mins > 0 && member) {
    try {
      await member.timeout(mins * 60 * 1000, reason);
      timedOut = true;
      await sendLog(guild, client, timeoutEmbed(author, reason, mins, channel), cfg);
    } catch (e) {
      // Missing Moderate Members, or the member outranks the bot. Say so in the
      // log instead of failing silently — a filter everyone believes is on and
      // isn't is worse than no filter.
      console.error('[AntiScam] timeout failed for', author.tag, '-', e.message);
    }
  }

  try {
    await author.send(
      `⚠️ **Your message in ${guild.name} was removed.**\nReason: ${reason}\n` +
      (timedOut ? `You have been timed out for **${mins} minute(s)**.\n` : '') +
      `Warning **${count}/${cfg.warningsBeforeBan}** — continued violations will result in a ban.`
    );
  } catch (_) {}
}

// ─── Main message handler (call from index.js on_message) ─────────────────
async function onMessage(message, client) {
  if (message.author.bot || !message.guild) return;
  if (message.member?.permissions.has('Administrator')) return;
  const raw = message.content || '';
  // Everything below scans the message with allow-listed links removed.
  const content = stripAllowedLinks(raw);

  // Detection first, config second. The scanners are pure and cost nothing;
  // resolving the config is a (cached) settings read, and the overwhelming
  // majority of messages are clean, so paying for it up front would mean one
  // settings lookup per message in the server.
  const { found: profane, word } = hasProfanity(content);
  if (profane) { await handleBannedWord(message, word, client, await modConfig(message.guild.id)); return; }

  const { found: hasLink, reason: linkReason } = hasBannedLink(content);
  if (hasLink) { await handleViolation(message, linkReason, client, await modConfig(message.guild.id)); return; }

  if (message.attachments.size > 0 && !content.trim()) return;

  const { scam, reason: scamReason } = isScam(content);
  if (scam) {
    const cfg = await modConfig(message.guild.id);
    if (isSpamFlood(message.guild.id, message.author.id, cfg)) await handleSpamFlood(message, scamReason, client, cfg);
    else await handleViolation(message, scamReason, client, cfg);
  }
}

// ─── Prefix commands (called from index.js command handler) ────────────────
async function handlePrefixCommand(message, client) {
  if (!message.content.startsWith('!')) return false;
  const args   = message.content.slice(1).trim().split(/\s+/);
  const cmd    = args.shift().toLowerCase();
  const member = message.member;
  const hasManage = member?.permissions.has('ManageMessages');
  const hasKick   = member?.permissions.has('KickMembers');
  const hasManageCh = member?.permissions.has('ManageChannels');

  if (cmd === 'bothelp') {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Anti-Scam — Command List').setColor(0x5865f2).setTimestamp()
      .addFields(
        { name: '⚙️ General',        value: '`!bothelp` — Show this menu\n`!manage` — Bot management panel\n`!scamcheck <text>` — Test if text gets flagged', inline: false },
        { name: '🔨 Moderation',     value: '`!nuke` — Wipe all messages in channel\n`!warnings @user` — Check warning count\n`!clearwarnings @user` — Reset warnings', inline: false },
        { name: '🔗 Banned Links',   value: '`!addlink example.com` — Ban a domain\n`!removelink example.com` — Unban a domain\n`!listlinks` — Show all banned domains', inline: false },
        { name: '✅ Allowed Links',  value: '`!allowlink klipy.com` — Never filter this domain\n`!unallowlink klipy.com` — Stop allowing it\n`!listallowed` — Show the allow-list', inline: false },
        { name: '🤬 Banned Words',   value: '`!addword badword` — Add to filter\n`!removeword badword` — Remove from filter\n`!listwords` — Show the filter\n`!setwordtimeout 10` — Minutes of timeout per offence', inline: false },
      )
      .setFooter({ text: 'Requires Manage Messages permission for most commands.' });
    await message.channel.send({ embeds: [embed] });
    return true;
  }

  if (cmd === 'manage' && hasManage) {
    // THIS server's numbers. The panel shows one set per server and so must
    // this — a management panel reporting another guild's thresholds is how you
    // end up certain a setting saved when it did not.
    const cfg = await modConfig(message.guild.id);
    const logHere = cfg.logChannelId && message.guild.channels.cache.has(String(cfg.logChannelId));
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Anti-Scam Bot — Management Panel').setColor(0x00008B).setTimestamp()
      .addFields(
        { name: '🔧 Current Settings', value:
          `**Warnings before ban:** \`${cfg.warningsBeforeBan}\`\n`
          + `**Timeout duration:** \`${cfg.muteDurationMinutes} minutes\`\n`
          + `**Spam limit:** \`${cfg.spamMessageLimit} messages in ${cfg.spamTimeWindow}s\`\n`
          + `**Log channel:** ${logHere ? `<#${cfg.logChannelId}>`
              : cfg.logChannelId ? `\`${cfg.logChannelId}\` ⚠️ not a channel in this server`
              : '`Not set`'}`,
          inline: false },
        { name: `🔗 Banned Links (${BANNED_LINKS.length})`,
          value: BANNED_LINKS.slice(0, 10).map(d => `\`${d}\``).join('\n') + (BANNED_LINKS.length > 10 ? `\n_...and ${BANNED_LINKS.length-10} more_` : '') || '`None`',
          inline: false },
        { name: `✅ Allowed Links (${ALLOWED_LINKS.length})`,
          value: ALLOWED_LINKS.slice(0, 10).map(d => `\`${d}\``).join('\n') + (ALLOWED_LINKS.length > 10 ? `\n_...and ${ALLOWED_LINKS.length-10} more_` : '') || '`None`',
          inline: false },
        { name: `🤬 Profanity Filter (${BANNED_WORDS.length} words)`,
          value: `\`[hidden — use !listwords]\`\n**Timeout per offence:** \`${WORD_TIMEOUT_MINUTES === 0 ? 'disabled' : `${WORD_TIMEOUT_MINUTES} min (doubles on repeat)`}\``,
          inline: false },
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: `Requested by ${message.author.tag} • Anti-Scam Bot` });
    await message.channel.send({ embeds: [embed] });
    return true;
  }

  if (cmd === 'scamcheck' && hasManage) {
    const raw  = args.join(' ');
    // Strip first, exactly as onMessage does — otherwise this reports a verdict
    // the live filter would never reach, which is worse than no test at all.
    const text = stripAllowedLinks(raw);
    const stripped = text !== raw;
    const { scam, reason } = isScam(text);
    const { found: link, reason: lr } = hasBannedLink(text);
    const { found: prof } = hasProfanity(text);
    const note = stripped ? '\n_(an allow-listed link was removed before scanning)_' : '';
    if (prof) await message.channel.send(`✅ **Profanity flagged.** → ${WORD_TIMEOUT_MINUTES === 0 ? 'delete only' : `${WORD_TIMEOUT_MINUTES} min timeout`}${note}`);
    else if (scam) await message.channel.send(`✅ **Scam flagged.** ${reason}${note}`);
    else if (link) await message.channel.send(`✅ **Banned link flagged.** ${lr}${note}`);
    else await message.channel.send(`❌ **Would NOT be flagged.**${note}`);
    return true;
  }

  // Both of these read and write the same guild-scoped key the handlers do.
  // While the map was keyed on the user alone, !clearwarnings run by a mod on
  // one server also cleared the record on the other.
  if (cmd === 'clearwarnings' && hasKick) {
    const user = message.mentions.users.first();
    if (user) {
      userWarnings.delete(modKey(message.guild.id, user.id));
      userScamTimes.delete(modKey(message.guild.id, user.id));
      await message.channel.send(`✅ Cleared warnings for ${user} in **${message.guild.name}**`);
    }
    return true;
  }

  if (cmd === 'warnings' && hasManage) {
    const user = message.mentions.users.first();
    if (user) {
      const cfg = await modConfig(message.guild.id);
      const n = userWarnings.get(modKey(message.guild.id, user.id)) || 0;
      await message.channel.send(`⚠️ ${user} has **${n}/${cfg.warningsBeforeBan}** warning(s) in this server.`);
    }
    return true;
  }

  if (cmd === 'addlink' && hasManage && args[0]) {
    const domain = args[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (BANNED_LINKS.includes(domain)) { await message.channel.send(`\`${domain}\` is already banned.`); return true; }
    // Banning something that is explicitly allowed would be a no-op — the
    // allow-list strips the URL before the ban list ever sees it.
    const aIdx = ALLOWED_LINKS.indexOf(domain);
    if (aIdx !== -1) {
      ALLOWED_LINKS.splice(aIdx, 1);
      await persistListChange('allowed_links', domain, false, message.author.id);
    }
    BANNED_LINKS.push(domain);
    await persistListChange('banned_links', domain, true, message.author.id);
    await message.channel.send(aIdx !== -1
      ? `✅ Added \`${domain}\` to banned links — and removed it from the allow-list.`
      : `✅ Added \`${domain}\` to banned links.`);
    return true;
  }

  if (cmd === 'removelink' && hasManage && args[0]) {
    const domain = args[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const idx = BANNED_LINKS.indexOf(domain);
    if (idx !== -1) {
      BANNED_LINKS.splice(idx, 1);
      await persistListChange('banned_links', domain, false, message.author.id);
      await message.channel.send(`✅ Removed \`${domain}\` from banned links.`);
    } else await message.channel.send(`\`${domain}\` was not in the list.`);
    return true;
  }

  if (cmd === 'listlinks' && hasManage) {
    if (BANNED_LINKS.length) await message.channel.send(`🔗 **Banned links:**\n${BANNED_LINKS.map(d => `• \`${d}\``).join('\n').slice(0, 1800)}`);
    else await message.channel.send('No banned links configured.');
    return true;
  }

  // Multi-word phrases are supported: `!addword fuck you` bans the phrase, not
  // the two words separately.
  if (cmd === 'addword' && hasManage && args[0]) {
    const word = args.join(' ').toLowerCase();
    if (!BANNED_WORDS.includes(word)) {
      BANNED_WORDS.push(word);
      await persistListChange('banned_words', word, true, message.author.id);
      // Deleted, not echoed: repeating the word back into the channel is the
      // thing the filter exists to prevent.
      try { if (message.deletable) await message.delete(); } catch (_) {}
      await message.channel.send(`✅ Added to the banned-word filter (${BANNED_WORDS.length} total). Offenders are timed out for **${WORD_TIMEOUT_MINUTES} min**, doubling each repeat.`);
    } else await message.channel.send('Already in filter.');
    return true;
  }

  if (cmd === 'removeword' && hasManage && args[0]) {
    const word = args.join(' ').toLowerCase();
    const idx = BANNED_WORDS.indexOf(word);
    if (idx !== -1) {
      BANNED_WORDS.splice(idx, 1);
      await persistListChange('banned_words', word, false, message.author.id);
      try { if (message.deletable) await message.delete(); } catch (_) {}
      await message.channel.send(`✅ Removed from the banned-word filter (${BANNED_WORDS.length} left).`);
    } else await message.channel.send('Not found in filter.');
    return true;
  }

  if (cmd === 'listwords' && hasManage) {
    if (!BANNED_WORDS.length) { await message.channel.send('No banned words configured.'); return true; }
    // DM'd, for the same reason the add is deleted.
    try {
      await message.author.send(`🤬 **Banned words (${BANNED_WORDS.length}):**\n${BANNED_WORDS.map(w => `• \`${w}\``).join('\n').slice(0, 1800)}`);
      await message.channel.send(`📬 Sent you the list (${BANNED_WORDS.length} entries).`);
    } catch {
      await message.channel.send('❌ Could not DM you — open your DMs and try again.');
    }
    return true;
  }

  if (cmd === 'setwordtimeout' && hasManage && args[0]) {
    const mins = parseInt(args[0], 10);
    if (!Number.isFinite(mins) || mins < 0 || mins > 10080) {
      await message.channel.send('❌ Give a number of minutes between 0 and 10080 (7 days). `0` disables the timeout.');
      return true;
    }
    WORD_TIMEOUT_MINUTES = mins;
    await persistWordTimeout(mins);
    await message.channel.send(mins === 0
      ? '✅ Banned words will no longer time anyone out (messages are still deleted).'
      : `✅ Banned words now cost **${mins} minute(s)**, doubling on each repeat offence.`);
    return true;
  }

  // ── Allow-list ────────────────────────────────────────────────────────────
  if (cmd === 'allowlink' && hasManage && args[0]) {
    const domain = args[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (ALLOWED_LINKS.includes(domain)) { await message.channel.send(`\`${domain}\` is already allowed.`); return true; }
    ALLOWED_LINKS.push(domain);
    await persistListChange('allowed_links', domain, true, message.author.id);
    // A domain cannot be on both lists — allowing it here would otherwise be
    // silently overruled on the next message.
    const bIdx = BANNED_LINKS.indexOf(domain);
    if (bIdx !== -1) {
      BANNED_LINKS.splice(bIdx, 1);
      await persistListChange('banned_links', domain, false, message.author.id);
      await message.channel.send(`✅ \`${domain}\` is now allowed — and was removed from the banned list.`);
    } else {
      await message.channel.send(`✅ \`${domain}\` is now allowed. Links from it (and its subdomains) are never filtered.`);
    }
    return true;
  }

  if ((cmd === 'unallowlink' || cmd === 'removeallowlink') && hasManage && args[0]) {
    const domain = args[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const idx = ALLOWED_LINKS.indexOf(domain);
    if (idx !== -1) {
      ALLOWED_LINKS.splice(idx, 1);
      await persistListChange('allowed_links', domain, false, message.author.id);
      await message.channel.send(`✅ \`${domain}\` is no longer allowed.`);
    } else await message.channel.send(`\`${domain}\` was not on the allow-list.`);
    return true;
  }

  if (cmd === 'listallowed' && hasManage) {
    if (ALLOWED_LINKS.length) await message.channel.send(`✅ **Allowed links:**\n${ALLOWED_LINKS.map(d => `• \`${d}\``).join('\n').slice(0, 1800)}`);
    else await message.channel.send('No allowed links configured.');
    return true;
  }

  if (cmd === 'nuke' && hasManageCh) {
    const ch = message.channel;
    const newCh = await ch.clone({ reason: `Nuked by ${message.author.tag}` });
    await newCh.setPosition(ch.position);
    await ch.delete({ reason: `Nuked by ${message.author.tag}` });
    const embed = new EmbedBuilder()
      .setTitle('💥 Channel Nuked')
      .setDescription(`This channel was nuked by ${message.author}.\nAll previous messages have been wiped.`)
      .setColor(0xFF8C00).setTimestamp();
    const msg = await newCh.send({ embeds: [embed] });
    setTimeout(() => msg.delete().catch(() => {}), 5000);
    return true;
  }

  return false;
}

module.exports = {
  onMessage, handlePrefixCommand, loadModLists, setModConfigProvider,
  BANNED_LINKS, ALLOWED_LINKS, BANNED_WORDS, userWarnings,
  // Exported for test_antiscam_perguild.js: the thresholds are per-guild now,
  // and the resolution order (saved value beats env, null does NOT) is the part
  // that decides whether the panel's Settings tab does anything at all.
  _config: { modConfig, ENV_MOD_CONFIG, modKey, isSpamFlood, userScamTimes },
  // Exported for test_antiscam_lists.js — the allow-list is the one piece here
  // that can be turned inside out by a lookalike hostname, so it gets asserted.
  _internals: { stripAllowedLinks, isAllowedUrl, hasProfanity, hasBannedLink, isScam },
};
