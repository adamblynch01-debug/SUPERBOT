// ============================================================
// SMS NUMBER GENERATOR — SUPERBOT MODULE  v2.1
// Fixes: JSON error handling, paginated services/countries (25-cap workaround)
// Commands: /gennumber, /post-smsgen, /set-5sim-api, /set-smspool-api
// ============================================================

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { logGeneration } = require('./genLog');
const { languageRow } = require('./translate');
const brandEmbed = require('./brandEmbed');

// ─── Order persistence ────────────────────────────────────────────────────────
// Buying a number spends REAL provider credit. Orders used to live only in the
// in-memory Map below, so a Railway restart (deploy, OOM, crash) meant the
// 5-minute cancel/refund never fired, the provider kept the charge, the Discord
// message read "waiting" forever, and 🚫 Cancel & Refund answered "Order not
// found" — the money was only recoverable from the provider's own dashboard.
//
// All three helpers swallow their errors: persistence failing must not break a
// purchase that has already happened. They log loudly instead.
async function persistOrder(orderData) {
  try {
    await db.query(
      `INSERT INTO sms_orders
         (order_id, guild_id, provider, service_name, country, number, user_id, channel_id, message_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting')
       ON CONFLICT (order_id) DO UPDATE SET
         message_id = EXCLUDED.message_id, status = 'waiting', resolved_at = NULL`,
      [
        String(orderData.orderId), orderData.guildId || process.env.GUILD_ID || null,
        orderData.provider, orderData.serviceName, orderData.country,
        orderData.number, String(orderData.userId),
        String(orderData.channelId), String(orderData.messageId),
      ]
    );
  } catch (e) {
    console.error('[SMS] could not persist order', orderData.orderId, '-', e.message);
  }
}

async function resolveOrder(orderId, status) {
  try {
    await db.query(
      `UPDATE sms_orders SET status = $2, resolved_at = now() WHERE order_id = $1`,
      [String(orderId), status]
    );
  } catch (e) {
    console.error('[SMS] could not mark order', orderId, 'as', status, '-', e.message);
  }
}

// A number is only worth reviving for about as long as a provider keeps it
// alive. Past that, the resend would fail upstream anyway and the honest answer
// is "generate a new one".
const RECOVER_MAX_AGE_MS = 20 * 60 * 1000;

// Rebuild an order that is no longer in memory — after a restart, or after its
// grace window lapsed — so the buttons on an old message still mean something.
// The last code is read back off the embed the button is attached to; it is not
// a column, and it is only needed to avoid re-announcing it.
async function recoverOrder(orderId, interaction) {
  let row;
  try {
    const r = await db.query(`SELECT * FROM sms_orders WHERE order_id = $1`, [String(orderId)]);
    row = (r.rows || [])[0];
  } catch (e) {
    console.error('[SMS] could not load order', orderId, '-', e.message);
    return null;
  }
  if (!row) return null;
  const age = Date.now() - new Date(row.created_at).getTime();
  if (!(age >= 0) || age > RECOVER_MAX_AGE_MS) return null;

  const embed = interaction?.message?.embeds?.[0];
  const codeField = (embed?.fields || []).find(f => /Your Code/i.test(f.name));
  const lastCode = codeField ? codeField.value.replace(/[`#\s]/g, '') || null : null;

  const order = {
    orderId: String(row.order_id), provider: row.provider, serviceName: row.service_name,
    country: row.country, number: row.number, userId: row.user_id,
    channelId: row.channel_id, messageId: row.message_id, guildId: row.guild_id,
    startedAt: Date.now(), pollTimer: null, graceTimer: null, lastCode,
  };
  activeOrders.set(String(orderId), order);
  return order;
}

// Called once after the Discord client is ready. Any order still open is either
// resumed (if it is inside the refund window) or cancelled and refunded now.
async function rehydrateOrders(client) {
  let rows = [];
  try {
    const r = await db.query(
      `SELECT * FROM sms_orders WHERE resolved_at IS NULL ORDER BY created_at ASC LIMIT 200`
    );
    rows = r.rows || [];
  } catch (e) {
    console.error('[SMS] could not read open orders on boot:', e.message);
    return;
  }
  if (!rows.length) return;
  console.log(`[SMS] rehydrating ${rows.length} open order(s) after restart`);

  for (const row of rows) {
    const orderData = {
      orderId: row.order_id, provider: row.provider, serviceName: row.service_name,
      country: row.country, number: row.number, userId: row.user_id,
      channelId: row.channel_id, messageId: row.message_id,
      guildId: row.guild_id,
      // Preserve the ORIGINAL purchase time so the refund window is measured
      // from when money was actually spent, not from this restart.
      startedAt: new Date(row.created_at).getTime(),
    };
    try {
      startPolling(client, row.order_id, orderData);
    } catch (e) {
      console.error('[SMS] rehydrate failed for', row.order_id, '-', e.message);
    }
  }
}

// ─── Persistent config ────────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || './data';
const CONFIG_FILE = path.join(DATA_DIR, 'sms-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── Active order tracker ─────────────────────────────────────────────────────
const activeOrders = new Map();

// ─── Access gate ──────────────────────────────────────────────────────────────
// Same rules as the Steam gen: 💎 Gen Member (or higher) to use it, one number
// per person per day, staff/OVERSEER unlimited. The role logic lives in
// index.js and reads the per-guild `/setup` config, so it is INJECTED here
// rather than reimplemented — two copies of "who counts as staff" is exactly
// how a gate ends up open on one command and shut on another.
const SMS_COOLDOWN_HOURS = parseInt(process.env.SMS_COOLDOWN_HOURS || '24');
const SMS_QUOTA_KEY      = 'sms-number';

let accessGate = null;
function setAccessGate(gate) { accessGate = gate; }

// Returns null when the member may proceed, or a ready-to-send reply object.
// Fails CLOSED throughout — no gate installed, a thrown gate, a DM with no
// member object. Every path past this point spends real provider credit, so
// "we couldn't tell" must never resolve to "go ahead".
async function checkSmsAccess(interaction, { consume = false } = {}) {
  if (!accessGate) {
    console.error('[SMS] access gate not installed — refusing. index.js must call setSMSAccessGate().');
    return { content: '❌ SMS Gen is not configured right now. Please tell staff.', flags: 64 };
  }
  if (!interaction.guild || !interaction.member) {
    return { content: '❌ SMS Gen only works inside the server, not in DMs.', flags: 64 };
  }

  let allowed, unlimited;
  try {
    allowed   = await accessGate.canAccess(interaction.member);
    unlimited = await accessGate.hasUnlimited(interaction.member);
  } catch (e) {
    console.error('[SMS] access gate failed:', e.message);
    return { content: '❌ Could not verify your access right now. Try again in a moment.', flags: 64 };
  }

  if (!allowed) {
    return { content: `❌ You need the **💎 Gen Member** role to generate a number.`, flags: 64 };
  }
  if (unlimited) return null;

  const last = await accessGate.getCooldown(interaction.guild.id, interaction.user.id, SMS_QUOTA_KEY);
  if (last) {
    const readyMs = new Date(last).getTime() + SMS_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (Date.now() < readyMs) {
      return {
        content: `⏳ You've already generated a number today. You can generate another <t:${Math.floor(readyMs / 1000)}:R>.`,
        flags: 64,
      };
    }
  }
  // Only stamped once the number is actually in hand — checking the picker
  // twice must not burn the day's allowance.
  if (consume) await accessGate.setCooldown(interaction.guild.id, interaction.user.id, SMS_QUOTA_KEY);
  return null;
}

// Hand the day's allowance back when the purchase it was stamped for never
// happened. Best-effort: failing to release is a worse outcome for the member
// than for the business, but it must not turn into a thrown error on a path
// that is already reporting a failure.
async function releaseSmsQuota(interaction) {
  if (!accessGate || !interaction.guild) return;
  try {
    await accessGate.clearCooldown(interaction.guild.id, interaction.user.id, SMS_QUOTA_KEY);
  } catch (e) {
    console.error('[SMS] could not release quota for', interaction.user.id, '-', e.message);
  }
}

// ─── Where order cards go ─────────────────────────────────────────────────────
// Numbers used to be posted into whatever channel the buyer ran /gennumber in,
// which flooded #sms-verify with order cards. They now go to a dedicated
// channel. Override order: /set-smsgen-channel → env → this default.
const SMS_ORDER_CHANNEL_ID = '1532424953570267376';

// What the channel is called when nobody has configured one. The panel is
// posted in #sms-verify and the number cards belong in #sms-number-generated —
// two channels, and the bot should find the second one by name rather than
// dropping the card next to the panel and calling that configured.
const SMS_ORDER_CHANNEL_NAME = 'sms-number-generated';

// The panel's per-guild SMS gen channel, installed by index.js. It goes ahead
// of loadConfig() because that file, the env var and the default below are all
// one value for the whole bot — and client.channels.fetch resolves across
// guilds, so the second server's order cards were posted in the first server's
// channel rather than failing.
let settingsFor = async () => null;
function setSmsSettingsProvider(fn) { if (typeof fn === 'function') settingsFor = fn; }

// index.js's findChannelByName — it normalizes the mathematical-bold names the
// second server uses, which a plain toLowerCase() does not.
let findChannel = () => null;
function setSmsChannelFinder(fn) { if (typeof fn === 'function') findChannel = fn; }

// Resolving an id to a channel is not enough: `client.channels.fetch` is
// BOT-WIDE, so an id left over from the first server resolves perfectly well
// while standing in the second and posts a member's number where they cannot
// see it. A channel is only usable if it is in the guild that asked.
async function usableIn(client, guild, id) {
  if (!id || !guild) return null;
  const cached = guild.channels.cache.get(String(id));
  if (cached) return typeof cached.send === 'function' ? cached : null;
  try {
    const ch = await client.channels.fetch(String(id));
    if (!ch || typeof ch.send !== 'function') return null;
    if (ch.guildId !== guild.id) {
      console.warn('[SMS] order channel', id, 'belongs to another server — ignoring it here');
      return null;
    }
    return ch;
  } catch (e) {
    console.error('[SMS] order channel', id, 'unusable:', e.message);
    return null;
  }
}

async function resolveOrderChannel(client, interaction) {
  const guild = interaction && interaction.guild;
  if (!guild) return interaction.channel;

  let fromPanel = null;
  try {
    const s = await settingsFor(guild.id);
    fromPanel = (s && s.smsGenChannelId) || null;
  } catch (e) {
    console.error('[SMS] could not read guild settings:', e.message);
  }

  // The panel setting wins — unless it points at the channel the member is
  // standing in, which is the panel's own channel. That is not a destination,
  // it is the setting having been read as "where the SMS generator runs".
  if (fromPanel && String(fromPanel) !== String(interaction.channelId)) {
    const ch = await usableIn(client, guild, fromPanel);
    if (ch) return ch;
  }

  // By name, in THIS guild. This is what makes a second server work with
  // nothing configured at all.
  const byName = findChannel(guild, SMS_ORDER_CHANNEL_NAME);
  if (byName && typeof byName.send === 'function' && byName.id !== interaction.channelId) return byName;

  // The old chain last, and only if it lands in this guild. All three of these
  // are one value for the whole bot, so on any server but the first they are
  // someone else's channel.
  const cfg = loadConfig();
  for (const id of [cfg.orders_channel_id, process.env.SMS_GEN_CHANNEL_ID, SMS_ORDER_CHANNEL_ID]) {
    const ch = await usableIn(client, guild, id);
    if (ch) return ch;
  }

  // Never let a missing channel swallow a number that has already been paid
  // for — fall back to the channel the buyer is standing in.
  return interaction.channel;
}

// ─── Safe JSON fetch — handles plain-text error responses ─────────────────────
// Timeout added: every SMSPool/5sim call goes through here, and none of them had
// one. A provider that accepts the connection and stalls left the promise
// unsettled forever — the interaction spun until Discord gave up, and for a
// purchase that meant real provider credit was spent with the bot unable to
// report or cancel it.
const FETCH_TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS) || 15000;

async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    // Give the caller something it can put in front of a user; the raw
    // AbortError message ("This operation was aborted") explains nothing.
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw new Error(`The SMS provider did not respond within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // Strip HTML tags if response is an HTML error page
    const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(clean || `HTTP ${r.status}`);
  }
}

// ─── SMSPOOL API ──────────────────────────────────────────────────────────────
const SMSPOOL_BASE = 'https://api.smspool.net';
const SMSPOOL_COUNTRY_BASE = 'https://api.smspool.net';

async function smspoolGetServices(apiKey) {
  const svcParams = new URLSearchParams({ api_key: apiKey });
  const d = await safeFetch(`${SMSPOOL_BASE}/service/retrieve_all`, { method: 'POST', body: svcParams });
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch services');
  // Return ALL services; caller handles pagination
  return d.map(s => ({ label: s.name.slice(0, 100), value: String(s.ID) }));
}

async function smspoolGetCountries(apiKey, serviceId) {
  const cntParams = new URLSearchParams({ api_key: apiKey });
  const d = await safeFetch(`${SMSPOOL_BASE}/country/retrieve_all`, { method: 'POST', body: cntParams });
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch countries');
  // Use short_name (US/GB/etc) as value — that's what /purchase/sms expects for country param
  return d
    .filter(c => c.short_name)
    .map(c => ({ label: c.name.slice(0, 100), value: c.short_name }));
}

async function smspoolBuyNumber(apiKey, serviceId, countryShort, serviceName) {
  // /purchase/sms expects: country = short_name (US/GB), service = service name string
  const serviceParam = serviceName || serviceId;
  console.log('[SMSPOOL PURCHASE] service=' + serviceParam + ' country=' + countryShort);
  const purchaseParams = new URLSearchParams({
    key: apiKey,
    service: serviceParam,
    country: countryShort,
  });
  const d = await safeFetch(`${SMSPOOL_BASE}/purchase/sms`, { method: 'POST', body: purchaseParams });
  console.log('[SMSPOOL PURCHASE RESPONSE] ' + JSON.stringify(d));
  if (d.success !== 1) throw new Error(d.message || 'No numbers available for this country/service — try a different country');
  return { orderId: String(d.order_id), number: d.phonenumber || d.number };
}

async function smspoolCheckSMS(apiKey, orderId) {
  const d = await safeFetch(`${SMSPOOL_BASE}/sms/check?key=${apiKey}&orderid=${orderId}`);
  // /sms/check: status = "pending" | "completed" | "expired" | "refunded"
  // sms field = the code, full_sms = full message text
  const code = d.sms && d.sms !== '0' && d.sms !== 0 ? String(d.sms) : null;
  return { status: d.status, code };
}

async function smspoolCancel(apiKey, orderId) {
  await safeFetch(`${SMSPOOL_BASE}/sms/cancel?key=${apiKey}&orderid=${orderId}`, { method: 'POST' }).catch(() => {});
}

async function smspoolResend(apiKey, orderId) {
  const d = await safeFetch(`${SMSPOOL_BASE}/sms/resend?key=${apiKey}&orderid=${orderId}`, { method: 'POST' }).catch(() => ({}));
  return d.success === 1;
}

// ─── 5SIM API ─────────────────────────────────────────────────────────────────
const FIVESIM_BASE = 'https://5sim.net/v1';

function fivesimHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
}

async function fivesimGetProducts(apiKey, country = 'any') {
  const d = await safeFetch(`${FIVESIM_BASE}/guest/products/${country}/any`, {
    headers: fivesimHeaders(apiKey),
  });
  if (d.message) throw new Error(d.message);
  return Object.keys(d).map(s => ({ label: capitalize(s).slice(0, 100), value: s }));
}

async function fivesimGetCountries(apiKey) {
  const d = await safeFetch(`${FIVESIM_BASE}/guest/countries`, {
    headers: fivesimHeaders(apiKey),
  });
  if (d.message) throw new Error(d.message);
  // Returns { countryKey: { iso: , prefix: , text_en: } }
  return Object.entries(d).map(([key, val]) => ({
    label: (val.text_en || capitalize(key)).slice(0, 100),
    value: key,
  }));
}

async function fivesimGetOperators(apiKey, country, service) {
  const d = await safeFetch(`${FIVESIM_BASE}/guest/products/${country}/any`, {
    headers: fivesimHeaders(apiKey),
  });
  if (d.message) throw new Error(d.message);
  const svcData = d[service];
  if (!svcData) throw new Error(`Service "${service}" not available in ${country}`);
  // Returns operators keyed by name, each has { cost, count, rate }
  //
  // ⚠ The `$` below is NOT the shop's currency and must not be swept into `€`
  // with the rest. This is the SMS provider's own price list, billed against our
  // account with them in genuine US dollars; the shop sells in euro and the two
  // figures are not the same money. Printing a provider cost as "€0.30" would
  // read as a euro charge that nobody is ever billed.
  const ops = Object.entries(svcData).map(([op, info]) => ({
    label: `${op} — $${info.cost} (${info.count} avail, ${Math.round(info.rate * 100)}% rate)`.slice(0, 100),
    value: op,
    count: info.count,
    cost:  info.cost,
  }));
  // Sort best first: highest rate, then most stock
  ops.sort((a, b) => b.rate - a.rate || b.count - a.count);
  // Always add "any" as first option
  return [
    { label: '⭐ Any operator (recommended)', value: 'any' },
    ...ops.filter(o => o.count > 0),
  ];
}

async function fivesimBuyNumber(apiKey, country, service, operator = 'any') {
  const d = await safeFetch(
    `${FIVESIM_BASE}/user/buy/activation/${country}/${operator}/${service}`,
    { headers: fivesimHeaders(apiKey) }
  );
  if (d.message) throw new Error(d.message);
  return { orderId: String(d.id), number: d.phone };
}

async function fivesimCheckSMS(apiKey, orderId) {
  const d = await safeFetch(`${FIVESIM_BASE}/user/check/${orderId}`, {
    headers: fivesimHeaders(apiKey),
  });
  // `count` lets the poller tell a genuinely new message from the same one
  // being served again after a resend — see the isNew check in startPolling.
  const list = Array.isArray(d.sms) ? d.sms : [];
  const code = list.length > 0 ? list[list.length - 1].code : null;
  return { status: d.status, code, count: list.length };
}

async function fivesimCancel(apiKey, orderId) {
  await safeFetch(`${FIVESIM_BASE}/user/cancel/${orderId}`, {
    headers: fivesimHeaders(apiKey),
  }).catch(() => {});
}

async function fivesimFinish(apiKey, orderId) {
  await safeFetch(`${FIVESIM_BASE}/user/finish/${orderId}`, {
    headers: fivesimHeaders(apiKey),
  }).catch(() => {});
}

// ─── Pagination helper ────────────────────────────────────────────────────────
// Discord select menus max 25 options. We chunk large lists and encode
// page state in the customId so users can page through.
const PAGE_SIZE = 23; // leave 2 slots for Prev/Next

function getPage(items, page) {
  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  return { slice, totalPages, page };
}

function buildPagedMenu(customId, items, page, placeholder) {
  const { slice, totalPages } = getPage(items, page);
  const options = [...slice];

  if (page > 0)
    options.push({ label: `⬅ Previous page (${page}/${totalPages})`, value: `__prev__${page}` });
  if ((page + 1) < totalPages)
    options.push({ label: `➡ Next page (${page + 1}/${totalPages})`, value: `__next__${page}` });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(options)
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Providers are never named to users. Which upstream a number came from is
// supplier information, not customer information — the emoji is the entire
// public identity of a network. `maskProvider` scrubs the names back out of
// anything a provider hands us (their error strings are quoted verbatim to the
// buyer, and several of them include their own brand).
const PROVIDER_EMOJI = { smspool: '💬', '5sim': '5️⃣' };
const PROVIDER_COLOR = { smspool: 0x5865f2, '5sim': 0x57f287 };
const PROVIDER_BLURB = {
  smspool: 'Fast, wide country coverage',
  '5sim':  '135+ countries, operator selection',
};

function providerTag(provider) {
  return PROVIDER_EMOJI[provider] || '📲';
}

function maskProvider(text) {
  return String(text == null ? '' : text)
    .replace(/\bsms\s*pool(\.net)?\b/gi, 'the network')
    .replace(/\b5\s*sim(\.net)?\b/gi, 'the network');
}

function buildOrderEmbed(provider, serviceName, country, number, status, code) {
  const statusMap = {
    waiting:   { label: '⏳ Waiting for SMS...', color: 0xfee75c },
    received:  { label: '✅ Code received!',       color: 0x57f287 },
    failed:    { label: '❌ No SMS / Failed',       color: 0xed4245 },
    cancelled: { label: '🚫 Cancelled & Refunded',  color: 0x99aab5 },
    resent:    { label: '🔄 Re-request sent...',    color: 0x5865f2 },
  };
  const s = statusMap[status] || statusMap.waiting;

  return new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`${providerTag(provider)} SMS Number Generated`)
    .addFields(
      { name: '🔧 Network', value: providerTag(provider), inline: true },
      { name: '📋 Service',  value: serviceName,         inline: true },
      { name: '🌍 Country',  value: capitalize(country), inline: true },
      { name: '📞 Number',   value: `\`${number}\``,     inline: false },
      { name: '📡 Status',   value: s.label,             inline: false },
      // No `# ` heading prefix: inside an embed field Discord prints the hash
      // literally, so the code read "# 544600" and a tap-to-copy took the
      // stray character with it.
      ...(code ? [{ name: '🔑 Your Code', value: `\`${code}\``, inline: false }] : []),
    )
    .setFooter({ text: "ZEROPOINT • SMS Gen  |  Code didn't work? Hit 🔄 for a new one or 🚫 to cancel & refund" })
    .setTimestamp();
}

// `disabled` closes the whole order out. `resendEnabled` is the exception that
// matters: once a code has arrived the order is finished for refund purposes,
// but "Request New SMS" must stay live — a code that Discord/Activision rejects
// is the single most common reason a buyer needs a second one, and greying the
// button out at exactly that moment was the reported bug.
function buildOrderButtons(orderId, disabled = false, number = null, resendEnabled = null) {
  const resendOff = resendEnabled === null ? disabled : !resendEnabled;
  const btns = [
    new ButtonBuilder()
      .setCustomId(`sms_resend_${orderId}`)
      .setLabel('Request New SMS')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(resendOff),
    new ButtonBuilder()
      .setCustomId(`sms_cancel_${orderId}`)
      .setLabel('Cancel & Refund')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  ];
  if (number) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`sms_copy_${orderId}`)
        .setLabel('Copy Number')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(false), // always enabled so user can copy anytime
    );
  }
  return new ActionRowBuilder().addComponents(...btns);
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function buildPanelEmbed(guild) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📲 SMS Number Generator')
    .setDescription(
      '**Get a temporary phone number for SMS verification on any platform.**\n\n' +
      '> Click **Get Number** below to choose your network, service, and country.\n\n' +
      '**Access**\n' +
      '> You need the **💎 Gen Member** role (or higher) to use this.\n' +
      `> Limit: **one number per person every ${SMS_COOLDOWN_HOURS}h**. Staff/OVERSEER have no limit.\n\n` +
      '**Available Networks**\n' +
      `> ${PROVIDER_EMOJI.smspool} — ${PROVIDER_BLURB.smspool}\n` +
      `> ${PROVIDER_EMOJI['5sim']} — ${PROVIDER_BLURB['5sim']}\n\n` +
      '**How it works**\n' +
      '> `1.` Choose network → service → country\n' +
      '> `2.` Bot purchases & displays your number\n' +
      '> `3.` Enter it on the site you\'re verifying\n' +
      '> `4.` Code arrives here automatically\n\n' +
      '**Code didn\'t work?**\n' +
      '> Hit **🔄 Request New SMS** to try again on the same number\n' +
      '> Hit **🚫 Cancel & Refund** to get your balance back and try a different number\n' +
      '> Numbers auto-cancel after **5 minutes** if no SMS arrives'
    )
    .setFooter({ text: 'ZEROPOINT • SMS Gen' })
    .setTimestamp();

  brandEmbed(embed, guild);
  return embed;
}

function buildPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('sms_open_panel')
      .setLabel('Get Number')
      .setEmoji('📲')
      .setStyle(ButtonStyle.Primary),
  );
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
const POLL_INTERVAL = 7000;
const POLL_TIMEOUT  = 5 * 60 * 1000;

// How long a delivered order stays clickable. Polling stops the moment a code
// lands — but the order stays in `activeOrders` for this long so 🔄 Request New
// SMS still resolves, because the button is needed precisely *after* a code has
// arrived and been rejected by the site. It used to be deleted immediately and
// the button disabled in the same breath, so it could never work.
const RESEND_GRACE_MS = 15 * 60 * 1000;

function scheduleGraceExpiry(orderId, apiKey) {
  const order = activeOrders.get(orderId);
  if (!order) return;
  if (order.graceTimer) clearTimeout(order.graceTimer);
  order.graceTimer = setTimeout(async () => {
    const still = activeOrders.get(orderId);
    if (!still || still.pollTimer) return; // resend restarted it — leave it alone
    // 5sim's finish is deferred to here: calling it at code-receipt time closes
    // the activation, and a closed activation can never deliver the second code
    // the resend button exists to wait for. Money is already committed at
    // purchase, and 5sim only auto-refunds when no SMS arrived, so holding the
    // order open through the grace window costs nothing.
    if (still.provider === '5sim') await fivesimFinish(apiKey, orderId).catch(() => {});
    activeOrders.delete(orderId);
  }, RESEND_GRACE_MS);
}

async function startPolling(client, orderId, orderData) {
  const cfg    = loadConfig();
  const { provider, serviceName, country, number, userId, channelId, messageId } = orderData;
  const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
  // On a rehydrated order this is the ORIGINAL purchase time, so the refund
  // window is measured from when the money was spent — a restart must not hand
  // the order a fresh 5 minutes, and an order already past the window is
  // cancelled and refunded on the first tick instead of hanging forever.
  const start  = orderData.startedAt || Date.now();

  const poll = async () => {
    if (Date.now() - start > POLL_TIMEOUT) {
      // A number that already delivered a code has been paid for and used, so
      // it must not be announced as "cancelled & refunded" — that is a second
      // code that never came, not a failed purchase.
      const hadCode = !!orderData.lastCode;
      try {
        if (provider === '5sim') {
          if (hadCode) await fivesimFinish(apiKey, orderId);
          else await fivesimCancel(apiKey, orderId);
        } else if (!hadCode) {
          await smspoolCancel(apiKey, orderId);
        }
        const ch  = await client.channels.fetch(channelId);
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, hadCode ? 'received' : 'failed', orderData.lastCode)],
          components: [buildOrderButtons(orderId, true, number)],
        });
        await ch.send({
          content: hadCode
            ? `<@${userId}> ⌛ No further codes arrived — this number is now closed. Generate a new one if you still need to verify.`
            : `<@${userId}> ⏰ No SMS after 5 minutes — number cancelled & balance refunded.`,
        });
      } catch {}
      if (orderData.graceTimer) clearTimeout(orderData.graceTimer);
      activeOrders.delete(orderId);
      await resolveOrder(orderId, hadCode ? 'received' : 'failed');
      return;
    }

    try {
      const result = provider === '5sim'
        ? await fivesimCheckSMS(apiKey, orderId)
        : await smspoolCheckSMS(apiKey, orderId);

      const ch  = await client.channels.fetch(channelId);
      const msg = await ch.messages.fetch(messageId);

      // Both providers keep serving the LAST code from /check, so after a
      // resend the very first poll would re-announce the code the buyer just
      // told us didn't work. 5sim gives a message count to compare against;
      // SMSPool only the code itself.
      const isNew = !!result.code && (
        result.count != null
          ? result.count > (orderData.smsSeen || 0)
          : result.code !== orderData.lastCode
      );

      if (isNew) {
        orderData.lastCode = result.code;
        if (result.count != null) orderData.smsSeen = result.count;
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'received', result.code)],
          components: [buildOrderButtons(orderId, true, number, true)],
        });
        await ch.send({
          content: `<@${userId}> ✅ Your SMS code: **\`${result.code}\`**\n> Code didn't work? Hit **🔄 Request New SMS** above.`,
        });
        // Stop polling but keep the order alive so the resend button resolves.
        if (orderData.pollTimer) clearTimeout(orderData.pollTimer);
        orderData.pollTimer = null;
        activeOrders.set(orderId, orderData);
        scheduleGraceExpiry(orderId, apiKey);
        await resolveOrder(orderId, 'received');
        return;
      }

      const dead = ['CANCELED', 'TIMEOUT', 'BANNED', 'expired', 'refunded', 'error'].includes(result.status);
      if (dead) {
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true, number)],
        });
        await ch.send({ content: `<@${userId}> ❌ Number expired/banned by provider — no charge applied.` });
        activeOrders.delete(orderId);
        await resolveOrder(orderId, 'failed');
        return;
      }
    } catch (e) {
      console.error('[SMS POLL ERROR]', e.message);
    }

    const timer = setTimeout(poll, POLL_INTERVAL);
    const existing = activeOrders.get(orderId);
    if (existing) existing.pollTimer = timer;
  };

  // A rehydrated order that is already past its refund window must not wait a
  // further POLL_INTERVAL before being cancelled — run the first check now.
  const overdue = Date.now() - start > POLL_TIMEOUT;
  orderData.pollTimer = setTimeout(poll, overdue ? 0 : POLL_INTERVAL);
  activeOrders.set(orderId, orderData);
}

// ─── Show provider picker (entry point) ───────────────────────────────────────
async function showProviderPicker(interaction) {
  const cfg        = loadConfig();
  const hasFivesim = !!cfg.fivesim_key;
  const hasSmspool = !!cfg.smspool_key;

  if (!hasFivesim && !hasSmspool) {
    const msg = '❌ No API keys configured. An admin must run `/set-5sim-api` or `/set-smspool-api` first.';
    if (interaction.replied || interaction.deferred)
      return interaction.editReply({ content: msg, embeds: [], components: [] });
    return interaction.reply({ content: msg, ephemeral: true });
  }

  const options = [];
  if (hasSmspool) options.push({ label: `${PROVIDER_EMOJI.smspool}  Network`, value: 'smspool', emoji: PROVIDER_EMOJI.smspool, description: PROVIDER_BLURB.smspool });
  if (hasFivesim) options.push({ label: `${PROVIDER_EMOJI['5sim']}  Network`, value: '5sim',    emoji: PROVIDER_EMOJI['5sim'], description: PROVIDER_BLURB['5sim'] });

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('sms_pick_provider')
      .setPlaceholder('1️⃣  Choose a network...')
      .addOptions(options)
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📲 SMS Number Generator')
    .setDescription('**Step 1 of 3** — Select a network')
    .setFooter({ text: 'ZEROPOINT • SMS Gen' });

  if (interaction.replied || interaction.deferred)
    return interaction.editReply({ embeds: [embed], components: [row] });
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── In-memory cache for paginated lists (per user session) ──────────────────
// Key: userId → { services: [], countries: [], operators: [], provider, serviceVal, country }
const userSessionCache = new Map();

// ─── Commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('gennumber')
    .setDescription('📲 Generate a phone number for SMS verification (💎 Gen Member — 1 per day)'),

  new SlashCommandBuilder()
    .setName('post-smsgen')
    .setDescription('Staff: Post the SMS Number Generator panel')
    .addChannelOption(o =>
      o.setName('channel').setDescription('Channel to post in (defaults to current)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set-5sim-api')
    .setDescription('🔑 Set or rotate the 5sim.net API key')
    .addStringOption(o => o.setName('key').setDescription('Your 5sim API key').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('set-smsgen-channel')
    .setDescription('Staff: Set the channel SMS order cards are posted to')
    .addChannelOption(o =>
      o.setName('channel').setDescription('Channel for generated numbers').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set-smspool-api')
    .setDescription('🔑 Set or rotate the SMSPool.net API key')
    .addStringOption(o => o.setName('key').setDescription('Your SMSPool API key').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── Interaction handler ──────────────────────────────────────────────────────
async function handleSMSInteraction(interaction, client) {
  const cfg    = loadConfig();
  const userId = interaction.user.id;

  // ── /set-5sim-api ──────────────────────────────────────────────────────────
  if (interaction.commandName === 'set-5sim-api') {
    const key = interaction.options.getString('key');
    saveConfig({ ...cfg, fivesim_key: key });
    return interaction.reply({ content: '✅ 5sim API key saved.', ephemeral: true });
  }

  // ── /set-smspool-api ───────────────────────────────────────────────────────
  if (interaction.commandName === 'set-smspool-api') {
    const key = interaction.options.getString('key');
    saveConfig({ ...cfg, smspool_key: key });
    return interaction.reply({ content: '✅ SMSPool API key saved.', ephemeral: true });
  }

  // ── /set-smsgen-channel ────────────────────────────────────────────────────
  if (interaction.commandName === 'set-smsgen-channel') {
    const ch = interaction.options.getChannel('channel');
    saveConfig({ ...cfg, orders_channel_id: String(ch.id) });
    return interaction.reply({ content: `✅ Generated numbers will be posted in <#${ch.id}>.`, ephemeral: true });
  }

  // ── /post-smsgen ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'post-smsgen') {
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getChannel('channel') || interaction.channel;
    await target.send({ embeds: [buildPanelEmbed(interaction.guild)], components: [buildPanelButton(), languageRow()] });
    return interaction.editReply({ content: `✅ SMS Gen panel posted in <#${target.id}>` });
  }

  // ── /gennumber ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'gennumber') {
    const denied = await checkSmsAccess(interaction);
    if (denied) return interaction.reply(denied);
    return showProviderPicker(interaction);
  }

  // ── Panel button → open provider picker ────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sms_open_panel') {
    // Checked BEFORE the defer so a denial is a one-shot ephemeral reply
    // rather than an empty "thinking" state the member has to interpret.
    const denied = await checkSmsAccess(interaction);
    if (denied) return interaction.reply(denied);
    await interaction.deferReply({ ephemeral: true });
    return showProviderPicker(interaction);
  }

  // ── Step 2: Provider chosen → fetch ALL services, show search button ─────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'sms_pick_provider') {
    await interaction.deferUpdate();
    const provider = interaction.values[0];
    const apiKey   = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let services;
    try {
      services = provider === '5sim'
        ? await fivesimGetProducts(apiKey)
        : await smspoolGetServices(apiKey);
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to fetch services: ${maskProvider(e.message)}`, embeds: [], components: [] });
    }

    // Cache full list for this user
    userSessionCache.set(userId, { provider, services, countries: [], operators: [], serviceVal: null, serviceName: null, country: null });

    const total = services.length;

    // Show search button instead of a 60-page dropdown
    const searchRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sms_search_service__${provider}`)
        .setLabel(`Search Service  (${total} available)`)
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Primary),
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${providerTag(provider)} Select Service`)
          .setDescription(`**Step 2 of 3** — Find the service you need\n${total} services available — type a name to search`)
          .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
      ],
      components: [searchRow],
    });
  }

  // ── Search button → open modal ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_search_service__')) {
    const provider = interaction.customId.split('__')[1];
    const modal = new ModalBuilder()
      .setCustomId(`sms_modal_search__${provider}`)
      .setTitle('🔍 Search Service');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sms_search_query')
          .setLabel('Service name (e.g. Discord, Activision)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(40)
          .setPlaceholder('Type a service name...')
      )
    );
    return interaction.showModal(modal);
  }

  // ── Modal submitted → filter services, show matching dropdown ─────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('sms_modal_search__')) {
    await interaction.deferUpdate();
    const provider = interaction.customId.split('__')[1];
    const query    = interaction.fields.getTextInputValue('sms_search_query').toLowerCase().trim();
    const session  = userSessionCache.get(userId);

    if (!session || !session.services?.length) {
      return interaction.editReply({ content: '❌ Session expired — please start over.', embeds: [], components: [] });
    }

    const matches = session.services.filter(s => s.label.toLowerCase().includes(query));

    if (matches.length === 0) {
      // No results — show search button again with error
      const searchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sms_search_service__${provider}`)
          .setLabel(`No results for "${query}" — Search again`)
          .setEmoji('🔍')
          .setStyle(ButtonStyle.Danger),
      );
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('❌ No Services Found')
            .setDescription(`No results for **"${query}"** — try a different search term.`)
            .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
        ],
        components: [searchRow],
      });
    }

    // Show up to 25 matches in a dropdown
    const options = matches.slice(0, 25);
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sms_pick_service__${provider}__0`)
        .setPlaceholder(`${matches.length} result${matches.length > 1 ? 's' : ''} for "${query}"`)
        .addOptions(options)
    );

    // Add a "search again" button alongside the results
    const searchAgainRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sms_search_service__${provider}`)
        .setLabel('Search Again')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} Select Service`)
          .setDescription(
            `**Step 2 of 3** — Results for **"${query}"**
` +
            `${matches.length > 25 ? `Showing top 25 of ${matches.length} matches — refine your search if needed` : `${matches.length} match${matches.length > 1 ? 'es' : ''} found`}`
          )
          .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
      ],
      components: [row, searchAgainRow],
    });
  }

  // ── Service menu: handle pagination OR selection ────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_service__')) {
    const parts    = interaction.customId.split('__');
    const provider = parts[1];
    const curPage  = parseInt(parts[2]) || 0;
    const chosen   = interaction.values[0];
    const session  = userSessionCache.get(userId);

    if (!session) {
      await interaction.deferUpdate();
      return interaction.editReply({ content: '❌ Session expired. Please start over.', embeds: [], components: [] });
    }

    // ── Pagination ──
    if (chosen.startsWith('__prev__') || chosen.startsWith('__next__')) {
      await interaction.deferUpdate();
      const newPage = chosen.startsWith('__next__') ? curPage + 1 : curPage - 1;
      const total   = session.services.length;
      const row     = buildPagedMenu(`sms_pick_service__${provider}__${newPage}`, session.services, newPage, `2️⃣  Choose a service... (${total} total)`);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
            .setTitle(`${providerTag(provider)} Select Service`)
            .setDescription(`**Step 2 of 3** — Page ${newPage + 1} of ${Math.ceil(total / PAGE_SIZE)}\n${total} services available`)
            .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
        ],
        components: [row],
      });
    }

    // ── Service selected → fetch countries ──
    await interaction.deferUpdate();
    const serviceVal  = chosen;
    const serviceName = session.services.find(s => s.value === serviceVal)?.label || capitalize(serviceVal);
    session.serviceVal  = serviceVal;
    session.serviceName = serviceName;
    const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let countries;
    try {
      countries = provider === '5sim'
        ? await fivesimGetCountries(apiKey)
        : await smspoolGetCountries(apiKey, serviceVal);
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to fetch countries: ${maskProvider(e.message)}`, embeds: [], components: [] });
    }

    if (provider === '5sim') countries.unshift({ label: '🌍 Any Country (cheapest available)', value: 'any' });
    session.countries = countries;

    const total = countries.length;
    const row   = buildPagedMenu(`sms_pick_country__${provider}__0`, countries, 0, `3️⃣  Choose a country... (${total} total)`);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} Select Country`)
          .setDescription(`**Step 3 of 3** — Service: **${serviceName}**\n${total} countries available`)
          .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
      ],
      components: [row],
    });
  }

  // ── Country menu: handle pagination OR selection ────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_country__')) {
    const parts    = interaction.customId.split('__');
    const provider = parts[1];
    const curPage  = parseInt(parts[2]) || 0;
    const chosen   = interaction.values[0];
    const session  = userSessionCache.get(userId);

    if (!session) {
      await interaction.deferUpdate();
      return interaction.editReply({ content: '❌ Session expired. Please start over.', embeds: [], components: [] });
    }

    // ── Pagination ──
    if (chosen.startsWith('__prev__') || chosen.startsWith('__next__')) {
      await interaction.deferUpdate();
      const newPage = chosen.startsWith('__next__') ? curPage + 1 : curPage - 1;
      const total   = session.countries.length;
      const row     = buildPagedMenu(`sms_pick_country__${provider}__${newPage}`, session.countries, newPage, `3️⃣  Choose a country... (${total} total)`);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
            .setTitle(`${PROVIDER_EMOJI[provider]} Select Country`)
            .setDescription(`**Step 3 of 3** — Service: **${session.serviceName}**\nPage ${newPage + 1} of ${Math.ceil(total / PAGE_SIZE)}`)
            .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
        ],
        components: [row],
      });
    }

    // ── Country selected ──
    // For 5sim: show operator step; for SMSPool: go straight to purchase
    const country    = chosen;
    const apiKey     = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
    session.country  = country;

    if (provider === '5sim' && country !== 'any') {
      // Show operator selection
      await interaction.deferUpdate();
      let operators;
      try {
        operators = await fivesimGetOperators(apiKey, country, session.serviceVal);
      } catch (e) {
        return interaction.editReply({ content: `❌ ${maskProvider(e.message)}`, embeds: [], components: [] });
      }
      session.operators = operators;

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`sms_pick_operator__5sim`)
          .setPlaceholder('4️⃣  Choose an operator...')
          .addOptions(operators.slice(0, 25))
      );

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('🌐 Select Operator')
            .setDescription(`**Service:** ${session.serviceName} · **Country:** ${capitalize(country)}\nPick an operator — higher % = better delivery rate`)
            .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
        ],
        components: [row],
      });
    }

    // SMSPool or 5sim "any" → purchase immediately
    await interaction.deferUpdate();
    return purchaseNumber(interaction, client, provider, apiKey, session, country, 'any');
  }

  // ── Operator selected (5sim only) → purchase ──────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'sms_pick_operator__5sim') {
    await interaction.deferUpdate();
    const operator = interaction.values[0];
    const session  = userSessionCache.get(userId);
    const apiKey   = cfg.fivesim_key;

    if (!session) return interaction.editReply({ content: '❌ Session expired. Please start over.', embeds: [], components: [] });

    return purchaseNumber(interaction, client, '5sim', apiKey, session, session.country, operator);
  }

  // ── Button: Cancel & Refund ────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_cancel_')) {
    const orderId = interaction.customId.replace('sms_cancel_', '');
    const order   = activeOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    if (order.userId !== userId) return interaction.reply({ content: '❌ Only the person who ordered this can cancel it.', ephemeral: true });

    // A number that already delivered a code cannot be refunded — the order is
    // only being held open so 🔄 Request New SMS works. Cancelling it here
    // would promise money back that the provider will never return.
    if (order.lastCode) {
      return interaction.reply({
        content: '❌ This number already received a code, so it can no longer be refunded.\nUse **🔄 Request New SMS** to ask for another code on it, or generate a fresh number.',
        ephemeral: true,
      });
    }

    await interaction.deferUpdate();
    if (order.pollTimer) clearTimeout(order.pollTimer);
    if (order.graceTimer) clearTimeout(order.graceTimer);
    activeOrders.delete(orderId);

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
    if (order.provider === '5sim') await fivesimCancel(apiKey, orderId);
    else await smspoolCancel(apiKey, orderId);

    const { provider, serviceName, country, number } = order;
    await resolveOrder(orderId, 'failed');
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'cancelled')],
      components: [buildOrderButtons(orderId, true, number)],
    });
    return interaction.followUp({ content: '🚫 Number cancelled. Balance refunded to your provider account.', ephemeral: true });
  }

  // ── Button: Request New SMS ────────────────────────────────────────────────
  // Reachable in two states: while still waiting for the first code, and — the
  // case that was broken — after a code arrived and the site rejected it. In
  // that second state the order had been deleted from memory a moment earlier,
  // so this answered "Order not found or already resolved" every time.
  if (interaction.isButton() && interaction.customId.startsWith('sms_resend_')) {
    const orderId = interaction.customId.replace('sms_resend_', '');
    let order = activeOrders.get(orderId);

    // Restarts drop the in-memory order; the row outlives them, so rebuild from
    // it rather than telling the buyer their paid-for number does not exist.
    if (!order) order = await recoverOrder(orderId, interaction);
    if (!order) {
      return interaction.reply({
        content: '❌ This number is closed — a new code can no longer be requested on it. Generate a fresh number with **📲 Get Number**.',
        ephemeral: true,
      });
    }
    if (String(order.userId) !== String(userId)) {
      return interaction.reply({ content: '❌ Only the person who ordered this can do this.', ephemeral: true });
    }

    await interaction.deferUpdate();
    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    if (order.provider === 'smspool') {
      const ok = await smspoolResend(apiKey, orderId);
      if (!ok) {
        return interaction.followUp({
          content: order.lastCode
            ? '❌ This number will not accept another code request — it has already been used once. Generate a fresh number with **📲 Get Number**.'
            : '❌ Resend not available for this number.\nHit **🚫 Cancel & Refund** to get your balance back, then try again.',
          ephemeral: true,
        });
      }
    }
    // 5sim has no resend endpoint — the buyer re-triggers the SMS on the site
    // themselves and the number simply has to still be listening. That is what
    // the deferred finish in scheduleGraceExpiry buys us.

    const { provider, serviceName, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'resent', order.lastCode)],
      components: [buildOrderButtons(orderId, false, number)],
    });

    // Fresh watch window. startedAt is reset deliberately: this is a new wait,
    // and the old timestamp would time the request out on its first tick.
    if (order.graceTimer) clearTimeout(order.graceTimer);
    order.graceTimer = null;
    if (order.pollTimer) clearTimeout(order.pollTimer);
    order.startedAt = Date.now();
    await startPolling(client, orderId, order);

    return interaction.followUp({
      content: order.lastCode
        ? '🔄 Watching for a **new** code on this number — trigger the SMS again on the site. The code above will not be repeated.'
        : '🔄 Re-request sent — still watching for your code...',
      ephemeral: true,
    });
  }

  // ── Button: Copy Number ────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_copy_')) {
    const orderId = interaction.customId.replace('sms_copy_', '');
    // Find number from active order or embed fields
    const order = activeOrders.get(orderId);
    const number = order?.number ||
      interaction.message?.embeds?.[0]?.fields?.find(f => f.name.includes('Number'))?.value?.replace(/`/g, '').trim();
    if (!number) return interaction.reply({ content: '❌ Could not retrieve number.', ephemeral: true });
    // Wrapped in a code span, and nothing else in the message.
    //
    // This used to send the bare digits, on the assumption that a bare string
    // is the easiest thing to copy. On mobile it is the hardest: plain text
    // has to be long-pressed, then the selection handles dragged to the right
    // ends. Discord renders a code span with a one-tap copy affordance — the
    // exact reason the arriving CODE could be copied with a single tap while
    // the number, the one thing this button exists for, could not.
    //
    // Any label text has to stay out of the message: the tap copies the code
    // span alone, but a stray prefix invites the user to select the line.
    return interaction.reply({
      content: `\`${number}\``,
      ephemeral: true,
    });
  }

}

// ─── Purchase handler (shared by SMSPool + 5sim paths) ───────────────────────
async function purchaseNumber(interaction, client, provider, apiKey, session, country, operator) {
  const { serviceVal, serviceName } = session;

  // The authoritative check. The picker gate above is only fast feedback — a
  // member could sit on an open picker past midnight, or hold one from before
  // the role was taken away, and every step from here on spends real credit.
  const denied = await checkSmsAccess(interaction, { consume: true });
  if (denied) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('❌ Not Available')
          .setDescription(denied.content)
          .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
      ],
      components: [],
    });
  }

  let orderId, number;
  try {
    if (provider === '5sim') {
      ({ orderId, number } = await fivesimBuyNumber(apiKey, country, serviceVal, operator));
    } else {
      ({ orderId, number } = await smspoolBuyNumber(apiKey, serviceVal, country, serviceName));
    }
  } catch (e) {
    // The quota was stamped BEFORE the buy — otherwise two clicks in the same
    // second both pass the check and both spend credit. So a failed buy has to
    // hand the day's allowance back, or a provider outage costs the member
    // their number.
    await releaseSmsQuota(interaction);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('❌ Failed to Purchase Number')
          .setDescription(`**${maskProvider(e.message)}**\n\nNo charge was applied. Try a different country or network.`)
          .setFooter({ text: 'ZEROPOINT • SMS Gen' }),
      ],
      components: [],
    });
  }

  // Clean up session cache
  userSessionCache.delete(interaction.user.id);

  const target = await resolveOrderChannel(client, interaction);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(
      target.id === interaction.channel?.id
        ? '✅ Number purchased! Your order is posted below.'
        : `✅ Number purchased! Your order is posted in <#${target.id}>.`
    )],
    components: [],
  });

  const publicMsg = await target.send({
    content: `<@${interaction.user.id}>`,
    embeds:  [buildOrderEmbed(provider, serviceName, country, number, 'waiting')],
    components: [buildOrderButtons(orderId, false, number)],
  });

  const orderData = {
    orderId,
    provider, serviceName, country, number,
    userId:    interaction.user.id,
    channelId: target.id,
    messageId: publicMsg.id,
    guildId:   interaction.guildId || null,
    pollTimer: null,
    graceTimer: null,
    lastCode:  null,
    smsSeen:   0,
  };

  // Persist BEFORE polling starts: the money has already left the provider
  // balance by this point, so the row must exist even if the process dies on
  // the very next line.
  await persistOrder(orderData);

  // Gen log. The number is included here where an account's credentials are
  // not: it is already posted publicly in the order channel above, and it is
  // the only handle staff have if the provider order has to be chased.
  logGeneration(client, {
    kind: 'sms',
    user: interaction.user,
    what: `${serviceName} — ${country}`,
    detail: `\`${number}\`  ·  ${provider}  ·  order \`${orderId}\``,
    source: '/gennumber',
    guildId: interaction.guild && interaction.guild.id,
  }).catch(() => {});

  await startPolling(client, orderId, orderData);
}

module.exports = {
  commands, handleSMSInteraction, rehydrateOrders,
  setAccessGate, setSMSAccessGate: setAccessGate,
  setSmsSettingsProvider, setSmsChannelFinder,
  // Exported for test_sms_gate.js. This gate stands between a button click and
  // real provider credit, so its fail-closed behaviour is asserted, not assumed.
  _internals: {
    checkSmsAccess, releaseSmsQuota, SMS_COOLDOWN_HOURS, SMS_QUOTA_KEY,
    resolveOrderChannel, usableIn, SMS_ORDER_CHANNEL_NAME,
    setSmsSettingsProvider, setSmsChannelFinder,
  },
};
