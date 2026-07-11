/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          UH SERVICES — SUPER BOT  v2.0.0            ║
 * ║  Combines: Verify/Welcome • Updates • Anti-Scam     ║
 * ║            DM Support • 2FA Auth Server             ║
 * ╚══════════════════════════════════════════════════════╝
 */
'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  PermissionFlagsBits, ChannelType, AttachmentBuilder,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const { createCanvas, loadImage } = require('canvas');
const fs   = require('fs');
const path = require('path');

// ─── Modules ─────────────────────────────────────────────────────────────────
const antiscam   = require('./modules/antiscam');
const support    = require('./modules/support');
const { startAuthServer, handle2FAInteraction } = require('./modules/auth2fa');
const { getAllProducts, getProduct, setProductUrl, getProductChunks, getProductByName } = require('./modules/downloads');

// ─── ENV Config ───────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const GUILD_ID       = process.env.GUILD_ID || null;

// Verify/Welcome module
const VERIFIED_ROLE  = process.env.VERIFIED_ROLE_NAME  || 'Verified';
const VERIFY_CHANNEL = process.env.VERIFY_CHANNEL_NAME || 'get-verify';
const WELCOME_CHANNEL= process.env.WELCOME_CHANNEL_NAME|| 'welcome';
const WELCOME_CHANNEL_ID = '1400773021274341396';
const INVITES_CHANNEL_ID = '1482585544998256781';
const INVITES_CHANNEL= process.env.INVITES_CHANNEL_NAME|| 'invites';
const INVITES_NEEDED = parseInt(process.env.INVITES_NEEDED || '10');

// Updates module
const BOT_NAME  = process.env.BOT_NAME  || 'UH Services';
const SITE_URL  = process.env.SITE_URL  || '';

// Vouch module
const LEAVE_VOUCH_CHANNEL_ID = '1522983274417360896'; // #leave-vouch — panel lives here
const VOUCHES_CHANNEL_ID     = '1242134878263447552'; // #vouches — results get posted here

// Counting game module
const COUNTING_CHANNEL_ID = '1484663384443064510'; // #counting-game

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in environment variables!');
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Invite Tracking (Verify module) ────────────────────────────────────────
const inviteCache = new Map(); // guildId → Map<code, {inviterId, uses}>
const inviteData  = new Map(); // guildId → Map<userId, {total,real,left,fake,usedKeys}>

// ─── Persistent storage (survive restarts) ────────────────────────────────────
// DATA_DIR should point at a mounted Railway Volume (e.g. /app/data) so this
// survives redeploys/restarts. Falls back to the project folder if unset —
// that fallback does NOT survive a redeploy on Railway.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');
const VOUCHES_FILE   = path.join(DATA_DIR, 'vouches.json');

function loadJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}
function saveJSON(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('Save error:', e); }
}

// giveaways: { [messageId]: { prize, channelId, guildId, endsAt (ISO), participants: [], ended } }
const giveawaysRaw = loadJSON(GIVEAWAYS_FILE, {});
const giveaways    = new Map(Object.entries(giveawaysRaw).map(([id, g]) => [id, { ...g, participants: new Set(g.participants || []) }]));

function saveGiveaways() {
  const obj = {};
  for (const [id, g] of giveaways) obj[id] = { ...g, participants: [...g.participants] };
  saveJSON(GIVEAWAYS_FILE, obj);
}

function saveVouches() {
  const obj = {};
  for (const [gid, v] of vouchData) obj[gid] = v;
  saveJSON(VOUCHES_FILE, obj);
}

// vouches: { [guildId]: { count, channelId, entries: [{id, userId, username, rating, feedback, imageUrl, timestamp}] } }
const vouchDataRaw = loadJSON(VOUCHES_FILE, {});
const vouchData    = new Map(Object.entries(vouchDataRaw).map(([gid, v]) => [gid, { count: v.count || 0, channelId: v.channelId || null, entries: v.entries || [] }]));

// ─── Counting game ──────────────────────────────────────────────────────────
const COUNTING_FILE = path.join(DATA_DIR, 'counting.json');
function saveCounting() {
  const obj = {};
  for (const [gid, c] of countingData) obj[gid] = c;
  saveJSON(COUNTING_FILE, obj);
}
// counting: { [guildId]: { count, lastUserId, highScore } }
const countingDataRaw = loadJSON(COUNTING_FILE, {});
const countingData    = new Map(Object.entries(countingDataRaw));

// ─── Steam account stock ────────────────────────────────────────────────────
const STOCK_FILE      = path.join(DATA_DIR, 'stock.json');       // { [type]: string[] }
const STOCK_COOLDOWNS_FILE = path.join(DATA_DIR, 'stock_cooldowns.json'); // { [userId]: { [type]: isoTimestamp } }
const STOCK_COOLDOWN_HOURS = parseInt(process.env.STOCK_COOLDOWN_HOURS || '24');

const stockData      = loadJSON(STOCK_FILE, {});
const stockCooldowns = loadJSON(STOCK_COOLDOWNS_FILE, {});
function saveStock()      { saveJSON(STOCK_FILE, stockData); }
function saveCooldowns()  { saveJSON(STOCK_COOLDOWNS_FILE, stockCooldowns); }

// Fixed types shown as dedicated panel buttons (staff still use /addstock with
// these same slugs — e.g. /addstock type:steam, type:steam phone verified, etc.)
const GEN_PANEL_TYPES = [
  { type: 'steam',           label: 'Steam',                 emoji: '🎮' },
  { type: 'phone-verified',  label: 'Steam Phone Verified',  emoji: '📱' },
  { type: 'email-outlook',   label: 'Email: Outlook',        emoji: '📧' },
];

function normalizeStockType(raw) {
  const t = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return t || 'standard';
}

// Stock access roles — set as env vars if you ever need to change them without a redeploy.
const GEN_ROLE_ID   = process.env.GEN_ROLE_ID   || '1525288697656901712'; // 💎 Gen Member
const OVERSEER_ROLE_ID = process.env.OVERSEER_ROLE_ID || '1518372339115360358'; // OVERSEER — unlimited

function canAccessStock(member) {
  if (member.permissions.has('Administrator')) return true;
  if (member.roles.cache.has(OVERSEER_ROLE_ID)) return true;
  if (member.roles.cache.has(GEN_ROLE_ID)) return true;
  if (member.roles.cache.some(r => r.name === VERIFIED_ROLE)) return true; // kept for backward compatibility
  return false;
}

// Admins / OVERSEER bypass the per-type cooldown entirely.
function hasUnlimitedGen(member) {
  return member.permissions.has('Administrator') || member.roles.cache.has(OVERSEER_ROLE_ID);
}

// Parses lines like:
//   sadHawk69367:vFbdmjbjdOJC|sutkuschampeau525@outlook.com:InD28x9O4mKk (+447452933178)
// into { username, password, email, emailPassword, phone }. Phone is optional.
// Returns null if the line doesn't match — callers should fall back to raw display,
// so accounts in any other format (or other stock types) still work fine.
function parseStockAccountLine(raw) {
  const m = raw.match(/^\s*(\S+):(\S+)\|(\S+):(\S+?)(?:\s*\(([^)]+)\))?\s*$/);
  if (!m) return null;
  const [, username, password, email, emailPassword, phone] = m;
  return { username, password, email, emailPassword, phone: phone || null };
}

function buildStockEmbed() {
  const types = Object.keys(stockData);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Stock Levels')
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

  if (!types.length) {
    embed.setDescription('No stock has been added yet.');
  } else {
    embed.setDescription(types.map(t => `**${t}** — ${stockData[t].length} available`).join('\n'));
  }
  return embed;
}

// Shared claim logic — used by /gensteam directly, and by the postgensteam
// panel's button + type-select dropdown flow. `interaction` must not have
// been replied to yet when this is called.
async function claimStockAccount(interaction, type) {
  const userId = interaction.user.id;
  const unlimited = hasUnlimitedGen(interaction.member);

  if (!unlimited) {
    const lastGen = stockCooldowns[userId]?.[type];
    if (lastGen) {
      const elapsedMs = Date.now() - new Date(lastGen).getTime();
      const cooldownMs = STOCK_COOLDOWN_HOURS * 60 * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const readyAt = Math.floor((new Date(lastGen).getTime() + cooldownMs) / 1000);
        return interaction.reply({ content: `⏳ You can generate another **${type}** account <t:${readyAt}:R>.`, flags: 64 });
      }
    }
  }

  const pool = stockData[type] || [];
  if (!pool.length) {
    return interaction.reply({ content: `❌ Out of stock for **${type}**. Check back later!`, flags: 64 });
  }

  const account = pool.shift();
  saveStock();

  if (!unlimited) {
    stockCooldowns[userId] = stockCooldowns[userId] || {};
    stockCooldowns[userId][type] = new Date().toISOString();
    saveCooldowns();
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('🎮 Your Steam Account')
    .addFields(
      { name: 'Type', value: type, inline: true },
      { name: 'Remaining Stock', value: `${pool.length}`, inline: true },
    )
    .setFooter({ text: `${BOT_NAME} | Keep this safe — it will not be shown again`, iconURL: client.user.displayAvatarURL() });

  const parsed = parseStockAccountLine(account);
  if (parsed) {
    embed.addFields(
      { name: 'Username', value: `\`${parsed.username}\``, inline: true },
      { name: 'Password', value: `\`${parsed.password}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }, // spacer so the row breaks evenly
      { name: 'Email', value: `\`${parsed.email}\``, inline: true },
      { name: 'Email Password', value: `\`${parsed.emailPassword}\``, inline: true },
    );
    if (parsed.phone) embed.addFields({ name: 'Phone', value: `\`${parsed.phone}\``, inline: true });
  } else {
    // Doesn't match the expected schema — show it raw rather than lose data.
    embed.setDescription(`\`\`\`${account}\`\`\``);
  }

  let delivered = false;
  try {
    await interaction.user.send({ embeds: [embed] });
    delivered = true;
  } catch (_) { /* DMs closed — fall back below */ }

  if (delivered) {
    return interaction.reply({ content: '✅ Sent your account via DM! Check your messages.', flags: 64 });
  } else {
    return interaction.reply({ content: '⚠️ Couldn\'t DM you (your DMs may be closed), so here it is — only you can see this message:', embeds: [embed], flags: 64 });
  }
}

async function handleCountingMessage(message) {
  const gid   = message.guild.id;
  const state = countingData.get(gid) || { count: 0, lastUserId: null, highScore: 0 };
  const raw   = message.content.trim();

  const isValidNumber = /^\d+$/.test(raw);
  const num      = isValidNumber ? parseInt(raw, 10) : NaN;
  const expected = state.count + 1;
  const sameUserTwice = state.lastUserId === message.author.id;

  if (isValidNumber && num === expected && !sameUserTwice) {
    state.count = expected;
    state.lastUserId = message.author.id;
    if (state.count > (state.highScore || 0)) state.highScore = state.count;
    countingData.set(gid, state);
    saveCounting();
    try { await message.react('✅'); } catch (_) {}
    return;
  }

  // Wrong number, repeat user, or non-numeric message — reset the count
  const brokenAt = state.count;
  const reason = sameUserTwice
    ? "counted twice in a row"
    : (!isValidNumber ? "didn't post a valid number" : `posted ${raw} instead of ${expected}`);

  state.count = 0;
  state.lastUserId = null;
  countingData.set(gid, state);
  saveCounting();

  try { if (message.deletable) await message.delete(); } catch (_) {}
  try {
    await message.channel.send({
      content: `❌ <@${message.author.id}> ${reason} — the count was **${brokenAt}**. Back to **1**!${state.highScore ? ` (Best: ${state.highScore})` : ''}`,
    });
  } catch (_) {}
}

function getGuildData(gid) {
  if (!inviteData.has(gid)) inviteData.set(gid, new Map());
  return inviteData.get(gid);
}
function getUserInviteData(gid, uid) {
  const g = getGuildData(gid);
  if (!g.has(uid)) g.set(uid, { total: 0, real: 0, left: 0, fake: 0, usedKeys: 0 });
  return g.get(uid);
}

// ─── Updates module state ────────────────────────────────────────────────────
const PRODUCT_COLORS = [
  0x5865F2,0xEB459E,0x57F287,0xFEE75C,0xED4245,
  0x9B59B6,0x1ABC9C,0xE67E22,0x3498DB,0xE74C3C,
  0x2ECC71,0xF39C12,0x1F8B4C,0x206694,0x71368A,
  0xAD1457,0x11806A,0xC27C0E,0xA84300,0x979C9F,
];
const productColorMap    = {};
let colorIndex           = 0;
const productLastStatus  = {};
const websiteMessages    = {};
const resellerMessages   = {};
const pendingUpdates     = {};
const resellerLinks      = { apply: 'https://uhservicess.netlify.app/', panel: 'https://uhservicess.netlify.app/' };
// Competitor-detection: server IDs to watch for on join, role to tag flagged members with, and a staff log channel.
const competitorWatch    = { guildIds: [], roleId: null, logChannel: 'mod-log' };

const UPDATE_TYPES = {
  status_change:  { label: 'Status Change',  emoji: '🔄' },
  maintenance:    { label: 'Maintenance',     emoji: '🛠️' },
  update:         { label: 'Update',          emoji: '⬆️' },
  patch:          { label: 'Patch',           emoji: '🩹' },
  undetected:     { label: 'Undetected',      emoji: '✅' },
  detected:       { label: 'Detected',        emoji: '🚨' },
  disabled:       { label: 'Disabled',        emoji: '⛔' },
  enabled:        { label: 'Enabled',         emoji: '🟢' },
  new_product:    { label: 'New Product',     emoji: '🆕' },
  sale:           { label: 'Sale',            emoji: '💸' },
  bug_fix:        { label: 'Bug Fix',         emoji: '🔧' },
  announcement:   { label: 'Announcement',    emoji: '📣' },
  time_extension: { label: 'Time Extension',  emoji: '🕐' },
  new_feature:    { label: 'New Feature',     emoji: '✨' },
};
const STATUS_TYPES = {
  updating: { emoji: '🔵', label: 'Updating', color: 0x9B59B6 },
  testing:  { emoji: '🟡', label: 'Testing',  color: 0xF1C40F },
  updated:  { emoji: '🟢', label: 'Updated',  color: 0x57F287 },
};

function getProductColor(name) {
  const k = name.toLowerCase().trim();
  if (!(k in productColorMap)) productColorMap[k] = PRODUCT_COLORS[colorIndex++ % PRODUCT_COLORS.length];
  return productColorMap[k];
}

function hasAccess(interaction) {
  const member = interaction.member;
  if (member.permissions.has('Administrator')) return true;
  if (member.roles.cache.some(r => r.name === 'MODERATOR')) return true;
  return false;
}

function autoDelete(interaction, ms) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

// Safe setTimeout that handles durations longer than JS's ~24.8 day limit by chaining.
function safeSetTimeout(fn, ms) {
  const MAX = 2_147_483_647;
  if (ms <= MAX) { setTimeout(fn, ms); return; }
  setTimeout(() => safeSetTimeout(fn, ms - MAX), MAX);
}

// Pick up to `count` unique random winners from a participants array.
function pickWinners(participants, count) {
  const pool = [...participants];
  const winners = [];
  while (winners.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|week|mo|month)s?$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': case 'sec':   return n * 1000;
    case 'm': case 'min':   return n * 60 * 1000;
    case 'h': case 'hr':    return n * 60 * 60 * 1000;
    case 'd': case 'day':   return n * 24 * 60 * 60 * 1000;
    case 'w': case 'week':  return n * 7 * 24 * 60 * 60 * 1000;
    case 'mo': case 'month': return n * 30 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// Normalizes a channel name: lowercase, strip emoji/symbols/pipes/spaces, keep only letters/numbers/hyphens/underscores.
function normalizeChannelName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_]/gu, ''); // strip everything except letters, numbers, hyphen, underscore (drops emoji, pipes, spaces)
}

// Finds a channel whose normalized name contains the normalized target — survives emoji prefixes, pipes, capitalization, etc.
// e.g. findChannelByName(guild, 'invites') will match '📨 | Invites', 'invites', 'INVITES-chat', etc.
function findChannelByName(guild, targetName, type = ChannelType.GuildText) {
  const target = normalizeChannelName(targetName);
  if (!target) return null;
  // Prefer an exact normalized match first, then fall back to "contains".
  const channels = [...guild.channels.cache.values()].filter(c => c.type === type);
  const exact = channels.find(c => normalizeChannelName(c.name) === target);
  if (exact) return exact;
  return channels.find(c => normalizeChannelName(c.name).includes(target)) || null;
}

function parseStatusTransition(raw) {
  const parts = raw.split(/→|->|>|\bto\b|\//).map(p => p.trim());
  if (parts.length === 2) return { old: STATUS_TYPES[parts[0]] || null, new: STATUS_TYPES[parts[1]] || null };
  if (parts.length === 1) return { old: null, new: STATUS_TYPES[parts[0]] || null };
  return { old: null, new: null };
}

// ─── Welcome Card ────────────────────────────────────────────────────────────
async function createWelcomeCard(member) {
  const W = 600, H = 400;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);
  const teal = '#00e5ff', arm = 55, pad = 18;
  ctx.strokeStyle = teal; ctx.lineWidth = 6; ctx.lineCap = 'square';
  ctx.beginPath(); ctx.moveTo(pad,pad+arm); ctx.lineTo(pad,pad); ctx.lineTo(pad+arm,pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,pad); ctx.lineTo(W-pad,pad); ctx.lineTo(W-pad,pad+arm); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad,H-pad-arm); ctx.lineTo(pad,H-pad); ctx.lineTo(pad+arm,H-pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,H-pad); ctx.lineTo(W-pad,H-pad); ctx.lineTo(W-pad,H-pad-arm); ctx.stroke();
  const pillText = `Member #${member.guild.memberCount}`;
  ctx.font = 'bold 16px Arial';
  const tw = ctx.measureText(pillText).width;
  const pillW = tw+36, pillH = 30, pillX = (W-pillW)/2, pillY = 22;
  ctx.fillStyle = '#2c2c4a'; ctx.beginPath(); ctx.roundRect(pillX,pillY,pillW,pillH,15); ctx.fill();
  ctx.fillStyle = '#cccccc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(pillText, W/2, pillY+pillH/2);
  const cx = W/2, cy = 195, r = 70;
  try {
    const avatar = await loadImage(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
    ctx.beginPath(); ctx.arc(cx,cy,r+4,0,Math.PI*2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    ctx.drawImage(avatar,cx-r,cy-r,r*2,r*2); ctx.restore();
  } catch (_) { ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle='#5865f2'; ctx.fill(); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px Arial'; ctx.fillText(`Welcome ${member.user.username}`, W/2, 300);
  ctx.fillStyle = '#aaaaaa'; ctx.font = '20px Arial'; ctx.fillText('to', W/2, 328);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px Arial'; ctx.fillText(member.guild.name, W/2, 360);
  return canvas.toBuffer('image/png');
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const ownCommands = [
  // Verify module
  new SlashCommandBuilder().setName('setup-verify').setDescription('Sets up the verification channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('setup-invites').setDescription('Sets up the invite reward channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // Updates module
  new SlashCommandBuilder().setName('postupdate').setDescription('Open the product update form'),
  new SlashCommandBuilder().setName('announce').setDescription('Send a custom announcement to any channel'),
  new SlashCommandBuilder().setName('downloads').setDescription('Browse and download products'),
  new SlashCommandBuilder().setName('setdownload').setDescription('Admin: Set or update a download link for a product')
    .addStringOption(o => o.setName('product').setDescription('Product name').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('url').setDescription('Download URL').setRequired(true)),
  new SlashCommandBuilder().setName('setupdownloads').setDescription('Admin: Post the download panel to #downloads'),
  new SlashCommandBuilder().setName('setwebsite').setDescription('Admin: Set or update the website URL')
    .addStringOption(o => o.setName('url').setDescription('Full website URL').setRequired(true)),
  new SlashCommandBuilder().setName('statusupdate').setDescription('Post a status update to #status-updates'),
  new SlashCommandBuilder().setName('setupreseller').setDescription('Admin: Post the reseller program panel'),
  new SlashCommandBuilder().setName('postimage').setDescription('Admin: Post an image with an optional message')
    .addAttachmentOption(o => o.setName('image').setDescription('Image to post').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Optional message').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(false)),
  new SlashCommandBuilder().setName('setresellerlinks').setDescription('Admin: Update Apply and Preview Panel button links'),
  new SlashCommandBuilder().setName('postlink').setDescription('Staff: Post a titled link to the Useful-Links channel')
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('setcompetitors').setDescription('Admin: Configure competitor-server join detection')
    .addStringOption(o => o.setName('guild_ids').setDescription('Comma-separated server IDs to watch for (bot must share that server)').setRequired(true))
    .addRoleOption(o => o.setName('flag_role').setDescription('Role to apply to flagged members').setRequired(false))
    .addStringOption(o => o.setName('log_channel').setDescription('Staff channel name to log detections in (default: mod-log)').setRequired(false)),
  new SlashCommandBuilder().setName('giveaway').setDescription('Staff: Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 2d, 1w, 1mo').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners 1-5 (default 1)').setMinValue(1).setMaxValue(5).setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('Image URL for the giveaway embed (optional)').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current)').setRequired(false)),
  new SlashCommandBuilder().setName('setupvouch').setDescription('Staff: Post the Leave a Vouch panel')
    .addStringOption(o => o.setName('channel').setDescription('Panel channel (defaults to #leave-vouch)').setRequired(false))
    .addStringOption(o => o.setName('results_channel').setDescription('Where received vouches post (defaults to #vouches)').setRequired(false)),
  new SlashCommandBuilder().setName('exportvouches').setDescription('Staff: Download a backup file of all vouches on this server'),
  new SlashCommandBuilder().setName('importvouches').setDescription('Staff: Restore vouches from a backup file into this server')
    .addAttachmentOption(o => o.setName('file').setDescription('The vouches backup .json file').setRequired(true))
    .addBooleanOption(o => o.setName('repost').setDescription('Repost each vouch as an embed in the vouches channel? (default: true)').setRequired(false)),
  new SlashCommandBuilder().setName('commands').setDescription('Show all available bot commands'),
  new SlashCommandBuilder().setName('addstock').setDescription('Staff: Add accounts to stock')
    .addStringOption(o => o.setName('type').setDescription('Account type (e.g. phone-verified). Leave blank for standard').setRequired(false))
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file, one account per line').setRequired(false))
    .addStringOption(o => o.setName('accounts').setDescription('Paste accounts here (one per line) if not using a file').setRequired(false)),
  new SlashCommandBuilder().setName('stock').setDescription('Check how much stock is available'),
  new SlashCommandBuilder().setName('gensteam').setDescription('Generate a Steam account')
    .addStringOption(o => o.setName('type').setDescription('Account type (e.g. phone-verified). Leave blank for standard').setRequired(false)),
  new SlashCommandBuilder().setName('postgensteam').setDescription('Staff: Post the Steam account generator panel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('clearstock').setDescription('Staff: Remove stock accounts (fix a bad upload)')
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm — this cannot be undone').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Account type to clear. Leave blank to clear ALL types').setRequired(false)),
].map(c => c.toJSON());

// Merge with support module commands
const allCommands = [...ownCommands, ...support.supportCommands];

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  ✅ UH SUPER BOT online            ║`);
  console.log(`║  Logged in as: ${client.user.tag.padEnd(19)}║`);
  console.log(`╚════════════════════════════════════╝\n`);

  // Cache guild invites
  for (const [, guild] of client.guilds.cache) {
    try {
      const inv = await guild.invites.fetch();
      const cache = new Map();
      inv.forEach(i => cache.set(i.code, { inviterId: i.inviter?.id, uses: i.uses }));
      inviteCache.set(guild.id, cache);
    } catch (_) {}
  }

  // Re-schedule any active giveaway timers that survived a restart
  for (const [msgId, gw] of giveaways) {
    if (gw.ended) continue;
    const remaining = new Date(gw.endsAt).getTime() - Date.now();
    if (remaining <= 0) {
      // Already expired while bot was offline — end it now
      gw.ended = true;
      saveGiveaways();
      (async () => {
        try {
          const gwCh  = await client.channels.fetch(gw.channelId);
          const gwMsg = await gwCh.messages.fetch(msgId);
          const participants = [...gw.participants];
          const count   = gw.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;
          const endedEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle(`🎁 ${gw.prize} [ENDED]`)
            .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
            .setFooter({ text: `Ended on ${new Date(gw.endsAt).toUTCString()}`, iconURL: client.user.displayAvatarURL() });
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
          );
          await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });
          const resultsEmbed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`🎁 ${gw.prize} [RESULTS]`)
            .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
            .addFields({ name: 'Prize', value: gw.prize }, { name: 'Participants', value: `${participants.length}` }, { name: 'Winners', value: `${winners.length}` })
            .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
          await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
        } catch (e) { console.error('Giveaway restart-end error:', e); }
      })();
    } else {
      // Still has time left — re-arm the timer for the remaining duration
      safeSetTimeout(async () => {
        const g = giveaways.get(msgId);
        if (!g || g.ended) return;
        g.ended = true;
        saveGiveaways();
        try {
          const gwCh  = await client.channels.fetch(g.channelId);
          const gwMsg = await gwCh.messages.fetch(msgId);
          const participants = [...g.participants];
          const count   = g.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;
          const endedEmbed = new EmbedBuilder().setColor(0x95A5A6).setTitle(`🎁 ${g.prize} [ENDED]`)
            .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
            .setFooter({ text: `Ended on ${new Date(g.endsAt).toUTCString()}`, iconURL: client.user.displayAvatarURL() });
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
          );
          await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });
          const resultsEmbed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`🎁 ${g.prize} [RESULTS]`)
            .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
            .addFields({ name: 'Prize', value: g.prize }, { name: 'Participants', value: `${participants.length}` }, { name: 'Winners', value: `${winners.length}` })
            .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
          await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
        } catch (e) { console.error('Giveaway rescheduled-end error:', e); }
      }, remaining);
      console.log(`⏰ Rescheduled giveaway ${msgId} (${gw.prize}) — ${Math.round(remaining / 60000)}m remaining`);
    }
  }

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('📋 Registering slash commands...');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommands });
      console.log(`✅ Guild commands registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommands });
      console.log('✅ Global slash commands registered');
    }
  } catch (err) { console.error('Failed to register commands:', err); }

  // Start 2FA auth server
  startAuthServer(client);

  await client.user.setActivity('for scams 🛡️', { type: 3 }); // Watching
});

// ─── Invite tracking ─────────────────────────────────────────────────────────
client.on('inviteCreate', inv => {
  const cache = inviteCache.get(inv.guild.id) || new Map();
  cache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses });
  inviteCache.set(inv.guild.id, cache);
});
client.on('inviteDelete', inv => {
  const cache = inviteCache.get(inv.guild.id);
  if (cache) cache.delete(inv.code);
});

// ─── Member Join ─────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  // Competitor-server detection: check if this member is also in any watched guild the bot shares with them.
  if (competitorWatch.guildIds.length) {
    try {
      const sharedWith = [];
      for (const gid of competitorWatch.guildIds) {
        const g = client.guilds.cache.get(gid);
        if (!g) continue; // bot isn't in that server, can't check it
        const isMember = g.members.cache.has(member.id) || await g.members.fetch(member.id).then(() => true).catch(() => false);
        if (isMember) sharedWith.push(g.name);
      }
      if (sharedWith.length) {
        if (competitorWatch.roleId) {
          const role = member.guild.roles.cache.get(competitorWatch.roleId);
          if (role) await member.roles.add(role).catch(() => {});
        }
        const logCh = findChannelByName(member.guild, competitorWatch.logChannel);
        if (logCh) {
          await logCh.send({
            content: `🚩 <@${member.id}> (**${member.user.tag}**) joined and is also in: ${sharedWith.join(', ')}`,
          }).catch(() => {});
        }
      }
    } catch (err) { console.error('Competitor detection error:', err); }
  }

  // Track invite
  try {
    const newInvites = await member.guild.invites.fetch();
    const oldCache   = inviteCache.get(member.guild.id) || new Map();
    let inviterId = null;
    newInvites.forEach(inv => {
      const old = oldCache.get(inv.code);
      if (old && inv.uses > old.uses) inviterId = old.inviterId;
    });
    const newCache = new Map();
    newInvites.forEach(inv => newCache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses }));
    inviteCache.set(member.guild.id, newCache);
    if (inviterId) {
      const d = getUserInviteData(member.guild.id, inviterId);
      d.total++; d.real++;
    }
  } catch (_) {}

  // DM new member
  try {
    await member.send(
      `👋 Welcome to **${member.guild.name}**!\n\nPlease head to **#${VERIFY_CHANNEL}** and click **Verify Me** to access the server.`
    );
  } catch (_) {}

  // Welcome card
  try {
    const welcomeCh = member.guild.channels.cache.get(WELCOME_CHANNEL_ID) || findChannelByName(member.guild, WELCOME_CHANNEL);
    if (!welcomeCh) return;
    const buf = await createWelcomeCard(member);
    await welcomeCh.send({
      content: `Welcome <@${member.user.id}> to **${member.guild.name}**! 🎉`,
      files: [new AttachmentBuilder(buf, { name: 'welcome.png' })],
    });
  } catch (err) { console.error('Welcome card error:', err); }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  // DM support (support module handles !close in DMs)
  if (message.channel.type === ChannelType.DM) {
    await support.handleDM(message, client);
    return;
  }
  // Counting game (dedicated channel — skip other message processing)
  if (message.channel.id === COUNTING_CHANNEL_ID) {
    if (message.author.bot) return;
    await handleCountingMessage(message);
    return;
  }
  // Anti-scam prefix commands
  if (message.content.startsWith('!')) {
    const handled = await antiscam.handlePrefixCommand(message, client);
    if (handled) return;
  }
  // Anti-scam scanning (runs on all non-admin messages)
  await antiscam.onMessage(message, client);
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    // 2FA button
    if (await handle2FAInteraction(interaction)) return;
    // Support module interactions
    if (await support.handleInteraction(interaction, client)) return;
    // Autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'setdownload') {
      const focused = interaction.options.getFocused().toLowerCase();
      return interaction.respond(
        getAllProducts().filter(p => p.name.toLowerCase().includes(focused)).slice(0, 25).map(p => ({ name: p.name, value: p.id }))
      );
    }

    // ── Slash commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // ── /commands ──────────────────────────────────────────────────────────
      if (cmd === 'commands') {
        const embed = new EmbedBuilder()
          .setTitle('🤖 UH Super Bot — All Commands').setColor(0x5865F2)
          .addFields(
            { name: '🔐 Verification & Invites', value: '`/setup-verify` — Set up verification channel\n`/setup-invites` — Set up invite reward channel', inline: false },
            { name: '📦 Products & Downloads', value: '`/downloads` — Browse & download products\n`/setupdownloads` — Post download panel to #downloads\n`/setdownload` — Set a product download link', inline: false },
            { name: '📣 Updates & Status', value: '`/postupdate` — Post a product update\n`/statusupdate` — Post a status update\n`/announce` — Send a custom announcement', inline: false },
            { name: '🌐 Server Setup', value: '`/setwebsite` — Pin website URL\n`/setupreseller` — Post reseller panel\n`/setresellerlinks` — Update reseller button links\n`/postimage` — Post an image', inline: false },
            { name: '🎫 Support Tickets', value: '`/panel` — Post the support panel\n`/clearlogs` — Clear ticket log channel\n`/reply` — Reply to a user\'s ticket', inline: false },
            { name: '📝 Vouches', value: '`/setupvouch` — Post the Leave a Vouch panel\n`/exportvouches` — Download a backup of all vouches\n`/importvouches` — Restore vouches from a backup file', inline: false },
            { name: '🎮 Steam Stock', value: '`/gensteam [type]` — Generate a Steam account\n`/stock` — Check available stock\n`/addstock` — Staff: add accounts to stock', inline: false },
            { name: '🛡️ Anti-Scam (Prefix)', value: '`!bothelp` — Anti-scam command list\n`!manage` — Management panel\n`!scamcheck <text>` — Test message\n`!warnings / !clearwarnings` — Warning system\n`!nuke` — Wipe channel\n`!addlink / !removelink / !listlinks` — Manage banned links\n`!addword / !removeword` — Manage profanity filter', inline: false },
            { name: '💬 DM Commands', value: '`!close` — Close your support ticket (type in DM)', inline: false },
          )
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /post-video ────────────────────────────────────────────────────────


      // ── /setup-verify ──────────────────────────────────────────────────────
      if (cmd === 'setup-verify') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        let verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE);
        if (!verifiedRole) verifiedRole = await guild.roles.create({ name: VERIFIED_ROLE, color: 0x5865f2 });
        const everyoneRole = guild.roles.everyone;
        const botRole = guild.members.me.roles.highest;
        await guild.channels.fetch();
        // Channel IDs that Verified role is allowed to see (besides get-verify)
        const VERIFIED_ALLOWED_IDS = [
          '1481172050801463367', // support channel
          '1242139449320804393', // Support 1 voice
        ];
        for (const [, ch] of guild.channels.cache) {
          if (ch.name === VERIFY_CHANNEL) continue;
          try {
            await ch.permissionOverwrites.edit(everyoneRole, { ViewChannel: false, SendMessages: false });
            await ch.permissionOverwrites.edit(botRole, { ViewChannel: true, SendMessages: true });
            if (VERIFIED_ALLOWED_IDS.includes(ch.id)) {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: true });
            } else {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: false });
            }
          } catch (_) {}
        }
        let verifyCh = findChannelByName(guild, VERIFY_CHANNEL);
        if (!verifyCh) verifyCh = await guild.channels.create({ name: VERIFY_CHANNEL, type: ChannelType.GuildText });
        await verifyCh.permissionOverwrites.edit(everyoneRole, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true });
        await verifyCh.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: false });
        try { const msgs = await verifyCh.messages.fetch({ limit: 10 }); await verifyCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🔐 Verify to Access the Server')
          .setDescription('Welcome! To gain access to all channels, click the **Verify** button below.\n\nBy verifying, you agree to follow our server rules.')
          .setColor(0x5865f2).setFooter({ text: 'Click once — verification is instant!' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Primary)
        );
        await verifyCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Done!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /setup-invites ────────────────────────────────────────────────────
      if (cmd === 'setup-invites') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        let invCh = guild.channels.cache.get(INVITES_CHANNEL_ID) || findChannelByName(guild, INVITES_CHANNEL);
        if (!invCh) invCh = await guild.channels.create({ name: INVITES_CHANNEL, type: ChannelType.GuildText });
        await invCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        try { const msgs = await invCh.messages.fetch({ limit: 10 }); await invCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🎉 Invite Your Friends & Earn Rewards!')
          .setDescription(`Invite your friends and earn **free keys**!\n\n**How it works:**\n1️⃣ Click **Your Invite Link** to get your link\n2️⃣ Share it with friends\n3️⃣ Once you have **${INVITES_NEEDED} real invites**, click **Redeem Your Key**!\n\nRedeem **unlimited times** — every ${INVITES_NEEDED} invites = 1 free key 🔑\n\n⚠️ *Fake invites & users who leave don't count!*`)
          .setColor(0x5865f2).setTimestamp().setFooter({ text: 'Invite Reward System' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('get_invite_link').setLabel('🔗 Your Invite Link').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('check_invites').setLabel('📊 Check Your Invites').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('redeem_key').setLabel('🎁 Redeem Your Key').setStyle(ButtonStyle.Success),
        );
        await invCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Invite system set up!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /postupdate ────────────────────────────────────────────────────────
      if (cmd === 'postupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const select = new StringSelectMenuBuilder()
          .setCustomId('select_update_type').setPlaceholder('Select update type...')
          .addOptions(Object.entries(UPDATE_TYPES).map(([val, { label, emoji }]) =>
            new StringSelectMenuOptionBuilder().setLabel(label).setValue(val).setEmoji(emoji)
          ));
        await interaction.reply({ content: '### 📋 New Product Update\nSelect the **update type** to continue:', components: [new ActionRowBuilder().addComponents(select)], flags: 64 });
        autoDelete(interaction, 60000);
        return;
      }

      // ── /announce ──────────────────────────────────────────────────────────
      if (cmd === 'announce') {
        const modal = new ModalBuilder().setCustomId('announce_modal').setTitle('📣 New Announcement');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_title').setLabel('TITLE').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_message').setLabel('MESSAGE').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_download').setLabel('DOWNLOAD LINK (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_channel').setLabel('POST TO CHANNEL (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_ping').setLabel('PING (everyone / here / role name)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }

      // ── /downloads ────────────────────────────────────────────────────────
      if (cmd === 'downloads') {
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        await interaction.reply({
          content: '### Product Downloads\nSelect your product below:',
          components: [
            new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
          ],
          flags: 64,
        });
        autoDelete(interaction, 120000);
        return;
      }

      // ── /setupdownloads ───────────────────────────────────────────────────
      if (cmd === 'setupdownloads') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const dlCh = findChannelByName(interaction.guild, 'downloads') || interaction.channel;
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        const embed = new EmbedBuilder().setTitle('📦  PRODUCT DOWNLOADS').setColor(0x5865F2)
          .setDescription('> Select your product from the dropdown below and click **DOWNLOAD** to get your file.')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        await dlCh.send({ embeds: [embed], components: [
          new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
        ]});
        await interaction.reply({ content: `✅ Download panel posted in <#${dlCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setdownload ──────────────────────────────────────────────────────
      if (cmd === 'setdownload') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const productId = interaction.options.getString('product');
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const product = getProduct(productId);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        setProductUrl(productId, url);
        await interaction.reply({ content: `✅ Download link updated for **${product.name}**\n🔗 ${url}`, flags: 64 });
        autoDelete(interaction, 8000);
        return;
      }

      // ── /setwebsite ───────────────────────────────────────────────────────
      if (cmd === 'setwebsite') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const wsCh = findChannelByName(interaction.guild, 'website') || interaction.channel;
        const displayUrl = url.replace(/^https?:\/\//, '');
        const embed = new EmbedBuilder().setDescription(`### [${displayUrl}](${url})`).setColor(0x5865F2).setTimestamp();
        const gKey = interaction.guild.id;
        const existing = websiteMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ content: '', embeds: [embed] });
            await interaction.reply({ content: `✅ Website updated to **${url}** in <#${existing.channelId}>`, flags: 64 }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await wsCh.send({ content: '', embeds: [embed] });
        websiteMessages[gKey] = { channelId: wsCh.id, messageId: msg.id };
        await interaction.reply({ content: `📌 Website posted in <#${wsCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /postimage ────────────────────────────────────────────────────────
      if (cmd === 'postimage') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const attachment = interaction.options.getAttachment('image');
        const message    = interaction.options.getString('message') || null;
        const chanName   = interaction.options.getString('channel') || null;
        let targetCh = interaction.channel;
        if (chanName) {
          const found = findChannelByName(interaction.guild, chanName.replace('#',''));
          if (found) targetCh = found;
        }
        await targetCh.send({ content: message, files: [attachment.url] });
        await interaction.reply({ content: `✅ Image posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setupreseller ────────────────────────────────────────────────────
      if (cmd === 'setupreseller') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const resCh = findChannelByName(interaction.guild, 'reseller') || interaction.channel;
        const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
          '# UH SERVICES IS LOOKING FOR RESELLERS\n\n**Did you know you can make up to $5000+ monthly reselling our products?**\n\n## Why Start Reselling?\n- All keys are bought through our **centralized panel**, where you can **generate, manage, reset, and freeze keys**\n- We provide **10+** of the **markets leading products**\n- We offer all of our resellers a **minimum discount of 50% off keys** right away\n- We take care of the hard part. **Development, testing, updates, and more are all handled by us**\n- We offer **priority support** in your personal ticket\n- We provide **tips on how to grow and expand** your brand\n- We offer **dynamic delivery** so you can link your site to our panel for seamless product delivery\n- **Pressure free environment**, we don\'t force you to deposit\n- Access to a community of over **100+ successful resellers**'
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(resellerLinks.apply),
          new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(resellerLinks.panel),
        );
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed], components: [row] });
            await interaction.editReply({ content: `✅ Reseller panel updated in <#${existing.channelId}>` }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await resCh.send({ embeds: [embed], components: [row] });
        resellerMessages[gKey] = { channelId: resCh.id, messageId: msg.id };
        await interaction.editReply({ content: `✅ Reseller panel posted in <#${resCh.id}>` }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setresellerlinks ─────────────────────────────────────────────────
      if (cmd === 'setresellerlinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('reseller_links_modal').setTitle('Update Reseller Button Links');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_apply_url').setLabel('APPLY HERE! — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.apply).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_panel_url').setLabel('Preview Panel — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.panel).setRequired(true)),
        );
        return interaction.showModal(modal);
      }

      // ── /postlink ──────────────────────────────────────────────────────────
      if (cmd === 'postlink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const chanInput = interaction.options.getString('channel');
        // Stash the target channel name/ID on the customId so the modal submit handler can read it back.
        const customId = chanInput ? `postlink_modal::${chanInput.replace('#', '').slice(0, 90)}` : 'postlink_modal';
        const modal = new ModalBuilder().setCustomId(customId).setTitle('🔗 Post a Useful Link');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('postlink_title').setLabel('TITLE').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(150)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('postlink_url').setLabel('URL').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),
        );
        return interaction.showModal(modal);
      }

      // ── /setcompetitors ───────────────────────────────────────────────────
      if (cmd === 'setcompetitors') {
        if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: '❌ Admin only.', flags: 64 });
        const ids = interaction.options.getString('guild_ids').split(',').map(s => s.trim()).filter(Boolean);
        const role = interaction.options.getRole('flag_role');
        const logChan = interaction.options.getString('log_channel');
        competitorWatch.guildIds = ids;
        if (role) competitorWatch.roleId = role.id;
        if (logChan) competitorWatch.logChannel = logChan.replace('#', '');
        await interaction.reply({
          content: `✅ Watching ${ids.length} server ID(s) for shared members.\n` +
                    `Flag role: ${competitorWatch.roleId ? `<@&${competitorWatch.roleId}>` : '*none set*'}\n` +
                    `Log channel: #${competitorWatch.logChannel}\n\n` +
                    `ℹ️ This only detects servers the bot itself is a member of — it can't see servers it's not in.`,
          flags: 64,
        });
        return;
      }

      // ── /giveaway ──────────────────────────────────────────────────────────
      if (cmd === 'giveaway') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const prize       = interaction.options.getString('prize');
        const durStr      = interaction.options.getString('duration');
        const winnerCount = interaction.options.getInteger('winners') || 1;
        const imageUrl    = interaction.options.getString('image') || null;
        const chanName    = interaction.options.getString('channel') || null;
        const durMs       = parseDuration(durStr);
        if (!durMs) return interaction.reply({ content: '❌ Invalid duration. Use formats like `10m`, `1h`, `2d`, `1w`, `1mo`.', flags: 64 });

        let targetCh = interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.get(chanName) || findChannelByName(interaction.guild, chanName.replace('#','')); if (f) targetCh = f; }

        const endsAt  = new Date(Date.now() + durMs);
        const endsTs  = `<t:${Math.floor(endsAt.getTime() / 1000)}:F>`;

        const embed = new EmbedBuilder()
          .setColor(0x9B59B6)
          .setAuthor({ name: BOT_NAME, iconURL: client.user.displayAvatarURL() })
          .setTitle(`🎁 ${prize}`)
          .setDescription(`Click the button below to enter the giveaway!\n\n🏆 **Winners:** ${winnerCount}\n⏰ **Ends:** ${endsTs}`)
          .setThumbnail(client.user.displayAvatarURL())
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() })
          .setTimestamp(endsAt);
        if (imageUrl) embed.setImage(imageUrl);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Participate (0)').setStyle(ButtonStyle.Primary),
        );

        await interaction.deferReply({ ephemeral: true });
        const msg = await targetCh.send({ content: '@everyone', embeds: [embed], components: [row] });

        giveaways.set(msg.id, { prize, channelId: targetCh.id, guildId: interaction.guild.id, endsAt: endsAt.toISOString(), participants: new Set(), ended: false, winnerCount });
        saveGiveaways();

        // Schedule auto-end
        safeSetTimeout(async () => {
          const gw = giveaways.get(msg.id);
          if (!gw || gw.ended) return;
          gw.ended = true;
          saveGiveaways();
          const participants = [...gw.participants];
          const count   = gw.winnerCount || 1;
          const winners = pickWinners(participants, count);
          const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;

          // Edit original embed to [ENDED]
          try {
            const endedEmbed = new EmbedBuilder()
              .setColor(0x95A5A6)
              .setAuthor({ name: BOT_NAME, iconURL: client.user.displayAvatarURL() })
              .setTitle(`🎁 ${prize} [ENDED]`)
              .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
              .setThumbnail(client.user.displayAvatarURL())
              .setFooter({ text: `Ended on ${endsAt.toUTCString()}`, iconURL: client.user.displayAvatarURL() });
            if (imageUrl) endedEmbed.setImage(imageUrl);
            const disabledRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
            );
            const gwCh = await client.channels.fetch(gw.channelId);
            const gwMsg = await gwCh.messages.fetch(msg.id);
            await gwMsg.edit({ embeds: [endedEmbed], components: [disabledRow] });

            // Post results embed
            const resultsEmbed = new EmbedBuilder()
              .setColor(0x2ECC71)
              .setTitle(`🎁 ${prize} [RESULTS]`)
              .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
              .addFields(
                { name: 'Prize', value: prize, inline: false },
                { name: 'Winners', value: `${winners.length}`, inline: false },
                { name: 'Participants', value: `${participants.length}`, inline: false },
              )
              .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() })
              .setTimestamp();
            await gwCh.send({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] });
          } catch (e) { console.error('Giveaway end error:', e); }
        }, durMs);

        await interaction.editReply({ content: `✅ Giveaway started in <#${targetCh.id}>! Ends ${endsTs}` }); autoDelete(interaction, 8000);
        return;
      }

      // ── /setupvouch ────────────────────────────────────────────────────────
      if (cmd === 'setupvouch') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const chanName    = interaction.options.getString('channel') || null;
        const resultsName = interaction.options.getString('results_channel') || null;

        // Panel channel: defaults to #leave-vouch
        let targetCh = interaction.guild.channels.cache.get(LEAVE_VOUCH_CHANNEL_ID) || interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.get(chanName) || findChannelByName(interaction.guild, chanName.replace('#','')); if (f) targetCh = f; }

        // Results channel: defaults to #vouches
        let resultsCh = interaction.guild.channels.cache.get(VOUCHES_CHANNEL_ID) || targetCh;
        if (resultsName) { const f = interaction.guild.channels.cache.get(resultsName) || findChannelByName(interaction.guild, resultsName.replace('#','')); if (f) resultsCh = f; }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📝 Leave a Vouch')
          .setDescription('We value your feedback!\nClick the button below to leave a vouch.\n\n**Your feedback helps us grow** 💡')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('leave_vouch').setLabel('📝 Leave a Vouch').setStyle(ButtonStyle.Primary),
        );
        await targetCh.send({ embeds: [embed], components: [row] });
        // Store which channel to post received vouches into
        const existing = vouchData.get(interaction.guild.id) || { count: 0, channelId: resultsCh.id, entries: [] };
        existing.channelId = resultsCh.id;
        vouchData.set(interaction.guild.id, existing);
        saveVouches();
        await interaction.reply({ content: `✅ Vouch panel posted in <#${targetCh.id}> — results will go to <#${resultsCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /exportvouches ────────────────────────────────────────────────────
      if (cmd === 'exportvouches') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: null, entries: [] };
        const backup = {
          exportedFrom: interaction.guild.id,
          exportedAt: new Date().toISOString(),
          count: gData.count,
          entries: gData.entries || [],
        };
        const buf = Buffer.from(JSON.stringify(backup, null, 2), 'utf8');
        const file = new AttachmentBuilder(buf, { name: `vouches-backup-${interaction.guild.id}.json` });
        await interaction.reply({
          content: `✅ Exported **${backup.entries.length}** vouch${backup.entries.length === 1 ? '' : 'es'}. Keep this file safe — use \`/importvouches\` on a new server to restore.`,
          files: [file],
          flags: 64,
        });
        return;
      }

      // ── /importvouches ────────────────────────────────────────────────────
      if (cmd === 'importvouches') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const attachment = interaction.options.getAttachment('file');
        const repost = interaction.options.getBoolean('repost') ?? true;

        if (!attachment || !attachment.name?.toLowerCase().endsWith('.json')) {
          return interaction.editReply({ content: '❌ Please attach the `.json` backup file from `/exportvouches`.' });
        }

        let backup;
        try {
          const res = await fetch(attachment.url);
          const text = await res.text();
          backup = JSON.parse(text);
        } catch (e) {
          console.error('Import vouches parse error:', e);
          return interaction.editReply({ content: '❌ Could not read that file — is it a valid vouches backup .json?' });
        }

        const incoming = Array.isArray(backup.entries) ? backup.entries : null;
        if (!incoming) {
          return interaction.editReply({ content: '❌ That file doesn\'t look like a vouches backup (missing `entries`).' });
        }

        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: VOUCHES_CHANNEL_ID, entries: [] };
        gData.entries = gData.entries || [];

        const vouchCh = gData.channelId
          ? (interaction.guild.channels.cache.get(gData.channelId) || interaction.guild.channels.cache.get(VOUCHES_CHANNEL_ID))
          : interaction.guild.channels.cache.get(VOUCHES_CHANNEL_ID);

        let imported = 0;
        for (const old of incoming) {
          const newId = ++gData.count;
          const entry = {
            id: newId,
            userId: old.userId || null,
            username: old.username || 'Unknown',
            rating: Math.min(5, Math.max(1, parseInt(old.rating) || 1)),
            feedback: old.feedback || '',
            imageUrl: old.imageUrl || null,
            timestamp: old.timestamp || new Date().toISOString(),
            importedFrom: backup.exportedFrom || null,
          };
          gData.entries.push(entry);
          imported++;

          if (repost && vouchCh) {
            const stars = '⭐'.repeat(entry.rating);
            const embed = new EmbedBuilder()
              .setColor(0x2ECC71)
              .setTitle('New Vouch Received 🎉')
              .addFields(
                { name: 'Vouch ID', value: `Nº ${entry.id}`, inline: false },
                { name: 'Rating', value: stars, inline: false },
                { name: 'Feedback', value: entry.feedback || '—', inline: false },
                { name: 'Vouched By', value: entry.userId ? `<@${entry.userId}>` : entry.username, inline: false },
                { name: 'Vouched At', value: `<t:${Math.floor(new Date(entry.timestamp).getTime() / 1000)}:R>`, inline: false },
              )
              .setFooter({ text: `Imported backup | ${BOT_NAME}`, iconURL: client.user.displayAvatarURL() });
            if (entry.imageUrl && /^https?:\/\//i.test(entry.imageUrl)) embed.setImage(entry.imageUrl);
            try { const rm = await vouchCh.send({ embeds: [embed] }); await rm.react('💯'); await rm.react('🔥'); } catch (_) {}
          }
        }

        vouchData.set(interaction.guild.id, gData);
        saveVouches();

        await interaction.editReply({
          content: `✅ Imported **${imported}** vouch${imported === 1 ? '' : 'es'} from backup${repost ? ` and reposted them in <#${vouchCh?.id || VOUCHES_CHANNEL_ID}>` : ' (silently, no repost)'}.`,
        });
        return;
      }

      // ── /addstock ─────────────────────────────────────────────────────────
      if (cmd === 'addstock') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });

        const type       = normalizeStockType(interaction.options.getString('type'));
        const attachment = interaction.options.getAttachment('file');
        const pasted     = interaction.options.getString('accounts');

        let raw = '';
        if (attachment) {
          try {
            const res = await fetch(attachment.url);
            raw += (await res.text()) + '\n';
          } catch (e) {
            console.error('addstock file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
        }
        if (pasted) raw += pasted + '\n';

        if (!raw.trim()) {
          return interaction.editReply({ content: '❌ Provide either a `file` or paste `accounts` (one per line).' });
        }

        const lines = raw.split(/[\r\n,]+/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) {
          return interaction.editReply({ content: '❌ No valid lines found.' });
        }

        stockData[type] = stockData[type] || [];
        stockData[type].push(...lines);
        saveStock();

        await interaction.editReply({
          content: `✅ Added **${lines.length}** account${lines.length === 1 ? '' : 's'} to **${type}**. Total in stock: **${stockData[type].length}**.`,
        });
        return;
      }

      // ── /stock ────────────────────────────────────────────────────────────
      if (cmd === 'stock') {
        await interaction.reply({ embeds: [buildStockEmbed()], flags: 64 });
        return;
      }

      // ── /gensteam ─────────────────────────────────────────────────────────
      if (cmd === 'gensteam') {
        if (!canAccessStock(interaction.member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = normalizeStockType(interaction.options.getString('type'));
        return claimStockAccount(interaction, type);
      }

      // ── /postgensteam ────────────────────────────────────────────────────
      if (cmd === 'postgensteam') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🎮 Steam Account Generator')
          .setDescription(
            `Click a button below to generate an account.\n\n` +
            `You need the **💎 Gen Member** role (or higher) to use this.\n` +
            `Limit: one account per person every **${STOCK_COOLDOWN_HOURS}h**, per account type. Staff/OVERSEER have no limit.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        const genRow = new ActionRowBuilder().addComponents(
          ...GEN_PANEL_TYPES.map(t =>
            new ButtonBuilder().setCustomId(`gensteam_claim::${t.type}`).setLabel(t.label).setEmoji(t.emoji).setStyle(ButtonStyle.Primary)
          )
        );
        const utilRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gensteam_check_stock').setLabel('Check Stock').setEmoji('📦').setStyle(ButtonStyle.Secondary)
        );

        await channel.send({ embeds: [embed], components: [genRow, utilRow] });
        await interaction.reply({ content: `✅ Posted the generator panel in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /clearstock ──────────────────────────────────────────────────────
      if (cmd === 'clearstock') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const confirm = interaction.options.getBoolean('confirm');
        if (!confirm) {
          return interaction.reply({ content: '⚠️ Set `confirm` to **True** to actually clear stock — this cannot be undone.', flags: 64 });
        }

        const typeArg = interaction.options.getString('type');

        if (typeArg) {
          const type = normalizeStockType(typeArg);
          const removed = (stockData[type] || []).length;
          delete stockData[type];
          saveStock();
          return interaction.reply({ content: `🗑️ Cleared **${removed}** account${removed === 1 ? '' : 's'} from **${type}**.`, flags: 64 });
        }

        const totalRemoved = Object.values(stockData).reduce((sum, arr) => sum + arr.length, 0);
        const typeCount = Object.keys(stockData).length;
        for (const key of Object.keys(stockData)) delete stockData[key];
        saveStock();
        return interaction.reply({
          content: `🗑️ Cleared **${totalRemoved}** account${totalRemoved === 1 ? '' : 's'} across **${typeCount}** type${typeCount === 1 ? '' : 's'}. Stock is now empty.`,
          flags: 64,
        });
      }

      if (cmd === 'statusupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('setstatus_modal').setTitle('Status Update');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_product').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_status').setLabel('STATUS (e.g. updated -> updating)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_notes').setLabel('NOTES (optional, separate with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_ping').setLabel('PING ROLE (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }
    }

    // ── Select menus ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      // Steam stock — type chosen from the postgensteam panel dropdown
      if (interaction.customId === 'gensteam_select_type') {
        if (!canAccessStock(interaction.member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        return claimStockAccount(interaction, interaction.values[0]);
      }

      // Update type selected
      if (interaction.customId === 'select_update_type') {
        const typeKey  = interaction.values[0];
        const typeInfo = UPDATE_TYPES[typeKey];
        pendingUpdates[interaction.user.id] = { typeKey };
        const isTimeExt = typeKey === 'time_extension' || typeKey === 'new_feature';
        const modal = new ModalBuilder().setCustomId('update_modal').setTitle(`${typeInfo.emoji} ${typeInfo.label} — Product Update`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('product_name').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('status_transition').setLabel(isTimeExt ? 'TIME ADDED (e.g. 12 hours, 3 days)' : 'STATUS (e.g. updating → updated)').setStyle(TextInputStyle.Short).setRequired(isTimeExt).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('NOTES (separate bullet points with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('custom_title').setLabel('CUSTOM TITLE (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('IMAGE URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
        );
        await interaction.showModal(modal);
        try { await interaction.deleteReply(); } catch (_) {}
        return;
      }

      // Download page select
      if (['dl_page_1','dl_page_2','dl_page_3'].includes(interaction.customId)) {
        const product = getProduct(interaction.values[0]);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        const embed = new EmbedBuilder().setTitle(`📦  ${product.name}`).setColor(0x57F287)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (product.url) {
          embed.setDescription('Your download is ready! Click the button below.');
          const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(product.url).setStyle(ButtonStyle.Link));
          await interaction.reply({ embeds: [embed], components: [btn], flags: 64 });
        } else {
          embed.setDescription('Download link not yet available. Check back soon or contact support.');
          await interaction.reply({ embeds: [embed], flags: 64 });
        }
        autoDelete(interaction, 60000);
        return;
      }
    }

    // ── Buttons ───────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId, guild, member } = interaction;

      // Steam stock panel — one of the fixed type buttons (Steam / Steam Phone
      // Verified / Email: Outlook)
      if (customId.startsWith('gensteam_claim::')) {
        if (!canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = customId.split('::')[1];
        return claimStockAccount(interaction, type);
      }

      // Steam stock panel — Check Stock button
      if (customId === 'gensteam_check_stock') {
        return interaction.reply({ embeds: [buildStockEmbed()], flags: 64 });
      }

      // Legacy single "Generate Account" button, kept for any panel posted
      // before the 4-button layout — safe to leave in even after re-posting.
      if (customId === 'gensteam_open') {
        if (!canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }

        const types = Object.keys(stockData).filter(t => (stockData[t] || []).length > 0);
        if (!types.length) {
          return interaction.reply({ content: '❌ No stock is currently available for any account type. Check back later!', flags: 64 });
        }

        // Only one type in stock — skip the picker and claim immediately.
        if (types.length === 1) {
          return claimStockAccount(interaction, types[0]);
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('gensteam_select_type')
          .setPlaceholder('Choose an account type')
          .addOptions(types.map(t =>
            new StringSelectMenuOptionBuilder().setLabel(t).setValue(t).setDescription(`${stockData[t].length} available`)
          ));

        return interaction.reply({
          content: 'Select the account type you want:',
          components: [new ActionRowBuilder().addComponents(select)],
          flags: 64,
        });
      }

      // Giveaway enter button
      if (customId === 'giveaway_enter') {
        const msgId = interaction.message.id;
        const gw = giveaways.get(msgId);
        if (!gw || gw.ended) { await interaction.reply({ content: '❌ This giveaway has already ended.', ephemeral: true }); return; }
        if (gw.participants.has(member.id)) { await interaction.reply({ content: '✅ You are already entered!', ephemeral: true }); return; }
        gw.participants.add(member.id);
        saveGiveaways();
        // Update button label with new count
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${gw.participants.size})`).setStyle(ButtonStyle.Primary),
        );
        await interaction.update({ components: [updatedRow] });
        return;
      }

      // Leave a vouch button — opens the vouch modal
      if (customId === 'leave_vouch') {
        const modal = new ModalBuilder().setCustomId('vouch_modal').setTitle('📝 Leave a Vouch');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_rating').setLabel('RATING (1-5 stars)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(1).setPlaceholder('e.g. 5')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_feedback').setLabel('FEEDBACK').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder('Tell us about your experience...')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_image').setLabel('IMAGE LINK (optional, or leave blank)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setPlaceholder('Leave blank to upload a screenshot after')),
        );
        return interaction.showModal(modal);
      }

      // Verify button
      if (customId === 'verify_button') {
        const verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE);
        if (!verifiedRole) { await interaction.reply({ content: '⚠️ Verified role not found.', ephemeral: true }); autoDelete(interaction, 5000); return; }
        if (member.roles.cache.has(verifiedRole.id)) { await interaction.reply({ content: '✅ You are already verified!', ephemeral: true }); autoDelete(interaction, 5000); return; }
        try { await member.roles.add(verifiedRole); await interaction.reply({ content: '🎉 You have been verified! Welcome!', ephemeral: true }); autoDelete(interaction, 5000); }
        catch (_) { await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Get invite link
      if (customId === 'get_invite_link') {
        try {
          const invCh = guild.channels.cache.get(INVITES_CHANNEL_ID) || findChannelByName(guild, INVITES_CHANNEL) || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
          const invite = await invCh.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Invite link for ${member.user.tag}` });
          const cache = inviteCache.get(guild.id) || new Map();
          cache.set(invite.code, { inviterId: member.user.id, uses: 0 });
          inviteCache.set(guild.id, cache);
          const embed = new EmbedBuilder().setTitle('🔗 Your Personal Invite Link')
            .setDescription(`Your **permanent** invite link:\n\n**https://discord.gg/${invite.code}**\n\nEvery **${INVITES_NEEDED} real invites** = 1 free key 🔑\nThis link never expires and is unique to you!`)
            .setColor(0x5865f2).setTimestamp();
          await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        } catch (_) { await interaction.reply({ content: '❌ Could not create invite.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Check invites
      if (customId === 'check_invites') {
        const data = getUserInviteData(guild.id, member.user.id);
        const available = Math.floor(data.real / INVITES_NEEDED) - data.usedKeys;
        const filled = Math.min(data.real % INVITES_NEEDED, INVITES_NEEDED);
        const bar = '█'.repeat(filled) + '░'.repeat(INVITES_NEEDED - filled);
        const next = data.real % INVITES_NEEDED === 0 && data.real > 0 ? 'Ready to redeem! 🎁' : `${INVITES_NEEDED - (data.real % INVITES_NEEDED)} more needed`;
        const embed = new EmbedBuilder().setTitle('📊 Your Invite Stats')
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }))
          .setDescription(`**Progress:**\n${bar} ${data.real % INVITES_NEEDED}/${INVITES_NEEDED}\n\n**Next Reward:** ${next}\n\n📨 **Total** — ${data.total}\n✅ **Real** — ${data.real}\n🎁 **Available Keys** — ${available}\n🔑 **Used Keys** — ${data.usedKeys}\n👋 **Left** — ${data.left}\n🚫 **Fake** — ${data.fake}`)
          .setColor(0x5865f2).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        return;
      }

      // Redeem key
      if (customId === 'redeem_key') {
        const data = getUserInviteData(guild.id, member.user.id);
        const available = Math.floor(data.real / INVITES_NEEDED) - data.usedKeys;
        if (available <= 0) {
          const needed = INVITES_NEEDED - (data.real % INVITES_NEEDED);
          await interaction.reply({ content: `❌ Need **${INVITES_NEEDED} invites**. You have **${data.real}**. ${needed} more needed!`, ephemeral: true }); autoDelete(interaction, 5000); return;
        }
        data.usedKeys++;
        const embed = new EmbedBuilder().setTitle('🎁 Key Redeemed!')
          .setDescription(`✅ You have successfully redeemed **1 key**!\n\nPlease open a **support ticket** or DM an admin to claim your reward.\n\n🔑 Keys used: **${data.usedKeys}**\n🎁 Keys remaining: **${available - 1}**`)
          .setColor(0x00e5ff).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        console.log(`🎁 ${member.user.tag} redeemed a key!`);
        return;
      }
    }

    // ── Modal submits ─────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      // Update modal
      if (interaction.customId === 'update_modal') {
        const product     = interaction.fields.getTextInputValue('product_name').trim();
        const notesRaw    = interaction.fields.getTextInputValue('notes');
        const customTitle = interaction.fields.getTextInputValue('custom_title').trim();
        let imageUrl      = interaction.fields.getTextInputValue('image_url').trim();
        if (imageUrl && !imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
        const statusRaw   = interaction.fields.getTextInputValue('status_transition').trim().toLowerCase();
        const pending = pendingUpdates[interaction.user.id] || {};
        const typeKey = pending.typeKey || 'update';
        const typeInfo = UPDATE_TYPES[typeKey] || { label: typeKey, emoji: '📢' };
        delete pendingUpdates[interaction.user.id];

        let oldStatus = null, newStatus = null;
        if (statusRaw && typeKey !== 'time_extension' && typeKey !== 'new_feature') {
          const { old, new: ns } = parseStatusTransition(statusRaw);
          oldStatus = old; newStatus = ns;
          if (!oldStatus) { const lk = productLastStatus[product.toLowerCase()]; if (lk) oldStatus = STATUS_TYPES[lk] === ns ? null : STATUS_TYPES[lk]; }
        }
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }

        const notes = notesRaw ? notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n') : null;
        const embedColor = newStatus ? newStatus.color : getProductColor(product);
        const fields = [
          { name: 'Product', value: `\`${product}\``, inline: false },
          { name: 'Type',    value: `${typeInfo.emoji}  ${typeInfo.label}`, inline: false },
        ];
        if ((typeKey === 'time_extension' || typeKey === 'new_feature') && statusRaw) fields.push({ name: 'Time Added', value: statusRaw, inline: false });
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: true }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: true }); }
        else if (newStatus) fields.push({ name: 'Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notes) fields.push({ name: 'Notes', value: notes, inline: false });

        const embed = new EmbedBuilder()
          .setTitle((customTitle ? customTitle.toUpperCase() : product.toUpperCase()))
          .setColor(embedColor).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (imageUrl) embed.setThumbnail(imageUrl);

        const productData = getProductByName(product);
        const downloadUrl = productData ? (productData.url || '') : '';
        const buttonRow = downloadUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(downloadUrl).setStyle(ButtonStyle.Link)) : null;
        const payload = { embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) };
        try {
          await interaction.channel.send(payload);
          await interaction.reply({ content: `✅ Update posted to <#${interaction.channel.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Announce modal
      if (interaction.customId === 'announce_modal') {
        const title    = interaction.fields.getTextInputValue('announce_title').trim();
        const message  = interaction.fields.getTextInputValue('announce_message').trim();
        const chanName = interaction.fields.getTextInputValue('announce_channel').trim();
        const pingStr  = interaction.fields.getTextInputValue('announce_ping').trim();
        let dlUrl      = interaction.fields.getTextInputValue('announce_download').trim();
        if (dlUrl && !dlUrl.startsWith('http')) dlUrl = 'https://' + dlUrl;

        let targetCh = interaction.channel;
        if (chanName) { const f = (guild => guild.channels.cache.get(chanName) || findChannelByName(guild, chanName.replace('#','')))(interaction.guild); if (f) targetCh = f; }

        let pingText = '@everyone';
        if (pingStr) {
          const clean = pingStr.replace('@','').trim().toLowerCase();
          if (clean === 'everyone') pingText = '@everyone';
          else if (clean === 'here') pingText = '@here';
          else { const rm = pingStr.match(/\d+/); if (rm) pingText = `<@&${rm[0]}>`; else { const r = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === clean); if (r) pingText = `<@&${r.id}>`; } }
        }

        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (title) embed.setTitle(title);
        embed.setDescription(message).setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const buttonRow = dlUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(dlUrl).setStyle(ButtonStyle.Link)) : null;
        try {
          await targetCh.send({ content: pingText, embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) });
          await interaction.reply({ content: `✅ Announcement posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Status update modal
      if (interaction.customId === 'setstatus_modal') {
        const product   = interaction.fields.getTextInputValue('ss_product').trim();
        const statusRaw = interaction.fields.getTextInputValue('ss_status').trim().toLowerCase();
        const notesRaw  = interaction.fields.getTextInputValue('ss_notes').trim();
        const pingStr   = interaction.fields.getTextInputValue('ss_ping').trim();
        const { old: oldStatus, new: newStatus } = parseStatusTransition(statusRaw);
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }
        const fields = [{ name: 'Product', value: `\`${product.toUpperCase()}\``, inline: false }];
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: false }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false }); }
        else if (newStatus) fields.push({ name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notesRaw) fields.push({ name: 'Notes', value: notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n'), inline: false });
        const embed = new EmbedBuilder().setTitle('Status Change').setColor(getProductColor(product)).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const statusCh = findChannelByName(interaction.guild, 'statusupdates') || interaction.channel;
        let pingText = '@everyone';
        if (pingStr) { const clean = pingStr.replace('@','').trim().toLowerCase(); if (clean==='everyone') pingText='@everyone'; else if (clean==='here') pingText='@here'; else { const rm=pingStr.match(/\d+/); if(rm) pingText=`<@&${rm[0]}>`; else { const r=interaction.guild.roles.cache.find(r=>r.name.toLowerCase()===clean); if(r) pingText=`<@&${r.id}>`; } } }
        try {
          await statusCh.send({ content: pingText, embeds: [embed] });
          await interaction.reply({ content: `✅ Status update posted to <#${statusCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Reseller links modal
      if (interaction.customId === 'reseller_links_modal') {
        let applyUrl = interaction.fields.getTextInputValue('reseller_apply_url').trim();
        let panelUrl = interaction.fields.getTextInputValue('reseller_panel_url').trim();
        if (applyUrl && !applyUrl.startsWith('http')) applyUrl = 'https://' + applyUrl;
        if (panelUrl && !panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
        resellerLinks.apply = applyUrl; resellerLinks.panel = panelUrl;
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(applyUrl),
              new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(panelUrl),
            );
            await msg.edit({ components: [row] });
          } catch (_) {}
        }
        await interaction.reply({ content: `✅ Links updated!\n**Apply:** ${applyUrl}\n**Panel:** ${panelUrl}`, flags: 64 }); autoDelete(interaction, 8000);
        return;
      }

      // Post-link modal (Useful-Links style: bold title + raw URL + footer)
      if (interaction.customId === 'postlink_modal' || interaction.customId.startsWith('postlink_modal::')) {
        const title = interaction.fields.getTextInputValue('postlink_title').trim();
        let url     = interaction.fields.getTextInputValue('postlink_url').trim();
        if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;

        // Resolve target channel: explicit option (stashed in customId) > current channel
        let targetCh = interaction.channel;
        const stashed = interaction.customId.startsWith('postlink_modal::') ? interaction.customId.split('::')[1] : null;
        if (stashed) {
          const found = interaction.guild.channels.cache.get(stashed) || findChannelByName(interaction.guild, stashed);
          if (found) targetCh = found;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(title)
          .setDescription(url)
          .setFooter({ text: `${BOT_NAME}${SITE_URL ? ` | ${SITE_URL}` : ''}`, iconURL: client.user.displayAvatarURL() })
          .setTimestamp();

        try {
          if (!targetCh.isTextBased()) throw new Error('That channel is not a text channel.');
          await targetCh.send({ content: '@everyone', embeds: [embed] });
          await interaction.reply({ content: `✅ Link posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) {
          await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000);
        }
        return;
      }

      // Vouch modal submit
      if (interaction.customId === 'vouch_modal') {
        const ratingRaw  = interaction.fields.getTextInputValue('vouch_rating').trim();
        const feedback   = interaction.fields.getTextInputValue('vouch_feedback').trim();
        const imageUrl   = interaction.fields.getTextInputValue('vouch_image')?.trim() || null;
        const ratingNum  = Math.min(5, Math.max(1, parseInt(ratingRaw) || 1));
        const stars      = '⭐'.repeat(ratingNum);

        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: null, entries: [] };
        gData.count += 1;
        const nowIso = new Date().toISOString();
        const entry = {
          id: gData.count,
          userId: interaction.user.id,
          username: interaction.user.tag || interaction.user.username,
          rating: ratingNum,
          feedback,
          imageUrl,
          timestamp: nowIso,
        };
        gData.entries = gData.entries || [];
        gData.entries.push(entry);
        vouchData.set(interaction.guild.id, gData);
        saveVouches();

        const vouchCh = gData.channelId
          ? (interaction.guild.channels.cache.get(gData.channelId) || interaction.guild.channels.cache.get(VOUCHES_CHANNEL_ID))
          : interaction.guild.channels.cache.get(VOUCHES_CHANNEL_ID);

        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('New Vouch Received 🎉')
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: 'Vouch ID', value: `Nº ${gData.count}`, inline: false },
            { name: 'Rating', value: stars, inline: false },
            { name: 'Feedback', value: feedback, inline: false },
            { name: 'Vouched By', value: `<@${interaction.user.id}>`, inline: false },
            { name: 'Vouched At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false },
          )
          .setFooter({ text: `Thanks for supporting ${BOT_NAME} | ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`, iconURL: client.user.displayAvatarURL() });

        if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);

        const vouchMsg = vouchCh ? await vouchCh.send({ embeds: [embed] }) : null;
        if (vouchMsg) { try { await vouchMsg.react('💯'); await vouchMsg.react('🔥'); } catch (_) {} }

        if (imageUrl) {
          await interaction.reply({ content: '✅ Thank you for your vouch!', ephemeral: true });
        } else {
          await interaction.reply({ content: '✅ Thank you for your vouch! 📸 Want to add a screenshot? Just upload it as a message in this channel within the next 60 seconds and I\'ll attach it automatically — no need for imgur or any external site.', ephemeral: true });

          if (vouchMsg && interaction.channel) {
            const collector = interaction.channel.createMessageCollector({
              filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
              max: 1,
              time: 60000,
            });
            collector.on('collect', async m => {
              const att = [...m.attachments.values()].find(a => a.contentType?.startsWith('image/')) || m.attachments.first();
              if (att) {
                try {
                  const ext = (att.name?.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
                  const fileName = `vouch-${entry.id}.${ext}`;
                  embed.setImage(`attachment://${fileName}`);
                  const file = new AttachmentBuilder(att.url, { name: fileName });
                  await vouchMsg.edit({ embeds: [embed], files: [file] });
                  entry.imageUrl = vouchMsg.embeds?.[0]?.image?.url || att.url;
                  saveVouches();
                } catch (e) { console.error('Vouch image attach error:', e); }
              }
              try { if (m.deletable) await m.delete(); } catch (_) {}
            });
          }
        }
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err.stack || err);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
      else await interaction.reply({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
    } catch (_) {}
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
