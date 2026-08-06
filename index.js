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
  GuildSystemChannelFlags,
} = require('discord.js');

const { createCanvas, loadImage } = require('canvas');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');

// Every axios call in this file talked to the payment backend with NO timeout,
// so a backend that accepts the TCP connection and never responds (Railway
// mid-deploy, Supabase holding a connection) left the promise unsettled
// forever: the deferred interaction spun until Discord gave up, the handler's
// closure was retained, and when the socket finally errored — past the
// 15-minute token window — the catch's editReply threw 10015 on top.
//
// Set on the module default rather than a new instance so it covers all 19 call
// sites, including any added later. A timeout surfaces as ECONNABORTED, which
// the existing `catch (err) { ... err.message }` blocks already handle.
axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS) || 10000;

const db     = require('./db');

// ─── Modules ─────────────────────────────────────────────────────────────────
const antiscam   = require('./modules/antiscam');
const support    = require('./modules/support');
const { startAuthServer, handle2FAInteraction } = require('./modules/auth2fa');
const { getAllProducts, getProduct, setProductUrl, getProductChunks, getProductByName, refresh: dlRefresh } = require('./modules/downloads');
const { handleWebTicketButton, handleWebTicketModal } = require('./modules/webTickets');
const { commands: smsCommands, handleSMSInteraction, setSMSAccessGate, setSmsSettingsProvider, setSmsChannelFinder } = require('./modules/sms-gen');
const { logGeneration, setGenLogSettingsProvider } = require('./modules/genLog');
const {
  commands: manualCommands, handleManualInteraction, setManualAccessGate,
  setManualSettingsProvider,
} = require('./modules/manualDelivery');
const {
  commands: storefrontCommands, handleStorefrontCommand, handleStorefrontButton, setStorefrontGate,
  buildWebsitePanel, storeConfig: storefrontConfig, upsertPanel, MARK_SITE,
} = require('./modules/storefrontPanels');
const {
  commands: productInfoCommands, handleProductInfoCommand, handleProductInfoSelect,
  handleProductInfoButton, setProductInfoGate,
} = require('./modules/productInfo');
const {
  commands: communityCommands, handleCommunityCommand, handleCommunityButton,
  handleCommunityModal, setCommunityGate,
  MARK_GIVEAWAY, MARK_GW_ENTRY, MARK_GW_RESULTS,
} = require('./modules/communityPanels');
const translate = require('./modules/translate');
// Only for the language dropdown: it reads a delivery DM back off the
// interaction and names the catalogue strings in it, which the translator must
// not touch. See the dispatch site.
const { protectFromEmbed } = require('./modules/deliveryEmbed');
const { offerImageUpload } = require('./modules/imageAttach');
// Turns a pasted body into something that renders: headings that work behind a
// bullet, `[url](url)` unwrapped, and the link echoed into plain content so
// Discord draws the preview card an embed never gets on its own.
const { formatNotes, normalizeMarkdown, withPreview, fitsField, clampDescription } = require('./modules/richText');
const { makeStaffRoleResolver } = require('./modules/staffRoles');
const serverBackup = require('./modules/serverBackup');
const mirror = require('./modules/mirror');
const counting = require('./modules/counting');

// ─── Mirror relay state ───────────────────────────────────────────────────────
// Three pieces of memory, all of them there to stop a loop or a stampede.
//
// mirrorRoutes  — src_channel_id → route rows. Rebuilt on write, not per
//                 message: the lookup happens on EVERY message in every guild,
//                 and a database round trip on that path turns a busy server
//                 into a permanent query load for a feature nobody may be
//                 using. A null cache means "not loaded yet", not "no routes".
// mirrorPosted  — ids this bot posted as a mirror, so the fallback path (which
//                 posts as the bot rather than through a webhook, and so has
//                 no webhookId to recognise it by) cannot feed itself.
// mirrorWebhooks— ids of the webhooks we relay THROUGH, so a mirror arriving
//                 in the destination is never mistaken for a new post.
let mirrorRoutes = null;
const mirrorPosted = mirror.makeRecentSet(2000);
const mirrorWebhookIds = new Set();

async function loadMirrorRoutes(force = false) {
  if (mirrorRoutes && !force) return mirrorRoutes;
  const next = new Map();
  try {
    const { rows } = await db.query('SELECT * FROM mirror_routes WHERE enabled ORDER BY id');
    for (const r of rows) {
      if (!next.has(r.src_channel_id)) next.set(r.src_channel_id, []);
      next.get(r.src_channel_id).push(r);
      if (r.webhook_id) mirrorWebhookIds.add(r.webhook_id);
    }
  } catch (e) {
    // Leave the previous cache in place. A Supabase blip should degrade to
    // "mirroring with the routes we already knew about", not to every message
    // in the server hitting an empty map and quietly stopping.
    console.error('[mirror] could not load routes:', e.message);
    return mirrorRoutes || next;
  }
  mirrorRoutes = next;
  return mirrorRoutes;
}

// Resolved webhook objects, by destination channel id. Fetching webhooks is a
// rate-limited call and this runs per mirrored message, so it happens once per
// channel per process life.
const mirrorWebhookCache = new Map();
const MIRROR_WEBHOOK_NAME = 'UH Mirror';

/**
 * The webhook to relay through, creating it if this is the first message down
 * this route. Returns null when the bot cannot have one — no Manage Webhooks
 * in the destination, or a channel type that does not take them — and the
 * caller falls back to posting as itself. The fallback loses the source
 * server's name and icon, which is cosmetic; posting nothing is not.
 */
async function mirrorWebhookFor(route, dstChannel) {
  const key = dstChannel.id;
  if (mirrorWebhookCache.has(key)) return mirrorWebhookCache.get(key);

  // A thread cannot own a webhook — its parent does, and the send carries a
  // threadId to say which thread inside it.
  const holder = typeof dstChannel.isThread === 'function' && dstChannel.isThread()
    ? dstChannel.parent : dstChannel;
  if (!holder || typeof holder.fetchWebhooks !== 'function') {
    mirrorWebhookCache.set(key, null);
    return null;
  }

  try {
    const hooks = await holder.fetchWebhooks();
    let hook = route.webhook_id ? hooks.get(route.webhook_id) : null;
    // Match on OUR webhook by name as well as by stored id: a route added
    // before the id column was filled, or a webhook deleted and the row left
    // behind, should reuse rather than pile up a second one on every restart.
    if (!hook) {
      hook = hooks.find(w => w.name === MIRROR_WEBHOOK_NAME
        && w.owner && w.owner.id === client.user.id) || null;
    }
    if (!hook) hook = await holder.createWebhook({ name: MIRROR_WEBHOOK_NAME, reason: 'Cross-server mirror' });

    if (hook && hook.id !== route.webhook_id) {
      route.webhook_id = hook.id;
      db.query('UPDATE mirror_routes SET webhook_id = $1 WHERE id = $2', [hook.id, route.id])
        .catch(e => console.error('[mirror] could not save webhook id:', e.message));
    }
    if (hook) mirrorWebhookIds.add(hook.id);
    mirrorWebhookCache.set(key, hook);
    return hook;
  } catch (e) {
    console.error(`[mirror] no webhook for ${dstChannel.id}: ${e.message}`);
    mirrorWebhookCache.set(key, null);   // don't retry per message
    return null;
  }
}

// The flood budget, shared by every route. See modules/mirror.js for why there
// are two scopes; this is just where the counters live.
const mirrorRate = mirror.makeRateWindow();

// Route ids currently being paused. A flood arrives faster than one round trip
// to Postgres and two channel sends, so without this the first burst posts the
// same pause notice a dozen times in both servers — which is itself a flood,
// delivered by the thing that was supposed to stop one.
const mirrorPausing = new Set();

/**
 * Stop a route and say why, in the destination and in the source.
 *
 * Both ends get told because they are different people with different
 * problems: the destination needs to know an inbound feed was cut and does not
 * need chasing, and the source needs to know its posts stopped arriving. A
 * pause that only one end can see is how this ends up looking like the bot
 * quietly broke.
 */
async function pauseMirrorRoute(route, reason, opts = {}) {
  if (mirrorPausing.has(route.id)) return;
  mirrorPausing.add(route.id);
  try {
    await db.query(
      `UPDATE mirror_routes SET enabled = false, paused_reason = $2, paused_at = now() WHERE id = $1`,
      [route.id, reason.slice(0, 500)]);
  } catch (e) {
    console.error(`[mirror] could not record the pause of route ${route.id}:`, e.message);
  }
  console.warn(`[mirror] route ${route.id} PAUSED — ${reason}`);
  await loadMirrorRoutes(true);
  mirrorRate.clear(`r:${route.id}`);

  const note = (where) => `⛔ **Mirror paused** — route \`#${route.id}\`\n` +
    `${reason}\n\n` +
    (where === 'dst'
      ? `Nothing further from <#${route.src_channel_id}> will arrive here until an admin of this server runs \`/mirror resume id:${route.id}\`.\n` +
        `If this was not something you expect, \`/mirror block guild_id:${route.src_guild_id}\` stops it being re-added at all.`
      : `Posts from <#${route.src_channel_id}> have stopped arriving in the other server. An admin at either end can run \`/mirror resume id:${route.id}\`.`);

  for (const [end, channelId] of [['dst', route.dst_channel_id], ['src', route.src_channel_id]]) {
    if (opts.skip === end) continue;
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch && typeof ch.send === 'function') {
        await ch.send({ content: note(end), allowedMentions: { parse: [] } });
      }
    } catch (e) {
      console.error(`[mirror] could not announce the pause in ${channelId}:`, e.message);
    }
  }
  // Kept for a minute, not cleared here: the flood is still arriving, and the
  // routes map has already been reloaded without this route, so a second pause
  // could only come from a message that was mid-flight.
  setTimeout(() => mirrorPausing.delete(route.id), 60000).unref?.();
}

/**
 * Relay one message down every route out of its channel.
 *
 * Each route is attempted independently. A destination the bot has been kicked
 * from must not stop a message reaching the three destinations that are still
 * fine — and this is the hot path for every message in every guild, so
 * nothing in here is allowed to throw.
 */
async function relayMessage(message) {
  const routes = (await loadMirrorRoutes()).get(message.channel.id);
  if (!routes || !routes.length) return;

  const ctx = { mirrorWebhookIds, postedByMirror: mirrorPosted, selfId: client.user && client.user.id };
  const srcGuild = message.guild;
  const now = Date.now();

  for (const route of routes) {
    const verdict = mirror.shouldMirror(message, {
      botOnly: route.bot_only !== false,
      includeOtherBots: !!route.include_other_bots,
    }, ctx);
    if (!verdict.ok) continue;

    // The budget is spent only on messages that were actually going to be
    // relayed. Charging it before shouldMirror would let ordinary chatter in a
    // bot-only channel trip a limit that no post ever came near.
    const rate = mirror.checkRate(mirrorRate, route, now);
    if (!rate.ok) {
      // Pausing is deliberate rather than dropping the overflow. Silently
      // discarding messages leaves a route that looks fine and is lying; a
      // stopped route with a reason attached is something a person can act on.
      await pauseMirrorRoute(route, rate.reason).catch(e => console.error('[mirror] pause failed:', e.message));
      continue;
    }

    try {
      const dst = await client.channels.fetch(route.dst_channel_id).catch(() => null);
      if (!dst) { console.error(`[mirror] route ${route.id}: destination channel is gone`); continue; }

      const payload = mirror.buildMirrorPayload(message, {
        allowPings: !!route.allow_pings,
        username: srcGuild ? srcGuild.name : undefined,
        avatarURL: srcGuild && typeof srcGuild.iconURL === 'function' ? srcGuild.iconURL({ size: 128 }) : undefined,
      });

      const hook = await mirrorWebhookFor(route, dst);
      let sent;
      if (hook) {
        const threadId = typeof dst.isThread === 'function' && dst.isThread() ? dst.id : undefined;
        sent = await hook.send({ ...payload, ...(threadId ? { threadId } : {}) });
      } else {
        sent = await dst.send(mirror.toChannelPayload(payload));
      }

      // Before anything else can observe it. Without a webhook this message
      // was posted by the bot itself, and if the destination is also a source
      // its own messageCreate is already on its way here.
      if (sent && sent.id) {
        mirrorPosted.add(sent.id);
        db.query(
          `INSERT INTO mirror_messages (src_message_id, route_id, dst_message_id)
           VALUES ($1, $2, $3) ON CONFLICT (src_message_id, route_id) DO NOTHING`,
          [message.id, route.id, sent.id])
          .catch(e => console.error('[mirror] could not record copy:', e.message));
      }
    } catch (e) {
      // The commonest cause is a file: an attachment over the destination's
      // upload limit rejects the whole message. A mirrored post without its
      // image still says what happened; no post at all says nothing.
      console.error(`[mirror] route ${route.id} failed: ${e.message}`);
      try {
        const dst = await client.channels.fetch(route.dst_channel_id).catch(() => null);
        if (!dst) continue;
        const bare = mirror.toChannelPayload(mirror.buildMirrorPayload(message, { allowPings: !!route.allow_pings }));
        delete bare.files;
        if (!bare.content && !bare.embeds.length) continue;
        const sent = await dst.send(bare);
        if (sent && sent.id) mirrorPosted.add(sent.id);
      } catch (e2) {
        console.error(`[mirror] route ${route.id} fallback also failed: ${e2.message}`);
      }
    }
  }
}

/**
 * An edit in the source follows into every copy. Without this a corrected post
 * stays wrong in the other server — which is worse than never mirroring it,
 * because the second server is then reading something the first has retracted.
 */
async function relayEdit(message) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT m.dst_message_id, r.* FROM mirror_messages m
         JOIN mirror_routes r ON r.id = m.route_id
        WHERE m.src_message_id = $1`, [message.id]));
  } catch (e) { console.error('[mirror] edit lookup failed:', e.message); return; }
  if (!rows.length) return;

  for (const row of rows) {
    try {
      const dst = await client.channels.fetch(row.dst_channel_id).catch(() => null);
      if (!dst) continue;
      const payload = mirror.buildMirrorPayload(message, { allowPings: !!row.allow_pings });
      // Files are not re-sent on an edit: the copy already carries them, and
      // Discord would treat the edit as a fresh attachment list and duplicate
      // every one of them.
      delete payload.files;
      const hook = mirrorWebhookCache.get(dst.id);
      if (hook) {
        const threadId = typeof dst.isThread === 'function' && dst.isThread() ? dst.id : undefined;
        await hook.editMessage(row.dst_message_id, { ...mirror.toChannelPayload(payload), ...(threadId ? { threadId } : {}) });
      } else {
        const m = await dst.messages.fetch(row.dst_message_id).catch(() => null);
        if (m) await m.edit(mirror.toChannelPayload(payload));
      }
    } catch (e) { console.error(`[mirror] could not follow edit on route ${row.id}: ${e.message}`); }
  }
}

/** A deleted post is retracted everywhere it was copied to. */
async function relayDelete(message) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT m.dst_message_id, r.dst_channel_id, r.id FROM mirror_messages m
         JOIN mirror_routes r ON r.id = m.route_id
        WHERE m.src_message_id = $1`, [message.id]));
  } catch (e) { console.error('[mirror] delete lookup failed:', e.message); return; }
  if (!rows.length) return;

  for (const row of rows) {
    try {
      const dst = await client.channels.fetch(row.dst_channel_id).catch(() => null);
      if (!dst) continue;
      const m = await dst.messages.fetch(row.dst_message_id).catch(() => null);
      if (m) await m.delete();
    } catch (e) { console.error(`[mirror] could not follow delete on route ${row.id}: ${e.message}`); }
  }
  db.query('DELETE FROM mirror_messages WHERE src_message_id = $1', [message.id]).catch(() => {});
}

// Appends the language dropdown to a post. Every caller is a message the whole
// server reads, which is why the dropdown answers EPHEMERALLY — see
// modules/translate.js. Five action rows is a hard Discord limit and exceeding
// it rejects the whole message, so a post that already uses all five keeps its
// buttons and goes without the dropdown rather than failing to send at all.
function withLanguageRow(payload) {
  const components = [...(payload.components || [])];
  if (components.length >= 5) return payload;
  components.push(translate.languageRow());
  return { ...payload, components };
}

// ─── ENV Config ───────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const GUILD_ID       = process.env.GUILD_ID || null;

// Shop payment backend (ported from p-bot) — the payment API is a separate
// Railway service; these commands just proxy to it over HTTP.
const BACKEND_URL    = process.env.BACKEND_URL || 'http://localhost:3000';
const API_SECRET     = process.env.API_SECRET;

// Verify/Welcome module — these are now the FALLBACK defaults only, used
// when a guild has no row in guild_settings yet (see getGuildSettings()
// below). Your original server keeps behaving exactly as before.
//
// The literal snowflakes below are this store's own channels. They are only
// ever reached when `isOriginal` is true (guildId === GUILD_ID), so a second
// install can never post customer data into them — but they were not
// overridable either, which meant moving a channel required a code change.
// Env var first now, literal as the last resort.
const VERIFIED_ROLE_ENV  = process.env.VERIFIED_ROLE_NAME  || 'Verified';
const VERIFY_CHANNEL_ENV = process.env.VERIFY_CHANNEL_NAME || 'get-verify';
const WELCOME_CHANNEL_ENV= process.env.WELCOME_CHANNEL_NAME|| 'welcome';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1400773021274341396';
// TWO channels, not one. They were the same setting until now, and a previous
// round guessed the wrong one of the pair: the reward panel has been landing in
// #invite-tracker, which is the log.
//
//   #invites       — the reward panel. One pinned post with three buttons, in a
//                    channel members are meant to read.
//   #invite-tracker— "X was invited by Y", "X left". One line per join, forever.
//
// Putting the panel in the log buried it under the log. Putting the log in
// #invites turns a panel channel into a firehose — which is what a second
// server saw, because it had neither ID set and both fell back to the name
// "invites".
const INVITES_CHANNEL_ID = process.env.INVITES_CHANNEL_ID || '1482585544998256781';
const INVITES_CHANNEL_ENV= process.env.INVITES_CHANNEL_NAME|| 'invites';
const INVITE_LOG_CHANNEL_ID = process.env.INVITE_LOG_CHANNEL_ID || '1400878017667923968';
const INVITE_LOG_CHANNEL_ENV= process.env.INVITE_LOG_CHANNEL_NAME|| 'invite-tracker';
const INVITES_NEEDED_ENV = parseInt(process.env.INVITES_NEEDED || '10');

// Updates module
const BOT_NAME  = process.env.BOT_NAME  || 'UH Services';
const SITE_URL  = process.env.SITE_URL  || '';
// The store address, guaranteed non-empty and scheme-qualified. SITE_URL is
// allowed to be blank above (the footer just prints nothing), but a Link button
// with a blank URL REJECTS THE WHOLE MESSAGE, so anything that becomes a button
// goes through this one instead.
const STORE_URL = (process.env.SITE_URL || 'https://uhservices.xyz').replace(/\/+$/, '');
const DOWNLOADS_URL = `${STORE_URL}/downloads`;
// #downloads held two bot posts — a bare @everyone link, and the product
// dropdowns — and the ask was to make them one. The marker is what lets the
// command find and EDIT the merged panel instead of adding a third.
const MARK_DOWNLOADS = 'panel:downloads';

// Vouch module — env-overridable, same reasoning as the channels above.
const LEAVE_VOUCH_CHANNEL_ID = process.env.LEAVE_VOUCH_CHANNEL_ID || '1522983274417360896'; // #leave-vouch — panel lives here
const VOUCHES_CHANNEL_ID     = process.env.VOUCHES_CHANNEL_ID     || '1242134878263447552'; // #vouches — results get posted here

// Counting game module
const COUNTING_CHANNEL_ID = process.env.COUNTING_CHANNEL_ID || '1484663384443064510'; // #counting-game

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in environment variables!');
  process.exit(1);
}

// ─── Startup environment check ───────────────────────────────────────────────
// Only TOKEN and CLIENT_ID were checked, so the bot booted green and looked
// healthy while whole subsystems were silently dead: no API_SECRET meant every
// call to the payment backend came back 401 and was swallowed; no
// ORDER_LOG_CHANNEL_ID meant the order feed posted nowhere (the bug that
// prompted this audit). Fail loudly for the ones nothing works without, and
// warn clearly for the ones that disable a feature.
(function checkEnvironment() {
  const required = { API_SECRET: 'the payment backend rejects every call from this bot', GUILD_ID: 'per-guild lookups resolve to nothing' };
  const recommended = {
    ORDER_LOG_CHANNEL_ID: 'new orders and deliveries will NOT be posted to Discord',
    ALERTS_CHANNEL_ID: 'ops alerts (watcher failures, unmatched payments) will fall into the order log instead of their own channel',
    BACKEND_URL: 'defaults to localhost — backend calls will fail on Railway',
    OWNER_DISCORD_ID: 'owner-only commands fall back to Administrator only',
    STAFF_ROLE_ID: 'staff access falls back to matching a role NAMED "MODERATOR"',
    DATABASE_URL: 'settings, tickets and vouches cannot be read or written',
    DATA_DIR: 'state is written to the container and lost on every deploy',
  };

  const missingRequired = Object.keys(required).filter(k => !process.env[k]);
  const missingRecommended = Object.keys(recommended).filter(k => !process.env[k]);

  for (const k of missingRequired) console.error(`❌ Missing ${k} — ${required[k]}`);
  for (const k of missingRecommended) console.warn(`⚠  Missing ${k} — ${recommended[k]}`);

  if (missingRequired.length) {
    console.error('❌ Refusing to start with the above missing. Set them on the Railway service.');
    process.exit(1);
  }
  if (!missingRecommended.length) console.log('✅ Environment check passed.');
})();

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
  // GuildMember partial: without it, a GUILD_MEMBER_REMOVE for a member who is
  // not in the cache is dropped entirely, and the invite tracker never learns
  // they left. Every consumer below already handles a partial member.
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
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

// Drawing the winners, retiring the entry card and posting the results used to
// be written out three times — in /giveaway's own timer, and twice more in the
// restart path that re-arms timers the process lost. Three copies of one flow
// drift, and round 38 needed the SAME change in all three (the marker in the
// footer, without which the next giveaway cannot find the old one to clear it),
// which is the point at which three copies stop being tolerable.
async function endGiveaway(msgId, why = 'timer') {
  const gw = giveaways.get(msgId);
  if (!gw || gw.ended) return;
  gw.ended = true;
  saveGiveaways();

  const participants = [...gw.participants];
  const winners = pickWinners(participants, gw.winnerCount || 1);
  const winnersText = winners.length ? winners.map(w => `<@${w}>`).join(', ') : null;

  try {
    const gwCh = await client.channels.fetch(gw.channelId);
    const endedEmbed = new EmbedBuilder()
      .setColor(0x95A5A6)
      .setAuthor({ name: BOT_NAME, iconURL: client.user.displayAvatarURL() })
      .setTitle(`🎁 ${gw.prize} [ENDED]`)
      .setDescription(`This giveaway has ended!\n\n**${winners.length > 1 ? 'Winners' : 'Winner'}:** ${winnersText || 'No participants'}`)
      .setThumbnail(client.user.displayAvatarURL())
      // The marker has to survive being ended. This footer REPLACES the one the
      // entry card was posted with, so leaving it off would hide the finished
      // giveaway from the sweep that is supposed to clear it next time.
      .setFooter({ text: `Ended on ${new Date(gw.endsAt).toUTCString()} • ${MARK_GW_ENTRY}`, iconURL: client.user.displayAvatarURL() });
    if (gw.imageUrl) endedEmbed.setImage(gw.imageUrl);
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${participants.length})`).setStyle(ButtonStyle.Primary).setDisabled(true),
    );
    try {
      const gwMsg = await gwCh.messages.fetch(msgId);
      await gwMsg.edit(withLanguageRow({ embeds: [endedEmbed], components: [disabledRow] }));
    } catch (e) {
      // Somebody deleted the entry card. The draw still happened, so the
      // results still go out — silently swallowing them would lose the winners.
      console.warn(`[Giveaway] entry card ${msgId} is gone (${e.message}) — posting results anyway`);
    }

    const resultsEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle(`🎁 ${gw.prize} [RESULTS]`)
      .setDescription(`The ${winners.length > 1 ? 'winners are' : 'winner is'} tagged above! Congratulations 🎉`)
      .addFields(
        { name: 'Prize', value: gw.prize, inline: false },
        { name: 'Winners', value: `${winners.length}`, inline: false },
        { name: 'Participants', value: `${participants.length}`, inline: false },
      )
      .setFooter({ text: `${BOT_NAME} | ${SITE_URL} • ${MARK_GW_RESULTS}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await gwCh.send(withLanguageRow({ content: winnersText || '❌ No participants — no winner.', embeds: [resultsEmbed] }));
  } catch (e) { console.error(`Giveaway end error (${why}):`, e); }
}

// "when a giveaway is done, make sure next time giveaway is done it clears the
// old giveaway + giveaway results. Leaving just the ./Setup-Giveaway alone."
//
// Narrow on purpose. It removes only messages the bot itself posted that carry
// one of the two DISPOSABLE giveaway markers. The standing panel is
// `panel:giveaway` and neither marker is a substring of it, which is the whole
// reason the markers are named the way they are — `giveaway:entry` under a
// `includes('panel:giveaway')` test would have made this delete the panel.
async function clearOldGiveaway(channel) {
  const removed = [];
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    for (const m of recent.values()) {
      if (m.author.id !== client.user.id) continue;
      const footers = m.embeds.map(e => (e.footer && e.footer.text) || '');
      if (!footers.some(f => f.includes(MARK_GW_ENTRY) || f.includes(MARK_GW_RESULTS))) continue;
      if (footers.some(f => f.includes(MARK_GIVEAWAY))) continue;   // never the panel
      try { await m.delete(); removed.push(m.id); giveaways.delete(m.id); }
      catch (e) { console.warn('[Giveaway] could not remove an old post:', e.message); }
    }
    if (removed.length) saveGiveaways();
  } catch (e) { console.warn('[Giveaway] could not scan for old posts:', e.message); }
  return removed;
}

function saveVouches() {
  const obj = {};
  for (const [gid, v] of vouchData) obj[gid] = v;
  saveJSON(VOUCHES_FILE, obj);
}

// A vouch left in Discord is also a review of the store, so it belongs on the
// storefront next to the ones left there — and, more importantly, in Postgres.
// vouches.json lives on the container filesystem: DATA_DIR defaults to the
// bot's own directory, which Railway rebuilds on every deploy, so the JSON file
// is a cache, not a record. Pushing each vouch to the backend puts the durable
// copy in the same database as everything else, which is what makes
// `/importvouches source:website` able to rebuild a brand-new server.
//
// Fire-and-forget on purpose: the member has already been thanked and the embed
// already posted, so a backend hiccup must not surface as a failed vouch.
// external_id is the vouch message's own snowflake where there is one, so a
// retry — or a redeploy that replays nothing — cannot double-post it.
async function syncVouchToWebsite(guildId, entry, externalId) {
  if (!API_SECRET) return;
  try {
    await axios.post(`${BACKEND_URL}/api/reviews/bot`, {
      secret: API_SECRET,
      guild_id: guildId,
      display_name: entry.username || 'Anonymous',
      rating: entry.rating,
      body: entry.feedback || null,
      discord_id: entry.userId || null,
      // Rendered by the storefront as cdn.discordapp.com/avatars/<id>/<hash>.
      // Sent as the hash and not as a downloaded copy: an avatar url is
      // unsigned and stable (unlike the attachment url below), so it tracks
      // the member instead of freezing them at the day they vouched.
      avatar_hash: entry.avatarHash || null,
      external_id: String(externalId || `${guildId}:${entry.id}:${entry.timestamp}`),
      // The screenshot is the half of a vouch people actually believe, so it
      // has to travel with it. Sent as a URL and downloaded on the other side:
      // Discord's attachment links are signed and expire within a day, so the
      // storefront keeps its own copy of the bytes rather than the link.
      //
      // This is also why the call is repeated after a late upload — the image
      // normally lands a few seconds AFTER the vouch, so the first sync has
      // nothing to send. The backend matches on external_id and fills in the
      // picture it was missing.
      image_url: entry.imageUrl || null,
    }, { timeout: 20000 });
  } catch (e) {
    console.error('[Vouch] website sync failed:', e.response?.data?.error || e.message);
  }
}

// vouches: { [guildId]: { count, channelId, entries: [{id, userId, username, rating, feedback, imageUrl, timestamp}] } }
const vouchDataRaw = loadJSON(VOUCHES_FILE, {});
const vouchData    = new Map(Object.entries(vouchDataRaw).map(([gid, v]) => [gid, { count: v.count || 0, channelId: v.channelId || null, entries: v.entries || [] }]));

// ─── Counting game ──────────────────────────────────────────────────────────
// "ANOTHER RESET FOR A CORRECT ANSWER" — twice now, and not once because of the
// evaluator. The count lived in counting.json under DATA_DIR, which defaults to
// the directory the bot runs from: INSIDE THE CONTAINER. Every deploy built a
// fresh one, the file was not in it, the count silently went back to 0 — and
// the next person to type the right number was told they had "posted 419
// instead of 1" and lost a streak nobody had broken. The high score went with
// it, so there was not even a record of what had been lost.
//
// So Postgres is the truth and the file is a local cache of it. `config` is the
// guild-scoped key/value table that already exists, which is why this needs no
// migration; a guild with no row there is simply a channel that has not counted
// yet.
const COUNTING_FILE = path.join(DATA_DIR, 'counting.json');
// counting: { [guildId]: { count, lastUserId, highScore } }
const countingDataRaw = loadJSON(COUNTING_FILE, {});
const countingData    = new Map(Object.entries(countingDataRaw));
// False until Postgres has answered. While it is false the game does not
// PUNISH anyone: a reset decided against a count we could not read is exactly
// the bug above, and refusing to judge is the harmless half of being wrong.
let countingTruthKnown = false;

function saveCounting(gid) {
  const obj = {};
  for (const [gid_, c] of countingData) obj[gid_] = c;
  saveJSON(COUNTING_FILE, obj);
  if (gid) persistCounting(gid);
}

// Write-through, not awaited: the ✅ on the message must not wait for a round
// trip, and a failed write is recoverable — the next correct count rewrites it.
function persistCounting(gid) {
  const c = countingData.get(String(gid));
  if (!c) return;
  db.query(
    `INSERT INTO config (guild_id, key, value, updated_at) VALUES ($1, 'COUNTING_STATE', $2, now())
     ON CONFLICT (guild_id, key) DO UPDATE SET value = $2, updated_at = now()`,
    [String(gid), JSON.stringify(c)]
  ).catch(e => console.warn(`[Counting] could not save the count for ${gid}:`, e.message));
}

async function loadCountingFromDb() {
  try {
    const { rows } = await db.query(`SELECT guild_id, value FROM config WHERE key = 'COUNTING_STATE'`);
    for (const r of rows) {
      try {
        const c = JSON.parse(r.value);
        // Postgres wins over the file. The file is whatever this container was
        // built with, which is nothing at all after a deploy.
        if (c && Number.isFinite(Number(c.count))) countingData.set(String(r.guild_id), c);
      } catch (_) { /* a corrupt row is not worth taking the boot down for */ }
    }
    countingTruthKnown = true;
    console.log(`[Counting] loaded ${rows.length} guild(s) from Postgres`);
  } catch (e) {
    console.error('[Counting] could not read the saved count — the game will not reset anyone until it can:', e.message);
  }
}

// ─── Steam account stock — migrated to Postgres, guild-scoped ─────────────
const STOCK_COOLDOWN_HOURS = parseInt(process.env.STOCK_COOLDOWN_HOURS || '24');

async function getStockTypes(guildId) {
  const { rows } = await db.query(
    'SELECT type, COUNT(*)::int AS count FROM stock WHERE guild_id = $1 GROUP BY type ORDER BY type ASC',
    [guildId]
  );
  return rows; // [{type, count}]
}

async function getStockCount(guildId, type) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM stock WHERE guild_id = $1 AND type = $2', [guildId, type]);
  return rows[0].n;
}

async function addStockAccounts(guildId, type, lines) {
  await db.ensureGuild(guildId);
  for (const line of lines) {
    await db.query('INSERT INTO stock (guild_id, type, account_data) VALUES ($1,$2,$3)', [guildId, type, line]);
  }
}

// Atomically claims and removes one account — FOR UPDATE SKIP LOCKED means
// two people claiming at the exact same moment can never get the same row,
// even under concurrent requests.
async function claimOneStockAccount(guildId, type) {
  const { rows } = await db.query(
    `DELETE FROM stock WHERE id = (
       SELECT id FROM stock WHERE guild_id = $1 AND type = $2 ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING account_data`,
    [guildId, type]
  );
  return rows.length ? rows[0].account_data : null;
}

async function clearStockDB(guildId, type) {
  if (type) {
    const { rowCount } = await db.query('DELETE FROM stock WHERE guild_id = $1 AND type = $2', [guildId, type]);
    return { removed: rowCount, types: rowCount ? 1 : 0 };
  }
  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS n FROM stock WHERE guild_id = $1', [guildId]);
  const { rows: typeRows }  = await db.query('SELECT COUNT(DISTINCT type)::int AS n FROM stock WHERE guild_id = $1', [guildId]);
  await db.query('DELETE FROM stock WHERE guild_id = $1', [guildId]);
  return { removed: countRows[0].n, types: typeRows[0].n };
}

async function getStockCooldown(guildId, userId, type) {
  const { rows } = await db.query(
    'SELECT last_claimed_at FROM stock_cooldowns WHERE guild_id = $1 AND user_id = $2 AND type = $3',
    [guildId, userId, type]
  );
  return rows.length ? rows[0].last_claimed_at : null;
}

async function setStockCooldown(guildId, userId, type) {
  await db.ensureGuild(guildId);
  await db.query(
    `INSERT INTO stock_cooldowns (guild_id, user_id, type, last_claimed_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (guild_id, user_id, type) DO UPDATE SET last_claimed_at = now()`,
    [guildId, userId, type]
  );
}

// Used when a claim is stamped optimistically and then fails — see the SMS gen
// purchase path, which reserves the day's number before spending credit.
async function clearStockCooldown(guildId, userId, type) {
  await db.query(
    'DELETE FROM stock_cooldowns WHERE guild_id = $1 AND user_id = $2 AND type = $3',
    [guildId, userId, type]
  );
}

// SMS gen borrows the Steam gen's access rules — 💎 Gen Member to use it, one
// number per day, staff/OVERSEER unlimited — instead of keeping a second
// definition of who counts as staff, which is how a gate ends up open on one
// command and shut on another. Installed at load, not in ready(): sms-gen
// refuses every request until this runs, so it must not be able to run late.
// Manual delivery borrows hasAccess() for the same reason — it is the staff
// gate the rest of the bot already uses, and every entry point of that flow
// (command, select menu, modal) is checked against it.
setManualAccessGate({ hasAccess: (i) => hasAccess(i) });
// Same gate for the storefront panels. Posting one rewrites a channel every
// member reads, so it is staff-only for the same reason /post-tos is.
setStorefrontGate({ hasAccess: (i) => hasAccess(i) });
// And the #live-stream / #post-your-clips panels, for the same reason —
// /golive posts an @everyone announcement, which is not a thing a member gets
// to do.
setCommunityGate({ hasAccess: (i) => hasAccess(i) });
// /product-info is public — looking a price up is what customers are here for.
// The gate covers only its `channel:` option, which posts a panel into a room
// everybody reads.
setProductInfoGate({ hasAccess: (i) => hasAccess(i) });

setSMSAccessGate({
  canAccess:     canAccessStock,
  hasUnlimited:  hasUnlimitedGen,
  getCooldown:   getStockCooldown,
  setCooldown:   setStockCooldown,
  clearCooldown: clearStockCooldown,
});

// Useful links — persisted to DATA_DIR so /addusefullink and /removeusefullink
// changes survive restarts, same as stock/giveaways/vouches. Seeded once from
// the list below the first time the bot runs; after that, the file is the
// source of truth and this array is only used if the file doesn't exist yet.
// ─── Useful links — migrated to Postgres (Phase 1), guild-scoped ──────────
// One row per link, one guild's links never visible to another guild.
// Seed data only used the very first time a guild's list is empty AND it's
// your original GUILD_ID (so your existing 11 links aren't lost after the
// migrate.js run, but a brand-new server installing the bot starts empty).
const USEFUL_LINKS_SEED = [
  { label: 'Windows 11 25H2 Download',                            url: 'https://www.microsoft.com/en-us/software-download/windows11' },
  { label: 'Cleaning all partitions',                              url: 'https://youtu.be/FWUpRMqFcu4?is=OMPSQ7TUFKJk2f6U' },
  { label: 'Visual C++ Redistributable Runtimes All-in-One Jun 2026', url: 'https://www.techpowerup.com/download/visual-c-redistributable-runtime-package-all-in-one/?amp' },
  { label: 'DirectX',                                              url: 'https://www.microsoft.com/en-us/download/details.aspx?id=35' },
  { label: 'REQUIREMENTS',                                         url: 'https://pixeldrain.com/u/DSuyQNiK' },
  { label: 'UH Support Tool',                                      url: 'https://pixeldrain.com/u/qa6qTrVS' },
  { label: 'IObit Driver Booster',                                 url: 'https://pixeldrain.com/u/qyHWKWVt' },
  { label: 'Revo Uninstaller Pro',                                 url: 'https://pixeldrain.com/u/NZVsEdZQ' },
  { label: 'reWASD',                                                url: 'https://pixeldrain.com/u/tii1QT1h' },
  { label: 'Bypass the online Microsoft account requirement during Windows 11 setup', url: 'https://i.imgur.com/1gBBI7f.png' },
  { label: 'Cloudflare WARP 1.1.1.1',                              url: 'https://one.one.one.one/' },
];

async function getUsefulLinks(guildId) {
  const { rows } = await db.query(
    'SELECT id, label, url FROM useful_links WHERE guild_id = $1 ORDER BY sort_order ASC, id ASC',
    [guildId]
  );
  return rows;
}

async function addUsefulLink(guildId, label, url) {
  await db.ensureGuild(guildId);
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM useful_links WHERE guild_id = $1',
    [guildId]
  );
  await db.query(
    'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
    [guildId, label, url, rows[0].next]
  );
}

// Returns the removed {label,url} row, or null if the number was out of range.
async function removeUsefulLinkByNumber(guildId, number) {
  const links = await getUsefulLinks(guildId);
  const index = number - 1;
  if (index < 0 || index >= links.length) return null;
  const target = links[index];
  await db.query('DELETE FROM useful_links WHERE id = $1', [target.id]);
  return target;
}

async function clearUsefulLinks(guildId) {
  const { rowCount } = await db.query('DELETE FROM useful_links WHERE guild_id = $1', [guildId]);
  return rowCount;
}

async function bulkInsertUsefulLinks(guildId, parsedLinks, mode) {
  await db.ensureGuild(guildId);
  if (mode === 'replace') {
    await db.query('DELETE FROM useful_links WHERE guild_id = $1', [guildId]);
  }
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS max FROM useful_links WHERE guild_id = $1',
    [guildId]
  );
  let nextOrder = rows[0].max + 1;
  for (const link of parsedLinks) {
    await db.query(
      'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
      [guildId, link.label, link.url, nextOrder++]
    );
  }
}

// Parses bulk-pasted/uploaded lines like:
//   Windows 11 25H2 Download - https://www.microsoft.com/en-us/software-download/windows11
//   * REQUIREMENTS - https://pixeldrain.com/u/DSuyQNiK
// Strips common leading bullets/numbering, splits on the last " - " before
// the URL. Returns { parsed: [{label,url}], skipped: [rawLine] } so callers
// can report anything that didn't match instead of silently dropping it.
function parseUsefulLinksBulk(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parsed = [];
  const skipped = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[\*\-•]\s*/, '').replace(/^\d+[.)]\s*/, '');
    const m = line.match(/^(.*?)\s*-\s*(https?:\/\/\S+)\s*$/);
    if (m && m[1].trim() && m[2].trim()) {
      parsed.push({ label: m[1].trim(), url: m[2].trim() });
    } else {
      skipped.push(rawLine);
    }
  }
  return { parsed, skipped };
}

// ─── TOS / Rules / Guide — staff-editable content, one per guild per key ───
// CONTENT_TYPES and the renderer live in modules/contentRender.js because the
// web panel renders the same documents. Two copies would diverge on the first
// change, and the panel's preview would then promise a layout Discord does not
// produce.
async function getGuildContent(guildId, key) {
  const { rows } = await db.query('SELECT * FROM guild_content WHERE guild_id = $1 AND content_key = $2', [guildId, key]);
  return rows[0] || null;
}

async function setGuildContent(guildId, key, title, body, updatedBy) {
  await db.ensureGuild(guildId);
  await db.query(
    `INSERT INTO guild_content (guild_id, content_key, title, body, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (guild_id, content_key) DO UPDATE SET title = $3, body = $4, updated_by = $5, updated_at = now()`,
    [guildId, key, title, body, updatedBy]
  );
}

const {
  CONTENT_TYPES, renderContentBody, paginate, chunkEmbedsIntoMessages,
} = require('./modules/contentRender');

// Returns an ARRAY now — a long document is several embeds, not one truncated
// one. Callers spread it; `buildContentEmbed` is kept as the single-embed
// convenience for the places that only ever preview.
async function buildContentEmbeds(guildId, key) {
  const row = await getGuildContent(guildId, key);
  if (!row) return null;

  const pages = paginate(renderContentBody(row.body));
  return pages.map((page, i) => {
    const e = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(page || '_(empty)_');
    // Only the first page carries the title, and only the last the footer —
    // repeating both on every page reads as four separate documents.
    if (i === 0) e.setTitle(row.title);
    if (i === pages.length - 1) {
      e.setFooter({
        text: pages.length > 1 ? `${BOT_NAME} · page ${i + 1}/${pages.length}` : BOT_NAME,
        iconURL: client.user.displayAvatarURL(),
      }).setTimestamp(new Date(row.updated_at));
    } else {
      e.setFooter({ text: `page ${i + 1}/${pages.length}` });
    }
    return e;
  });
}

async function buildContentEmbed(guildId, key) {
  const embeds = await buildContentEmbeds(guildId, key);
  return embeds ? embeds[0] : null;
}

async function buildUsefulLinksEmbed(guildId) {
  let links = await getUsefulLinks(guildId);

  // First-run convenience: if this is your original server and it's empty
  // (e.g. before migrate.js has been run), seed it once instead of showing
  // an empty list. Brand-new servers installing the bot start empty — no
  // unrelated server should see your download links by default.
  if (!links.length && guildId === process.env.GUILD_ID) {
    await bulkInsertUsefulLinks(guildId, USEFUL_LINKS_SEED, 'replace');
    links = await getUsefulLinks(guildId);
  }

  const description = links.length
    ? links.map((l, i) => `**${i + 1}.** [${l.label}](${l.url})`).join('\n')
    : 'No links added yet.';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔗 Useful Links')
    .setDescription(description)
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });
}

// ─── Redeemable time-limited role keys — migrated to Postgres ─────────────
// duration_ms is NULL in the DB for lifetime keys; in JS we represent that
// as the string 'lifetime' to keep call sites simple. rowToKeyEntry()
// converts at the boundary.
function rowToKeyEntry(row) {
  if (!row) return null;
  return {
    key: row.key,
    guildId: row.guild_id,
    roleId: row.role_id,
    roleName: row.role_name,
    durationMs: row.duration_ms === null ? 'lifetime' : Number(row.duration_ms),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
  };
}

async function generateKeyString() {
  const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  for (;;) {
    const key = `UH-${segment()}-${segment()}-${segment()}`;
    const { rows } = await db.query('SELECT 1 FROM keys WHERE key = $1', [key]);
    if (!rows.length) return key;
  }
}

async function createKeyRow({ key, guildId, roleId, roleName, durationMs, createdBy }) {
  await db.ensureGuild(guildId);
  await db.query(
    `INSERT INTO keys (key, guild_id, role_id, role_name, duration_ms, status, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,'unredeemed',$6, now())`,
    [key, guildId, roleId, roleName, durationMs === 'lifetime' ? null : durationMs, createdBy]
  );
}

async function getKeyEntry(key) {
  const { rows } = await db.query('SELECT * FROM keys WHERE key = $1', [key]);
  return rowToKeyEntry(rows[0]);
}

async function markKeyRedeemed(key, userId, expiresAtDate) {
  await db.query(
    `UPDATE keys SET status='active', redeemed_by=$2, redeemed_at=now(), expires_at=$3 WHERE key=$1`,
    [key, userId, expiresAtDate]
  );
}

async function markKeyStatus(key, status) {
  await db.query('UPDATE keys SET status=$2 WHERE key=$1', [key, status]);
}

// Renamed from parseDuration to avoid colliding with the pre-existing
// giveaway duration parser elsewhere in this file (same name, different
// unit rules — JS silently keeps only the later declaration, which was
// causing /genkey to use the WRONG parser: "1m" was read as 1 minute via
// the giveaway parser instead of erroring or meaning something else).
// Accepts the fixed preset values from /genkey's duration choices, or
// "lifetime" for a key that never expires.
function parseKeyDuration(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'lifetime') return 'lifetime';
  const m = v.match(/^(\d+)\s*([mhdw])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n <= 0) return null;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * unitMs[m[2]];
}

// Module scope, not inside the /genkey handler where this used to live: the web
// panel mints keys too, and a second copy of this map is how the same 30d key
// ends up labelled "1 Month" in Discord and "30d" in the browser.
const DURATION_LABELS = {
  lifetime: 'Lifetime', '365d': '1 Year', '90d': '3 Months', '30d': '1 Month',
  '14d': '2 Weeks', '3d': '3 Days', '1d': '1 Day', '5m': '5 Minutes',
};

// Removes the role for any key whose time is up. Runs on a timer, and once
// immediately at startup in case expirations piled up while the bot was down.
// The whole body is wrapped defensively — if the database is briefly
// unreachable (misconfigured DATABASE_URL, Postgres restarting, etc.) this
// logs and moves on instead of throwing an unhandled rejection that takes
// the entire bot process down. A missing key-expiry check for one minute is
// fine; a fully crashed bot is not.
async function sweepExpiredKeys() {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT * FROM keys WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`
    ));
  } catch (e) {
    console.error('[keys] sweep skipped — could not reach the database:', e.message);
    return;
  }

  for (const row of rows) {
    const entry = rowToKeyEntry(row);
    try {
      await markKeyStatus(entry.key, 'expired');
      const guild = client.guilds.cache.get(entry.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(entry.redeemedBy).catch(() => null);
      const role = guild.roles.cache.get(entry.roleId);
      if (member && role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role).catch(e => console.error(`[keys] failed to remove expired role for key ${entry.key}:`, e));
      }
    } catch (e) {
      console.error(`[keys] sweep error for key ${entry.key}:`, e);
    }
  }
}

// Called from the /api/keys/issue HTTP endpoint (see modules/auth2fa.js) —
// same key shape /genkey produces, so it works interchangeably with /redeem,
// /listkeys, /revokekey, and the expiry sweep above.
async function issueKeyAndNotify({ discordUserId, guildId, roleId, durationMs }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, error: `Bot is not in guild ${guildId}.` };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, error: `Role ${roleId} not found in that guild.` };

  const key = await generateKeyString();
  await createKeyRow({ key, guildId, roleId: role.id, roleName: role.name, durationMs, createdBy: 'website' });

  let dmSent = false;
  try {
    const user = await client.users.fetch(discordUserId);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔑 Your Key Is Ready')
      .setDescription(
        `Thanks for your order! Here's your key for **${role.name}**:\n\n` +
        `\`${key}\`\n\n` +
        `Redeem it in the server with:\n\`/redeem key:${key}\``
      )
      .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    await user.send({ embeds: [embed] });
    dmSent = true;
  } catch (e) {
    console.error(`[keys] failed to DM key to ${discordUserId}:`, e);
  }

  return { ok: true, key, dmSent };
}

// ─── Key operations for the web panel ────────────────────────────────────────
// Passed into modules/panel.js rather than reimplemented there. The panel and
// /genkey write the same rows, log to the same gen channel, and read the same
// duration labels — because they call this, not a second copy of it.
//
// Unlike issueKeyAndNotify these do NOT DM anyone: the panel hands the strings
// straight back to the staff member who pressed the button, and there is no
// buyer to notify yet.
async function mintKeysForPanel({ guildId, roleId, duration, count, createdBy }) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, error: 'The bot is not in that server.' };

  const role = guild.roles.cache.get(String(roleId));
  if (!role) return { ok: false, error: 'That role no longer exists.' };
  // The panel filters these out of the picker, but the picker is a snapshot —
  // a role can be moved above the bot between loading the page and pressing
  // Generate, and a key for an unassignable role fails silently at /redeem.
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) {
    return { ok: false, error: `${role.name} sits above the bot's own role, so the bot cannot grant it.` };
  }
  if (role.managed) return { ok: false, error: `${role.name} is managed by an integration and cannot be granted.` };

  const durationMs = parseKeyDuration(duration);
  if (durationMs === null) return { ok: false, error: `"${duration}" is not a duration this bot understands.` };

  const n = Math.max(1, Math.min(25, parseInt(count, 10) || 1));
  const keys = [];
  for (let i = 0; i < n; i++) {
    const key = await generateKeyString();
    await createKeyRow({ key, guildId, roleId: role.id, roleName: role.name, durationMs, createdBy });
    keys.push(key);
  }

  const durationLabel = DURATION_LABELS[duration] || String(duration);
  // Same log line /genkey writes, for the same reason — keys grant a paid role.
  // The strings stay out of it; anyone who can read that channel could redeem one.
  logGeneration(client, {
    kind: 'key',
    user: { id: String(createdBy).replace(/^panel:/, ''), tag: `${createdBy} (web panel)` },
    what: `${n} × ${role.name}`,
    detail: `Duration: ${durationLabel}`,
    source: 'web panel',
    guildId,
  }).catch(() => {});

  return { ok: true, keys, roleName: role.name, durationLabel };
}

async function revokeKeyForPanel({ guildId, key }) {
  const entry = await getKeyEntry(key);
  if (!entry) return { ok: false, error: 'No such key.' };
  if (entry.status === 'revoked') return { ok: false, error: 'That key was already revoked.' };

  await markKeyStatus(key, 'revoked');

  // An unredeemed key has no holder — nothing to take back, and saying "role
  // removed" would be a claim about a member who does not exist.
  if (entry.status !== 'active' || !entry.redeemedBy) {
    return { ok: true, roleRemoved: false, note: 'It had not been redeemed, so nobody lost a role.' };
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: true, roleRemoved: false, note: 'The key is dead, but the bot is no longer in that server to remove the role.' };

  try {
    const member = await guild.members.fetch(entry.redeemedBy);
    await member.roles.remove(entry.roleId);
    return { ok: true, roleRemoved: true };
  } catch (e) {
    // The key is already revoked at this point, and that is the part that
    // matters — it cannot be redeemed again. Report the role honestly.
    console.warn(`[keys] revoked ${key} but could not remove role ${entry.roleId} from ${entry.redeemedBy}:`, e.message);
    return { ok: true, roleRemoved: false, note: `The key is dead, but the role could not be removed (${e.message}) — do it by hand.` };
  }
}

// Shared redeem logic — used by /redeem and by the postredeem panel's modal.
// `interaction` must not have been replied to yet.
async function redeemKey(interaction, rawKeyInput) {
  const keyInput = (rawKeyInput || '').trim().toUpperCase();
  const entry = await getKeyEntry(keyInput);

  if (!entry) {
    return interaction.reply({ content: '❌ That key doesn\'t exist.', flags: 64 });
  }
  if (entry.guildId !== interaction.guild.id) {
    return interaction.reply({ content: '❌ That key isn\'t valid on this server.', flags: 64 });
  }
  if (entry.status !== 'unredeemed') {
    const already = entry.status === 'active' ? 'already been redeemed' : entry.status;
    return interaction.reply({ content: `❌ That key has ${already}.`, flags: 64 });
  }

  const role = interaction.guild.roles.cache.get(entry.roleId);
  if (!role) {
    return interaction.reply({ content: '❌ The role tied to this key no longer exists — contact staff.', flags: 64 });
  }

  // Same helper the verify button and the claim panel use: "contact staff" is
  // not an answer when the cause is a role order only an admin can fix, and
  // the person being told to contact staff is often the admin.
  const roleWhy = await assignRole(interaction.member, role, 'Key redeemed');
  if (roleWhy) {
    return interaction.reply({ content: `❌ Could not assign **${role.name}** — ${roleWhy}`, flags: 64 });
  }

  const now = Date.now();
  const isLifetime = entry.durationMs === 'lifetime';
  const expiresAtDate = isLifetime ? null : new Date(now + entry.durationMs);
  await markKeyRedeemed(keyInput, interaction.user.id, expiresAtDate);

  const expiryText = isLifetime
    ? 'forever — this is a lifetime key'
    : `until <t:${Math.floor(expiresAtDate.getTime() / 1000)}:F> (<t:${Math.floor(expiresAtDate.getTime() / 1000)}:R>)`;

  return interaction.reply({
    content: `🎉 Key redeemed! You've been given **${role.name}** ${expiryText}.`,
    flags: 64,
  });
}

// Fixed types shown as dedicated panel buttons (staff still use /addstock with
// these same slugs — e.g. /addstock type:steam, type:steam phone verified, etc.)
// One action row holds at most 5 buttons — adding a 6th type here needs a
// second row, so the panel builder splits them rather than throwing.
const GEN_PANEL_TYPES = [
  { type: 'standard',        label: 'Steam',                 emoji: '🎮' },
  { type: 'phone-verified',  label: 'Steam Phone Verified',  emoji: '📱' },
  { type: 'activision',      label: 'Activision',            emoji: '🔫' },
  { type: 'email-outlook',   label: 'Email: Outlook',        emoji: '📧' },
  { type: '5m-bundle',       label: '5M BUNDLE',             emoji: '💰' },
];

// `/addstock` with no type slugs to 'standard', but the panel's Steam button
// asked for 'steam'. Two names for one bucket: 134 uploaded accounts sat in
// stock while the button answered "Out of stock for steam". Aliases collapse
// them. 'standard' stays canonical so no existing row has to be rewritten.
const STOCK_TYPE_ALIASES = {
  'steam': 'standard',
  'steam-account': 'standard',
  'steam-standard': 'standard',
  'steam-phone-verified': 'phone-verified',
  'phoneverified': 'phone-verified',
  'pv': 'phone-verified',
  'outlook': 'email-outlook',
  'email': 'email-outlook',
  'emailoutlook': 'email-outlook',
  'activision-account': 'activision',
  'acti': 'activision',
  'cod': 'activision',
  // The button says "5M BUNDLE", so /addstock will be typed every which way.
  // normalizeStockType() already folds "5M BUNDLE" → "5m-bundle"; these cover
  // the shorthands staff actually use.
  '5m': '5m-bundle',
  '5mbundle': '5m-bundle',
  'bundle': '5m-bundle',
  '5m-bundles': '5m-bundle',
};

// Staff type slugs; buyers see these.
const STOCK_TYPE_LABELS = {
  'standard': 'Steam',
  'phone-verified': 'Steam Phone Verified',
  'email-outlook': 'Email: Outlook',
  'activision': 'Activision',
  '5m-bundle': '5M BUNDLE',
};

function stockTypeLabel(type) {
  return STOCK_TYPE_LABELS[type] || type;
}

// Categories that carry no software build, so they never appear on the
// website's status page — accounts, custom orders and services. /post-status
// is documented as being "in sync w/ site", and the site now filters them, so
// this list has to match window.NON_SOFTWARE_CATEGORIES in the storefront or
// Discord posts a longer list than the page shows.
const NON_STATUS_CATEGORIES = ['accounts', 'services', 'custom order'];
function isNonStatusCategory(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  if (!n) return false;
  if (NON_STATUS_CATEGORIES.includes(n)) return true;
  return n.includes('custom order') || n.includes('donation');
}

function normalizeStockType(raw) {
  const t = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!t) return 'standard';
  return STOCK_TYPE_ALIASES[t] || t;
}

// Stock access roles — set as env vars if you ever need to change them without a redeploy.
const GEN_ROLE_ID_ENV      = process.env.GEN_ROLE_ID      || '1525288697656901712'; // 💎 Gen Member
const OVERSEER_ROLE_ID_ENV = process.env.OVERSEER_ROLE_ID || '1518372339115360358'; // OVERSEER — unlimited

// Staff roles are resolved PER GUILD — see modules/staffRoles.js for why a
// single shared id was wrong in exactly one of the two servers, silently.
const { staffRoleIdsFor, defaultOverseerRoleId } = makeStaffRoleResolver({
  primaryGuildId:       GUILD_ID,
  envMapRaw:            process.env.STAFF_ROLE_IDS,
  staffRoleId:          process.env.STAFF_ROLE_ID,
  legacyOverseerRoleId: OVERSEER_ROLE_ID_ENV,
  // Only when already warm: this must not become an await. The panel writes
  // overseer_role_id and invalidates the cache, so a change lands within one
  // refresh either way.
  getCachedOverseerRoleId: (guildId) => {
    const cached = guildSettingsCache.get(guildId);
    return cached && cached.expiresAt > Date.now() ? cached.data.overseerRoleId : null;
  },
});

// ─── Per-guild settings — Postgres-backed, cached in memory ────────────────
// Cache exists so hot paths (every message, every interaction) don't hit the
// DB every time — 30s is short enough that a panel edit shows up almost
// immediately, long enough to not matter for load. invalidateGuildSettings()
// (called from the panel's settings save route) clears it instantly instead
// of waiting out the TTL.
const guildSettingsCache = new Map(); // guildId -> { data, expiresAt }
const SETTINGS_CACHE_MS = 30_000;

async function getGuildSettings(guildId) {
  const cached = guildSettingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  let row = null;
  try {
    const { rows } = await db.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    row = rows[0] || null;
  } catch (e) {
    console.error('[settings] load failed, using defaults:', e.message);
  }

  // Your original server keeps its exact old hardcoded/env values as
  // defaults (so nothing changes there unless you save new ones in the
  // panel). Any other guild gets plain bot defaults until configured.
  const isOriginal = guildId === GUILD_ID;
  const data = {
    // ID-based (preferred) — set these in the panel by pasting the actual
    // role/channel ID. If unset, the bot falls back to finding-or-creating
    // a channel/role by name (verifiedRoleName etc.) so a brand-new server
    // still works before anyone's configured anything.
    verifiedRoleId:     row?.verified_role_id     || null,
    welcomeChannelId:   row?.welcome_channel_id    || (isOriginal ? WELCOME_CHANNEL_ID : null),
    verifyChannelId:    row?.verify_channel_id     || null,
    invitesChannelId:   row?.invites_channel_id    || (isOriginal ? INVITES_CHANNEL_ID : null),
    inviteLogChannelId: row?.invite_log_channel_id || (isOriginal ? INVITE_LOG_CHANNEL_ID : null),

    // Name-based bootstrap fallbacks — only used when the ID above isn't set.
    verifiedRoleName:   row?.verified_role_name    || (isOriginal ? VERIFIED_ROLE_ENV   : 'Verified'),
    verifyChannelName:  row?.verify_channel_name   || (isOriginal ? VERIFY_CHANNEL_ENV  : 'get-verify'),
    welcomeChannelName: row?.welcome_channel_name  || (isOriginal ? WELCOME_CHANNEL_ENV : 'welcome'),
    invitesChannelName: row?.invites_channel_name  || (isOriginal ? INVITES_CHANNEL_ENV : 'invites'),
    inviteLogChannelName: row?.invite_log_channel_name || (isOriginal ? INVITE_LOG_CHANNEL_ENV : 'invite-tracker'),

    invitesNeeded:      row?.invites_needed ?? (isOriginal ? INVITES_NEEDED_ENV : 10),
    genRoleId:          row?.gen_role_id          || (isOriginal ? GEN_ROLE_ID_ENV        : null),
    // Per guild, not per bot — see staffRoleIdsFor(). This is what makes the
    // store server's own OVERSEER count for stock access and gen limits too.
    overseerRoleId:     row?.overseer_role_id     || defaultOverseerRoleId(guildId),
    countingChannelId:  row?.counting_channel_id  || (isOriginal ? COUNTING_CHANNEL_ID : null),
    leaveVouchChannelId:row?.leave_vouch_channel_id || (isOriginal ? LEAVE_VOUCH_CHANNEL_ID : null),
    vouchesChannelId:   row?.vouches_channel_id    || (isOriginal ? VOUCHES_CHANNEL_ID    : null),

    // ── Moderation and tickets ────────────────────────────────────────────
    // These seven columns have existed since the panel was written. The panel
    // validated them, saved them, and said "Saved 19 field(s)". Nothing read
    // them — this object stopped at vouchesChannelId, so every one of them was
    // a field you could fill in that did nothing at all. That is worse than a
    // missing setting: a missing one at least looks missing.
    //
    // Deliberately NOT env-defaulted even on the original guild. antiscam.js
    // and support.js still read their own env vars as the fallback when these
    // come back null, so answering "null" here means "the panel has nothing to
    // say about this guild" and the module keeps its old behaviour exactly.
    // Answering with the env value here would instead mean the second server
    // silently inherits the first server's channel ids, which is the bug.
    logChannelId:       row?.log_channel_id       || null,
    staffRoleId:        row?.staff_role_id        || null,
    ticketLogChannel:   row?.ticket_log_channel   || null,
    // ?? not ||, because 0 is a legitimate value for all four: 0 warnings
    // before a ban is "ban on the first offence", and a 0-minute mute is a
    // delete-only policy. || would silently turn either into the default.
    warningsBeforeBan:   row?.warnings_before_ban   ?? null,
    muteDurationMinutes: row?.mute_duration_minutes ?? null,
    spamMessageLimit:    row?.spam_message_limit    ?? null,
    spamTimeWindow:      row?.spam_time_window      ?? null,

    // ── The twelve that only ever existed as env vars ─────────────────────
    // An env var is one value for the whole process and the bot is in two
    // servers, so each of these was a single id shared by both. On the second
    // server that meant either the message went to the FIRST server's channel
    // — client.channels.fetch is bot-wide and resolves across guilds without
    // complaint — or it went nowhere.
    //
    // Same rule as the seven above: null, never the env value. Each consumer
    // applies its own env fallback, so null means "the panel has nothing to
    // say about this guild" and the original server is untouched until
    // somebody fills a field in on purpose.
    ordersChannelId:         row?.orders_channel_id          || null,
    restockChannelId:        row?.restock_channel_id         || null,
    vaultRestockChannelId:   row?.vault_restock_channel_id   || null,
    manualDeliveryChannelId: row?.manual_delivery_channel_id || null,
    smsGenChannelId:         row?.sms_gen_channel_id         || null,
    genLogChannelId:         row?.gen_log_channel_id         || null,
    alertsChannelId:         row?.alerts_channel_id          || null,
    rankBoostLogChannel:     row?.rank_boost_log_channel     || null,
    rankBoostRoleId:         row?.rank_boost_role_id         || null,
    // NOT staffRoleId. staff_role_id is the money gate; this is the ticket
    // rota. Collapsing them hands the till to everyone who answers tickets.
    ticketStaffRoleId:       row?.ticket_staff_role_id       || null,
    customerRoleId:          row?.customer_role_id           || null,
  };

  guildSettingsCache.set(guildId, { data, expiresAt: Date.now() + SETTINGS_CACHE_MS });
  return data;
}

function invalidateGuildSettings(guildId) {
  guildSettingsCache.delete(guildId);
}

// ─── The panel's settings, handed to the modules that enforce them ──────────
// antiscam.js and support.js both used to read env vars at require time — one
// set of thresholds and one set of channel ids for the whole bot, regardless of
// how many servers it is in. They take a provider now, and this is where it is
// installed: getGuildSettings is the single place a guild's configuration is
// read and cached, so a save in the panel (which calls invalidateGuildSettings)
// takes effect on the next message rather than at the next restart.
//
// Each module keeps its own env values as the fallback, which is why these
// return the row's value or nothing at all — see the comment on the seven
// fields above. Nothing here invents a default; that decision belongs to the
// module that has to live with it.
antiscam.setModConfigProvider(async (guildId) => {
  const s = await getGuildSettings(guildId);
  return {
    warningsBeforeBan:   s.warningsBeforeBan,
    muteDurationMinutes: s.muteDurationMinutes,
    spamMessageLimit:    s.spamMessageLimit,
    spamTimeWindow:      s.spamTimeWindow,
    logChannelId:        s.logChannelId,
  };
});

support.setSupportSettingsProvider(async (guildId) => {
  const s = await getGuildSettings(guildId);
  return {
    ticketLogChannel:  s.ticketLogChannel,
    // The ticket rota and the money gate are separate fields in the panel now,
    // and this is why: staff_role_id gates /web-balance, /addstock, /clearstock
    // and /giveaway. Ticket staff need Reply and Close, not the till. Falling
    // back to staffRoleId when the ticket field is blank would have quietly
    // re-merged the two for every guild that only filled in one.
    ticketStaffRoleId:   s.ticketStaffRoleId,
    rankBoostLogChannel: s.rankBoostLogChannel,
    rankBoostRoleId:     s.rankBoostRoleId,
  };
});

// The three modules that log to a channel of their own. Each keeps its own env
// var and hardcoded fallback for when this answers null, so the original server
// is untouched — what changes is that the second server can now name its own
// channel instead of quietly writing into the first server's.
setGenLogSettingsProvider(async (guildId) => {
  const s = await getGuildSettings(guildId);
  return { genLogChannelId: s.genLogChannelId };
});

setManualSettingsProvider(async (guildId) => {
  const s = await getGuildSettings(guildId);
  return { manualDeliveryChannelId: s.manualDeliveryChannelId };
});

setSmsSettingsProvider(async (guildId) => {
  const s = await getGuildSettings(guildId);
  return { smsGenChannelId: s.smsGenChannelId };
});

// So a server that has configured nothing still gets its number cards in
// #sms-number-generated rather than next to the panel in #sms-verify. Handed in
// rather than re-implemented in the module, because this is the version that
// normalizes the mathematical-bold channel names the second server uses.
setSmsChannelFinder((guild, name) => findChannelByName(guild, name));

async function canAccessStock(member) {
  if (member.permissions.has('Administrator')) return true;
  const settings = await getGuildSettings(member.guild.id);
  if (settings.overseerRoleId && member.roles.cache.has(settings.overseerRoleId)) return true;
  if (settings.genRoleId && member.roles.cache.has(settings.genRoleId)) return true;
  return false;
}

// Admins / OVERSEER bypass the per-type cooldown entirely.
async function hasUnlimitedGen(member) {
  if (member.permissions.has('Administrator')) return true;
  const settings = await getGuildSettings(member.guild.id);
  return !!(settings.overseerRoleId && member.roles.cache.has(settings.overseerRoleId));
}

// Parses lines like:
//   sadHawk69367:vFbdmjbjdOJC|sutkuschampeau525@outlook.com:InD28x9O4mKk (+447452933178)
// into { username, password, email, emailPassword, phone }. Phone is optional.
// Returns null if the line doesn't match — callers should fall back to raw display,
// so accounts in any other format (or other stock types) still work fine.
// Split one stock line into labelled fields.
//
// This used to insist on exactly ONE shape — `user:pass|email:emailpass` —
// and return null for anything else, and the caller's fallback dumps the raw
// line into a code block. Every account actually in stock is written
// `user:pass:email:emailpass`, with no pipe, so the fallback was the ONLY
// path that ever ran: buyers were handed an undelimited blob and left to work
// out which of the four values was which.
//
// So this is deliberately tolerant now. The pipe form still parses; so does
// plain colon separation, a bare `user:pass`, and an email-as-username login.
//
// Colons are the separator AND legal inside a password, so position alone
// cannot be trusted. The email is the one field that identifies itself, so it
// anchors the split and whatever sits between the username and it is the
// password, however many colons that spans.
function parseStockAccountLine(raw) {
  if (typeof raw !== 'string') return null;
  let line = raw.trim();
  if (!line) return null;

  // Optional trailing "(+1 555 0100)" — a phone note, not a credential.
  let phone = null;
  const phoneMatch = line.match(/\s*\(([^)]+)\)\s*$/);
  if (phoneMatch) { phone = phoneMatch[1].trim() || null; line = line.slice(0, phoneMatch.index).trim(); }

  const out = { username: null, password: null, email: null, emailPassword: null, phone, extra: null };

  // Pipe form: the pipe is an unambiguous boundary, so honour it first and
  // split each half on its FIRST colon only.
  if (line.includes('|')) {
    const cut = line.indexOf('|');
    const left = line.slice(0, cut).trim();
    const right = line.slice(cut + 1).trim();
    const li = left.indexOf(':');
    if (li === -1) return null;
    out.username = left.slice(0, li);
    out.password = left.slice(li + 1);
    const ri = right.indexOf(':');
    if (ri === -1) { out.email = right || null; }
    else { out.email = right.slice(0, ri); out.emailPassword = right.slice(ri + 1); }
    return out.username && out.password ? out : null;
  }

  const parts = line.split(':');
  if (parts.length < 2) return null;

  const emailIdx = parts.findIndex(p => p.includes('@'));

  if (emailIdx > 0) {
    out.username     = parts[0];
    out.password     = parts.slice(1, emailIdx).join(':');
    out.email        = parts[emailIdx];
    out.emailPassword = parts[emailIdx + 1] || null;
    // Anything past the email password (a Steam Guard secret, a note) is kept
    // rather than dropped — losing part of a line the buyer paid for is worse
    // than showing a field we cannot name.
    const rest = parts.slice(emailIdx + 2).join(':');
    out.extra = rest || null;
  } else if (emailIdx === 0) {
    // The email IS the login. Labelling it "Username" would be a lie, so it
    // is reported as the email and the password beside it.
    out.email    = parts[0];
    out.password = parts.slice(1).join(':');
    out.username = parts[0];
  } else {
    out.username = parts[0];
    out.password = parts.slice(1).join(':');
  }

  return out.username && out.password ? out : null;
}

async function buildStockEmbed(guildId) {
  const types = await getStockTypes(guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Stock Levels')
    .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

  if (!types.length) {
    embed.setDescription('No stock has been added yet.');
  } else {
    embed.setDescription(types.map(t => `**${stockTypeLabel(t.type)}** — ${t.count} available`).join('\n'));
  }
  return embed;
}

// Shared claim logic — used by /gensteam directly, and by the postgensteam
// panel's button + type-select dropdown flow. `interaction` must not have
// been replied to yet when this is called.
async function claimStockAccount(interaction, type) {
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const unlimited = await hasUnlimitedGen(interaction.member);

  if (!unlimited) {
    const lastGen = await getStockCooldown(guildId, userId, type);
    if (lastGen) {
      const elapsedMs = Date.now() - new Date(lastGen).getTime();
      const cooldownMs = STOCK_COOLDOWN_HOURS * 60 * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const readyAt = Math.floor((new Date(lastGen).getTime() + cooldownMs) / 1000);
        return interaction.reply({ content: `⏳ You can generate another **${stockTypeLabel(type)}** account <t:${readyAt}:R>.`, flags: 64 });
      }
    }
  }

  const account = await claimOneStockAccount(guildId, type);
  if (!account) {
    return interaction.reply({ content: `❌ Out of stock for **${stockTypeLabel(type)}**. Check back later!`, flags: 64 });
  }

  if (!unlimited) await setStockCooldown(guildId, userId, type);

  const remaining = await getStockCount(guildId, type);

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('🔐 Your Account')
    .setFooter({ text: `${BOT_NAME} | Keep this safe — it will not be shown again`, iconURL: client.user.displayAvatarURL() });

  const stockFields = [
    { name: 'Type', value: stockTypeLabel(type), inline: true },
    { name: 'Remaining Stock', value: `${remaining}`, inline: true },
  ];

  const parsed = parseStockAccountLine(account);
  if (parsed) {
    // Credentials lead. Type and Remaining Stock used to sit at the top, so
    // the first thing a buyer read was our inventory count rather than the
    // thing they had just paid for.
    //
    // Each value is its own code span, which on mobile is a one-tap copy —
    // the reason they are NOT joined back into a single block. Every field is
    // full-width: the old three-per-row layout truncated a long password into
    // a narrow column, and the zero-width spacer it needed to keep the rows
    // even rendered as a blank entry of its own.
    embed.addFields({ name: '👤 Username', value: `\`${parsed.username}\``, inline: false });
    embed.addFields({ name: '🔑 Password', value: `\`${parsed.password}\``, inline: false });
    // A bare user:pass line has no email. An empty field would read as a
    // value we lost rather than one that was never there.
    if (parsed.email && parsed.email !== parsed.username) {
      embed.addFields({ name: '📧 Email', value: `\`${parsed.email}\``, inline: false });
    }
    if (parsed.emailPassword) {
      embed.addFields({ name: '📨 Email Password', value: `\`${parsed.emailPassword}\``, inline: false });
    }
    if (parsed.phone) embed.addFields({ name: '📞 Phone', value: `\`${parsed.phone}\``, inline: false });
    // Anything past the email password — a Steam Guard secret, a note. Kept
    // rather than dropped: losing part of a line the buyer paid for is worse
    // than showing a field we cannot name precisely.
    if (parsed.extra) embed.addFields({ name: '➕ Extra', value: `\`${parsed.extra}\``, inline: false });
    embed.addFields(...stockFields);
  } else {
    // Matches no known schema — show it raw rather than lose data.
    embed.addFields(...stockFields);
    embed.setDescription(`\`\`\`${account}\`\`\``);
  }

  let delivered = false;
  try {
    await interaction.user.send({ embeds: [embed] });
    delivered = true;
  } catch (_) { /* DMs closed — fall back below */ }

  // Audit trail. Deliberately AFTER the delivery attempt so it can record
  // whether the member actually received it, and deliberately not awaited into
  // the reply path — logGeneration swallows its own failures, but a slow
  // channel fetch should not push the interaction past its 3s window.
  logGeneration(client, {
    kind: 'account',
    user: interaction.user,
    what: stockTypeLabel(type),
    remaining,
    delivered,
    source: interaction.isButton?.() ? 'panel button' : '/gensteam',
    guildId: interaction.guild && interaction.guild.id,
  }).catch(() => {});

  if (delivered) {
    return interaction.reply({ content: '✅ Sent your account via DM! Check your messages.', flags: 64 });
  } else {
    return interaction.reply({ content: '⚠️ Couldn\'t DM you (your DMs may be closed), so here it is — only you can see this message:', embeds: [embed], flags: 64 });
  }
}

// The counting-game evaluator lives in modules/counting.js. It replaced a
// parser here that understood digits, `+ - * / ^` and parentheses and nothing
// else — and treated everything it did not understand as a wrong answer, which
// reset the whole server's streak. `5 × 5` was enough to do it, and `×` is the
// character a phone keyboard inserts when you press the multiply key.

// Two people can type the same number within a second of each other. The
// slower message is a race, not a miscount, and resetting on it is the single
// most common way a streak died unfairly.
const COUNTING_RACE_MS = 3000;

/** Trims float noise off a value before showing it to the channel. */
function fmtCount(n) {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

async function handleCountingMessage(message) {
  const gid   = message.guild.id;
  const state = countingData.get(gid) || { count: 0, lastUserId: null, highScore: 0 };
  const raw   = message.content;
  const expected = state.count + 1;

  const read = counting.readCount(raw, expected);

  // Not a count at all — "gg", "nice one", a reaction emoji. This used to
  // reset the streak, because anything the old parser could not read was
  // treated as a wrong answer. Talking in the channel is not miscounting.
  if (read.verdict === 'chatter') return;

  const sameUserTwice = state.lastUserId === message.author.id;

  if (read.verdict === 'correct' && !sameUserTwice) {
    state.count = expected;
    state.lastUserId = message.author.id;
    state.lastAt = Date.now();
    if (state.count > (state.highScore || 0)) state.highScore = state.count;
    countingData.set(gid, state);
    saveCounting(gid);
    try { await message.react('✅'); } catch (_) {}
    return;
  }

  // ── the two cases where this must not judge ────────────────────────────────

  // Postgres has not answered yet, or could not be reached. The count in memory
  // is then a guess, and a reset decided on a guess is the complaint that got
  // this rewritten. Do nothing: the channel keeps counting, nobody is blamed,
  // and the state comes back when the read succeeds.
  if (!countingTruthKnown) {
    console.warn('[Counting] a count arrived before the saved state was readable — not judging it');
    return;
  }

  // Nothing has ever been saved for this guild and the channel is plainly
  // mid-game: adopt the number rather than announcing that a streak somebody
  // has been building for a week is a mistake. This can happen exactly once per
  // guild — after it, there is a row.
  if (!countingData.has(gid) && read.verdict === 'wrong'
      && Number.isInteger(read.value) && read.value > 1 && read.value <= 1e6) {
    state.count = read.value;
    state.lastUserId = message.author.id;
    state.lastAt = Date.now();
    state.highScore = Math.max(state.highScore || 0, read.value);
    countingData.set(gid, state);
    saveCounting(gid);
    console.log(`[Counting] adopted ${read.value} as the count in ${gid} — nothing was saved for it before`);
    try { await message.react('✅'); } catch (_) {}
    return;
  }

  // The race: someone else's message says the number that was accepted a
  // moment ago. Delete the duplicate, keep the streak.
  if (!sameUserTwice && state.count > 0 && state.lastAt &&
      Date.now() - state.lastAt < COUNTING_RACE_MS &&
      counting.readCount(raw, state.count).verdict === 'correct') {
    try { if (message.deletable) await message.delete(); } catch (_) {}
    return;
  }

  // A genuine miscount, or the same person counting twice in a row.
  const brokenAt = state.count;
  const reason = sameUserTwice
    ? 'counted twice in a row'
    : `posted **${fmtCount(read.value)}** instead of **${expected}**`;

  state.count = 0;
  state.lastUserId = null;
  state.lastAt = 0;
  countingData.set(gid, state);
  saveCounting(gid);

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

// ─── Invite stats persistence ────────────────────────────────────────────────
// The Map above is the hot path; Postgres is the truth. It is loaded once on
// ready and written through on every change. Redeeming a reward is gated on
// `floor(real / needed) - usedKeys`, so when this was memory-only a restart
// zeroed usedKeys and handed every member their keys again — a free key per
// deploy. Writes swallow their errors: a DB blip must not break a join.
async function loadInviteStats() {
  try {
    const { rows } = await db.query(`SELECT * FROM invite_stats`);
    for (const r of rows) {
      getGuildData(String(r.guild_id)).set(String(r.user_id), {
        total: r.total || 0, real: r.real_count || 0, left: r.left_count || 0,
        fake: r.fake_count || 0, usedKeys: r.used_keys || 0,
      });
    }
    if (rows.length) console.log(`[Invites] loaded stats for ${rows.length} inviter(s)`);
  } catch (e) {
    console.error('[Invites] could not load stats:', e.message);
  }
}

async function saveInviteStats(gid, uid) {
  const d = getUserInviteData(gid, uid);
  try {
    await db.query(
      `INSERT INTO invite_stats (guild_id, user_id, total, real_count, left_count, fake_count, used_keys, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         total = EXCLUDED.total, real_count = EXCLUDED.real_count,
         left_count = EXCLUDED.left_count, fake_count = EXCLUDED.fake_count,
         used_keys = EXCLUDED.used_keys, updated_at = now()`,
      [String(gid), String(uid), d.total, d.real, d.left, d.fake, d.usedKeys]
    );
  } catch (e) {
    console.error('[Invites] could not save stats for', uid, '-', e.message);
  }
}

// Returns the row as it was BEFORE this join, so the caller can tell a first
// join from a rejoin — a rejoin must not credit the inviter a second time.
async function recordJoin(gid, memberId, inviterId, code, fake) {
  try {
    const { rows } = await db.query(
      `INSERT INTO invite_joins (guild_id, member_id, inviter_id, invite_code, fake, joined_at, left_at)
       VALUES ($1,$2,$3,$4,$5, now(), NULL)
       ON CONFLICT (guild_id, member_id) DO UPDATE SET
         inviter_id  = COALESCE(invite_joins.inviter_id, EXCLUDED.inviter_id),
         invite_code = COALESCE(EXCLUDED.invite_code, invite_joins.invite_code),
         joined_at   = now(),
         left_at     = NULL
       RETURNING (xmax <> 0) AS existed, inviter_id`,
      [String(gid), String(memberId), inviterId ? String(inviterId) : null, code || null, !!fake]
    );
    return rows[0] || { existed: false, inviter_id: inviterId };
  } catch (e) {
    console.error('[Invites] could not record join for', memberId, '-', e.message);
    return null;
  }
}

// Accounts younger than this are counted but not rewarded.
const FAKE_ACCOUNT_AGE_MS = Number(process.env.FAKE_ACCOUNT_AGE_DAYS || 7) * 24 * 60 * 60 * 1000;

// Where the running commentary goes: every join, every leave. Explicitly NOT
// the reward panel's channel.
//
// The last resort is null, not the panel channel. Falling back to #invites is
// what a second server did when it had no ID configured, and it turned a
// three-button post into a scrolling log — so a guild with no tracker channel
// stays quiet and says why once, rather than quietly filling the wrong room.
const warnedNoInviteLog = new Set();
function inviteLogChannel(guild, settings) {
  const ch = (settings.inviteLogChannelId && guild.channels.cache.get(settings.inviteLogChannelId))
    || findChannelByName(guild, settings.inviteLogChannelName);
  if (!ch && !warnedNoInviteLog.has(guild.id)) {
    warnedNoInviteLog.add(guild.id);
    console.warn(`[Invites] ${guild.name}: no invite log channel — set invite_log_channel_id in the panel, `
      + `or create #${settings.inviteLogChannelName}. Join/leave lines are being dropped.`);
  }
  return ch || null;
}

// "Who invited who", posted in the invite log on every join. The tracker
// kept the numbers but never said this out loud anywhere, so the only way to
// see it was to press a button on your own profile.
async function announceInvite(member, inviterId, fake, isRejoin) {
  try {
    const settings = await getGuildSettings(member.guild.id);
    const ch = inviteLogChannel(member.guild, settings);
    // Returns the channel it posted to (null if it could not resolve one), so
    // /testinvite can report WHERE the announcement landed instead of just
    // "sent". A tracker posting into the wrong channel does not error — that is
    // exactly how it went unnoticed — so the destination has to be shown.
    if (!ch) return null;

    const created = `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`;
    let line;
    if (!inviterId) {
      line = `**${member.user.tag}** joined — inviter unknown (vanity URL, or the invite was deleted).`;
    } else {
      const d = getUserInviteData(member.guild.id, inviterId);
      const suffix = isRejoin
        ? ' — **rejoin**, not counted again'
        : fake
          ? ' — flagged **fake** (account too new), not counted toward rewards'
          : ` — they now have **${d.real}** real invite${d.real === 1 ? '' : 's'}`;
      line = `**${member.user.tag}** was invited by <@${inviterId}>${suffix}.`;
    }

    const embed = new EmbedBuilder()
      .setColor(fake ? 0xFEE75C : 0x57F287)
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setDescription(`📨 ${line}`)
      .addFields({ name: 'Account created', value: created, inline: true })
      .setFooter({ text: 'UH SERVICES • Invite Tracker' })
      .setTimestamp();

    await ch.send({ embeds: [embed] });
    return ch;
  } catch (e) {
    console.error('[Invites] could not announce join:', e.message);
    return null;
  }
}

async function recordLeave(gid, memberId) {
  try {
    const { rows } = await db.query(
      `UPDATE invite_joins SET left_at = now()
       WHERE guild_id = $1 AND member_id = $2 AND left_at IS NULL
       RETURNING inviter_id`,
      [String(gid), String(memberId)]
    );
    return rows[0]?.inviter_id || null;
  } catch (e) {
    console.error('[Invites] could not record leave for', memberId, '-', e.message);
    return null;
  }
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
// websiteMessages used to live here — "which message is the website panel",
// held in memory and therefore forgotten on every restart. The panel now
// carries its own marker in its footer, so finding it is a search, not a
// recollection. See /setwebsite below.
const resellerMessages   = {};
const pendingUpdates     = {};
const resellerLinks      = { apply: 'https://uhservices.xyz/', panel: 'https://uhservices.xyz/' };
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
// `site` is the website status this word means. The two vocabularies are not
// the same and never were: the site tracks undetected / testing / updating /
// detected, while the announcements here talk about a product being "updated".
// Those are the same fact from two angles — an update finishing means the
// product is back up and undetected — so "updated" maps onto 'undetected'
// rather than getting a status of its own.
//
// detected/undetected were not sayable here at all, which left the two most
// important states on a store like this one impossible to announce or sync.
const STATUS_TYPES = {
  updating:   { emoji: '🔵', label: 'Updating',   color: 0x9B59B6, site: 'updating'   },
  testing:    { emoji: '🟡', label: 'Testing',    color: 0xF1C40F, site: 'testing'    },
  updated:    { emoji: '🟢', label: 'Updated',    color: 0x57F287, site: 'undetected' },
  undetected: { emoji: '🟢', label: 'Undetected', color: 0x57F287, site: 'undetected' },
  detected:   { emoji: '🔴', label: 'Detected',   color: 0xED4245, site: 'detected'   },
};

function getProductColor(name) {
  const k = name.toLowerCase().trim();
  if (!(k in productColorMap)) productColorMap[k] = PRODUCT_COLORS[colorIndex++ % PRODUCT_COLORS.length];
  return productColorMap[k];
}

// Gate for the money/config commands (/config, /order, /shopstock,
// /web-balance, /webstatus, /webreviews, /giveaway, /addstock, /clearstock).
//
// This used to accept ANY member holding a role literally named 'MODERATOR' —
// the obvious name to give a community helper. That role could then run
// `/config set setting:btcxpub value:<their own xpub>` and redirect every
// crypto payment the store receives, or `/web-balance adjust` to mint credit,
// or `/order forceconfirm` to deliver an unpaid order. A role NAME is not a
// permission: anyone who can create or rename a role can grant it.
//
// Now: Administrator, or one of THIS guild's staff roles by id. The name check
// is kept only as a last-resort bootstrap when no id is configured anywhere,
// and it warns loudly so it gets fixed.
// ─── Server snapshot restore ─────────────────────────────────────────────────
//
// Runs after the confirm button. Everything here is additive: roles and
// channels are matched by name and updated in place, missing ones are created,
// and NOTHING is ever deleted. A "restore" that wipes first is one mistyped
// snapshot id away from being the disaster it exists to protect against.
//
// The other rule that shapes this: one bad entry must never fail the job.
// Someone running this is usually rebuilding a server that is already gone,
// and "12 of 40 channels, then an error" is the worst outcome available. Every
// step is caught individually and the failures are reported at the end.
//
// The confirmation screen, built in one place because it is rendered twice:
// once by `/serverbackup restore`, and again every time the what-to-restore
// dropdown is touched. Re-planning against the live guild on each change costs
// a fetch and buys the numbers being true for the CURRENT selection — a plan
// that still says "create 66 channels" after unticking channels is worse than
// no plan at all.
//
// Nothing is remembered between the two: the choice rides in the button's
// customId, so a confirmation left open across a restart still works.
async function buildRestoreConfirm(guild, row, snapId, allowOther, parts) {
  const sel = serverBackup.normalizeParts(parts);
  const snap = row.data;

  await guild.roles.fetch();
  await guild.channels.fetch();
  const liveRoles = [...guild.roles.cache.values()];
  const liveChannels = [...guild.channels.cache.values()].filter(c => !serverBackup.THREAD_TYPES.has(c.type));
  const catNameOf = (c) => {
    const p = c.parentId ? guild.channels.cache.get(c.parentId) : null;
    return p ? p.name : null;
  };
  const rolePlan = serverBackup.planRoles(snap, liveRoles);
  const chanPlan = serverBackup.planChannels(snap, liveChannels, catNameOf);
  const lines = serverBackup.describePlan(rolePlan, chanPlan, snap, sel);
  const warnings = serverBackup.partWarnings(sel);

  // "Nothing is ever deleted" is a promise about channels and roles still
  // being there afterwards. It says nothing about what they can DO, and a
  // restore rolls permissions back to the snapshot like everything else. That
  // is the half nobody pictures, so it is counted and named here.
  const me = guild.members.me || await guild.members.fetchMe();
  const losses = sel.includes('roles') ? serverBackup.permissionLosses(rolePlan, me.permissions.bitfield) : [];

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle('⚠️ Restore — read this first')
    .setDescription(`Snapshot \`${snapId}\` from **${row.guild_name}**\ninto **${guild.name}**`
      // Same-server is the ordinary case; the other one deserves saying out
      // loud rather than living in a command option nobody re-reads.
      + (row.guild_id === guild.id ? '' : '\n\n🛑 **This snapshot was taken in a DIFFERENT server.**'))
    .addFields(
      { name: 'Restoring', value: sel.length
        ? sel.map(k => `${serverBackup.PART[k].emoji} ${serverBackup.PART[k].label}`).join(' · ')
        : '_nothing selected_' },
      { name: 'What will happen', value: lines.map(l => `• ${l}`).join('\n').slice(0, 1024) },
    );
  if (warnings.length) {
    embed.addFields({ name: 'What that leaves out', value: warnings.map(w => `• ${w}`).join('\n').slice(0, 1024) });
  }
  if (losses.length) {
    const shown = losses.slice(0, 12).map(l => {
      const names = serverBackup.namePermissions(l.lost, PermissionFlagsBits);
      const head = names.slice(0, 6).join(', ');
      return `• **${l.name}** loses ${head}${names.length > 6 ? ` +${names.length - 6} more` : ''}`;
    });
    if (losses.length > shown.length) shown.push(`_…and ${losses.length - shown.length} more role(s)._`);
    embed.addFields({
      name: `🛑 ${losses.length} role(s) will LOSE permissions`,
      value: `${shown.join('\n')}\n\nThe snapshot does not have these, so restoring takes them away. Untick 🎭 Roles if that is not what you meant.`.slice(0, 1024),
    });
  }
  embed.setFooter({ text: 'Matching is by name. Existing roles and channels are updated in place — nothing is deleted.' });

  const tag = `${snapId}::${allowOther ? '1' : '0'}`;
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`sbparts::${tag}`)
        .setPlaceholder('What do you want to restore?')
        .setMinValues(1)
        .setMaxValues(serverBackup.PART_KEYS.length)
        .addOptions(serverBackup.PART_KEYS.map(k => ({
          label: serverBackup.PART[k].label,
          value: k,
          emoji: serverBackup.PART[k].emoji,
          description: serverBackup.PART[k].hint.slice(0, 100),
          default: sel.includes(k),
        })))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sbrestore::${tag}::${serverBackup.encodeParts(sel)}`)
          .setLabel(sel.length === serverBackup.PART_KEYS.length ? 'Restore everything' : `Restore ${sel.length} selected`)
          .setStyle(ButtonStyle.Danger).setDisabled(!sel.length),
        new ButtonBuilder().setCustomId('sbrestore_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

//
// `parts` is which of the five things the operator ticked — roles, categories,
// channels, permission rules, emojis. Null means all of them, which is what a
// restore was before the selector existed and what an old button still means.
async function runRestore(interaction, snapId, allowOther, parts) {
  const guild = interaction.guild;
  const sel = serverBackup.normalizeParts(parts);
  const on = (k) => sel.includes(k);
  if (!sel.length) {
    return interaction.update({ embeds: [], components: [], content: 'Nothing was selected, so nothing was changed.' });
  }
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('⏳ Restoring…')
      .setDescription(`Restoring **${sel.map(k => serverBackup.PART[k].label.toLowerCase()).join('**, **')}**. This can take a minute.`)],
    components: [],
  });

  const problems = [];
  const note = (what, err) => {
    problems.push(`${what}: ${err && err.message ? err.message : err}`);
    console.warn('[ServerBackup]', what, '-', err && err.message);
  };

  try {
    const { rows } = await db.query('SELECT * FROM guild_snapshots WHERE id = $1', [snapId]);
    const row = rows[0];
    if (!row) return interaction.editReply({ embeds: [], content: `❌ Snapshot \`${snapId}\` is gone.` });
    if (row.guild_id !== guild.id && !allowOther) {
      return interaction.editReply({ embeds: [], content: '❌ That snapshot belongs to another server.' });
    }
    const snap = row.data;

    await guild.roles.fetch();
    await guild.channels.fetch();

    // What the BOT can grant. Discord rejects the whole request when asked for
    // a permission the actor does not hold, so one missing bit would otherwise
    // fail an entire role rather than just that bit.
    //
    // Read it exactly as Discord does. A bot with ADMINISTRATOR holds every
    // permission there is and its bitfield has ONE bit set, so the bitwise
    // AND below zeroed every role that was not itself an administrator — the
    // most privileged bot possible stripped the server bare and called it
    // "permissions the bot could not grant". serverBackup.maskPermissions now
    // treats that bit as "no mask"; this stays a plain read so there is one
    // place that decides.
    const me = guild.members.me || await guild.members.fetchMe();
    const botPerms = me.permissions.bitfield;

    // ── Roles ──
    // Highest first, so Discord's own clamping (nothing above the bot's top
    // role) at least preserves the relative order of what it can place.
    //
    // The PLAN is built whether or not roles were ticked, and that is the
    // point: it is also the old-id → new-id table every permission rule is
    // remapped through. Restoring "permissions but not roles" still has to
    // find the roles that are already here, by name — the alternative is
    // dropping every rule in the snapshot and calling it a success.
    const rolePlan = serverBackup.planRoles(snap, [...guild.roles.cache.values()]);
    const idMap = new Map();
    let rolesMade = 0, rolesUpdated = 0;
    const permsDropped = new Set();

    for (const { from, to, everyone } of rolePlan.update) {
      idMap.set(from.id, to.id);
      if (!on('roles')) continue;
      // `to.permissions` — what the role has now. Passing it is what stops a
      // permission the bot cannot write from being CLEARED rather than left
      // alone. Without it this loop took every permission off every role it
      // touched.
      const { granted, missing } = serverBackup.maskPermissions(from.permissions, botPerms, to.permissions.bitfield);
      if (BigInt(missing)) serverBackup.namePermissions(missing, PermissionFlagsBits).forEach(p => permsDropped.add(p));
      try {
        // @everyone has no colour, no hoist and no mentionable to speak of —
        // sending them is a 400 on some API versions and meaningless on all.
        await to.edit(everyone
          ? { permissions: granted }
          : { name: from.name, color: from.color, hoist: from.hoist, mentionable: from.mentionable, permissions: granted });
        rolesUpdated++;
      } catch (err) { note(`role "${from.name}"`, err); }
    }

    // A role that is not here and is not being created stays out of the id
    // table, so the rules naming it are dropped and counted rather than aimed
    // at whatever that id means in this server.
    for (const from of (on('roles') ? rolePlan.create : [])) {
      const { granted, missing } = serverBackup.maskPermissions(from.permissions, botPerms);
      if (BigInt(missing)) serverBackup.namePermissions(missing, PermissionFlagsBits).forEach(p => permsDropped.add(p));
      try {
        const made = await guild.roles.create({
          name: from.name, color: from.color, hoist: from.hoist,
          mentionable: from.mentionable, permissions: granted,
          reason: `Snapshot ${snapId} restore by ${interaction.user.tag}`,
        });
        idMap.set(from.id, made.id);
        rolesMade++;
      } catch (err) { note(`role "${from.name}"`, err); }
    }

    // ── Channels ──
    // Rebuilt after the roles on purpose: a channel's permission overwrites
    // are written in terms of role ids, and a role that does not exist yet
    // cannot be referenced. Doing it the other way round produces channels
    // with no permissions on them, which reads as a successful restore and is
    // the exact state that makes a private channel public.
    const chanPlan = serverBackup.planChannels(snap, [...guild.channels.cache.values()]
      .filter(c => !serverBackup.THREAD_TYPES.has(c.type)),
      (c) => { const p = c.parentId ? guild.channels.cache.get(c.parentId) : null; return p ? p.name : null; });

    const memberHere = (id) => guild.members.cache.has(id);
    const catByName = new Map();
    for (const c of guild.channels.cache.values()) {
      if (c.type === serverBackup.CH.GuildCategory && !catByName.has(c.name)) catByName.set(c.name, c.id);
    }
    for (const { from, to } of chanPlan.update) {
      if (from.type === serverBackup.CH.GuildCategory) catByName.set(from.name, to.id);
    }

    let chansMade = 0, chansUpdated = 0, owDropped = 0, owUnsafe = 0;
    const overwritesFor = (ch) => {
      const { kept, dropped } = serverBackup.remapOverwrites(ch.overwrites, idMap, memberHere);
      owDropped += dropped.length;
      const out = [];
      for (const o of kept) {
        // A rule the bot cannot write in full is skipped, not trimmed. Trimming
        // an ALLOW closes a channel further; trimming a DENY OPENS one, and the
        // result reads as a rule that was applied.
        const m = serverBackup.maskOverwrite(o, botPerms);
        if (m.unsafe) { owUnsafe++; continue; }
        out.push({ id: m.id, allow: m.allow, deny: m.deny });
      }
      return out;
    };

    // Which of the two channel kinds the operator asked for. A category is a
    // channel to Discord and a heading to everyone else, and they are ticked
    // separately because "put my categories back" and "put my 66 channels
    // back" are different sizes of decision.
    const wanted = (c) => (c.type === serverBackup.CH.GuildCategory ? on('categories') : on('channels'));

    for (const { from, to } of chanPlan.update) {
      if (!wanted(from)) continue;
      try {
        // permissionOverwrites.set REPLACES the channel's overwrites with this
        // list. That is intended — the snapshot IS the intended permission
        // state — but it is also the one place in this whole feature that
        // removes anything, which is exactly why it is its own tick box. With
        // permission rules unticked the call is not made at all: passing the
        // empty list would clear the channel instead of leaving it alone.
        if (on('permissions')) {
          await to.permissionOverwrites.set(overwritesFor(from), `Snapshot ${snapId} restore`);
        }
        if (from.topic != null && 'setTopic' in to) { try { await to.setTopic(from.topic); } catch (_) {} }
        chansUpdated++;
      } catch (err) { note(`channel "#${from.name}"`, err); }
    }

    for (const ch of chanPlan.create) {
      if (!wanted(ch)) continue;
      try {
        const parentId = ch.parentName ? (catByName.get(ch.parentName) || null) : null;
        const payload = serverBackup.channelCreatePayload(ch, parentId, on('permissions') ? overwritesFor(ch) : []);
        payload.reason = `Snapshot ${snapId} restore by ${interaction.user.tag}`;
        const made = await guild.channels.create(payload);
        if (ch.type === serverBackup.CH.GuildCategory) catByName.set(ch.name, made.id);
        chansMade++;
      } catch (err) { note(`channel "#${ch.name}"`, err); }
    }

    // ── Emojis ──
    // Re-uploaded from the source guild's CDN URL, which is public and does
    // not expire the way a message attachment does. Best-effort: a full emoji
    // slot list is a limit, not an error worth stopping for.
    let emojisMade = 0;
    const haveEmoji = new Set([...guild.emojis.cache.values()].map(e => e.name));
    for (const e of (on('emojis') ? (snap.emojis || []) : [])) {
      if (haveEmoji.has(e.name)) continue;
      try { await guild.emojis.create({ attachment: e.url, name: e.name }); emojisMade++; }
      catch (err) { note(`emoji :${e.name}:`, err); break; }   // out of slots — the rest will fail the same way
    }

    const out = new EmbedBuilder()
      .setColor(problems.length ? 0xffa500 : 0x00d26a)
      .setTitle(problems.length ? '⚠️ Restore finished with some skips' : '✅ Restore finished')
      .setDescription(`Snapshot \`${snapId}\` → **${guild.name}**`);
    // Only what was asked for. A "Roles: 0 created · 0 updated" line under a
    // channels-only restore reads as a failure rather than as a choice.
    if (on('roles')) out.addFields({ name: '🎭 Roles', value: `${rolesMade} created · ${rolesUpdated} updated`, inline: true });
    if (on('categories') || on('channels')) {
      out.addFields({ name: '💬 Channels', value: `${chansMade} created · ${chansUpdated} updated`, inline: true });
    }
    if (on('emojis')) out.addFields({ name: '😀 Emojis', value: `${emojisMade} added`, inline: true });
    // Named, so a restore run twice with different ticks is readable after the
    // fact — the embed is the only record of which one this was.
    out.addFields({ name: 'Restored', value: sel.map(k => serverBackup.PART[k].label).join(' · ') });
    if (!on('permissions') && (on('channels') || on('categories'))) {
      out.addFields({ name: 'Permission rules were not restored',
        value: 'Every channel kept the permissions it already had — this run only created what was missing and wrote topics.' });
    }
    if (permsDropped.size) {
      // Named, not counted. "Two permissions were dropped" sends someone
      // hunting; the list tells them whether it mattered.
      out.addFields({ name: 'Permissions the bot could not grant',
        value: `The bot does not hold these itself, so they were left off:\n\`${[...permsDropped].join('`, `').slice(0, 900)}\`` });
    }
    if (owDropped) {
      out.addFields({ name: 'Permission rules dropped', value:
        `${owDropped} rule(s) pointed at a role or member that does not exist here. Applying them to whatever those ids mean in this server is how a restore locks people out, so they were skipped.` });
    }
    if (owUnsafe) {
      out.addFields({ name: 'Permission rules the bot could not write in full', value:
        `${owUnsafe} rule(s) DENY something this bot cannot deny itself. Writing the rest of the rule would have left the channel more open than the snapshot, so they were skipped whole. Give the bot those permissions and run it again.` });
    }
    if (problems.length) {
      out.addFields({ name: `Skipped (${problems.length})`, value: problems.slice(0, 8).join('\n').slice(0, 1024) });
    }
    out.setFooter({ text: 'Nothing was deleted.' }).setTimestamp();
    return interaction.editReply({ embeds: [out], components: [] });
  } catch (err) {
    console.error('[ServerBackup] restore failed:', err);
    return interaction.editReply({
      embeds: [], components: [],
      content: `❌ Restore stopped: ${err.message}\n\nAnything already created is still there — nothing was deleted.`,
    });
  }
}

function hasAccess(interaction) {
  const member = interaction.member;
  if (!member || !interaction.guild) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const staffRoleIds = staffRoleIdsFor(interaction.guild.id);
  if (staffRoleIds.length) return staffRoleIds.some(id => member.roles.cache.has(id));

  if (member.roles.cache.some(r => r.name === 'MODERATOR')) {
    console.warn('[Access] Granted by ROLE NAME "MODERATOR" — set STAFF_ROLE_ID to a role id; a name is not a permission.');
    return true;
  }
  return false;
}

// The role a verified buyer gets, BY ID.
//
// This used to be `roles.cache.find(r => r.name === 'Customer')` with a
// `roles.create()` fallback, and it failed in both ways a name lookup can. The
// role that actually marks a paying customer in this server is named
// "🤝 Real One"; nothing was named 'Customer', so every claim fell through to
// the fallback and the bot MANUFACTURED a role called 'Customer' at the bottom
// of the hierarchy — a role that grants no channel access, carries no
// permissions, and is not what any of the server's overwrites are written
// against. The claim then reported success.
//
// So: resolve by id, and never create. A role the bot invents is by
// construction not the role the server was built around, and handing someone a
// decoy is worse than telling them the feature is misconfigured.
//
// Async now, and per-guild. A role id belongs to exactly one server — the same
// "Customer" role has a different id in each — so the single env var could only
// ever be right for one of them. On the other server the id is simply absent,
// which sent every claim down the name fallback and, before that fallback was
// hardened, straight into manufacturing a decoy role.
const CUSTOMER_ROLE_ID_FALLBACK = '1242149583228768306'; // 🤝 Real One
async function resolveCustomerRole(guild) {
  let fromPanel = null;
  try {
    fromPanel = (await getGuildSettings(guild.id)).customerRoleId;
  } catch (e) {
    console.error('[Customer] settings read failed:', e.message);
  }
  const id = fromPanel || process.env.CUSTOMER_ROLE_ID || CUSTOMER_ROLE_ID_FALLBACK;
  const byId = guild.roles.cache.get(String(id));
  if (byId) return byId;
  // Only if the configured id is absent from THIS guild — a name is a last
  // resort, and it warns rather than pretending it is equivalent.
  const name = process.env.CUSTOMER_ROLE_NAME;
  if (name) {
    console.warn(`[Customer] Role id ${id} not found in ${guild.id}; falling back to the name "${name}". Set the customer role for this server in the panel.`);
    return guild.roles.cache.find(r => r.name === name) || null;
  }
  console.warn(`[Customer] Role id ${id} not found in guild ${guild.id} — set the customer role for this server in the panel.`);
  return null;
}

// Returns null on success, or a human-readable reason on failure.
//
// Adding a role fails for reasons the person clicking needs to hear, and the
// loudest one is hierarchy: Discord requires the bot's own highest role to sit
// strictly ABOVE the role it hands out, and Administrator does not exempt it.
// The old code swallowed the throw with `.catch(() => {})` and posted "✅ Role
// Added" regardless — a claim that granted nothing was indistinguishable from
// one that worked.
//
// There are TWO hierarchy rules, not one, and only the first was ever checked:
//
//   1. the bot's highest role must be above THE ROLE being handed out, and
//   2. the bot's highest role must be above THE MEMBER'S OWN highest role.
//
// Rule 2 is the one that broke verification on the second server. `ONTOP AIO`
// sits at position 6 there, while the server's older 𝑽𝑬𝑹𝑰𝑭𝑰𝑬𝑫 role — which
// nearly every human already holds — sits at 7. Handing out a role at
// position 2 passes rule 1 and still fails, because Discord will not let a bot
// touch a member who outranks it at all. The role is low, the member is high,
// and the error text ("Missing Permissions") names neither. Nobody was ever
// going to guess that from "❌ Something went wrong."
//
// The guild OWNER is unmanageable by anyone, bot or not, at any position.
async function assignRole(member, role, reason) {
  const me = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
  if (!me) return 'I could not read my own permissions in this server.';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I do not have the **Manage Roles** permission.';
  if (role.managed) return `**${role.name}** is managed by an integration, so Discord will not let anyone assign it.`;
  if (member.roles.cache.has(role.id)) return null; // already held — nothing to do
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return `my highest role (**${me.roles.highest.name}**) is below **${role.name}** in the role list, so Discord refuses the assignment. An admin needs to drag my role above it in Server Settings → Roles.`;
  }
  if (member.id === member.guild.ownerId) {
    return 'you own this server, and Discord does not let a bot change the owner\'s roles. Add it to yourself by hand.';
  }
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return `your highest role (**${member.roles.highest.name}**) is above mine (**${me.roles.highest.name}**), and Discord will not let a bot change the roles of anyone who outranks it — even with Administrator. An admin needs to drag **${me.roles.highest.name}** above **${member.roles.highest.name}** in Server Settings → Roles.`;
  }
  try {
    await member.roles.add(role, reason || 'Automated role grant');
    return null;
  } catch (err) {
    // The five checks above cover every cause we can name. Anything reaching
    // here is worth a stack in the log, because the next person debugging it
    // has nothing else to go on.
    console.error(`[roles] add failed in ${member.guild.id}: ${role.name} -> ${member.user?.tag || member.id}:`, err.stack || err);
    return err.message || 'Discord refused the role assignment.';
  }
}

function grantCustomerRole(member, role) {
  return assignRole(member, role, 'Verified paid order');
}

// Round 29 item 6: "If user has not made an account and no email found. Have it
// register with their discord account then. So they can redeem. So order can be
// looked up by user also!!"
//
// Both claim paths — the /claim-customer command and the panel modal — now go
// through here, because a claim does three things and only one of them used to
// happen. It granted a role; the order itself was left unattached, so it showed
// up in no list the buyer could open, and a buyer with no site account had no
// list to open in the first place.
//
// POST /api/orders/claim proves ownership, creates the account from the Discord
// identity if there is none, and attaches this order plus every other unowned
// order carrying the same snowflake. The role is added AFTER it returns, so a
// backend failure never leaves someone holding a role for an order that was not
// attached.
//
// `email` is optional now. An order delivered by staff through
// /manual-order-delivery can carry no address at all, which made the required
// field impossible to satisfy and the order impossible to claim — even though
// the Discord account named on it was already accepted as proof.
//
// `member` is who the claim is FOR, which on the staff path is not the caller.
async function claimOrderFor(member, order_id, email) {
  const res = await axios.post(`${BACKEND_URL}/api/orders/claim`, {
    secret: API_SECRET,
    order_id,
    email: email || null,
    discord_id: member.id,
    // The account is created from these when there is none. global_name is the
    // display name; `username` is the handle, and one of the two always exists.
    discord_username: member.user?.globalName || member.user?.username || null,
    discord_avatar: member.user?.avatar || null,
  });
  return res.data;
}

// The refusal a failed claim should read as. Kept next to the call because the
// useful message depends on WHY it failed, and "that email does not match" is
// nonsense advice for an order that has no email on it to match against.
function claimRefusal(v, order_id, extra = '') {
  const label = v.invoice_no || order_id;
  if (!v.paid) return `❌ Invoice \`${label}\` is **${v.status}** — only paid/delivered orders qualify.`;
  if (!v.has_email) {
    return `❌ Invoice \`${label}\` was delivered by staff and carries no email address, so it can only be claimed`
      + ` by the Discord account it was delivered to.${extra}`;
  }
  const hint = v.email_hint ? ` The address on this order looks like \`${v.email_hint}\`.` : '';
  return `❌ That email does not match invoice \`${label}\`.${hint}${extra}`;
}

// Stricter gate for the commands that can move money or repoint where money
// goes. /config writes BTC_XPUB, LTC_XPUB, PAYPAL_EMAIL, CASHAPP_CASHTAG and
// the Gmail credentials through the backend using the shared API_SECRET — that
// is owner-level authority, not staff-level.
function hasOwnerAccess(interaction) {
  const member = interaction.member;
  if (!member || !interaction.guild) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const owner = process.env.OWNER_DISCORD_ID;
  return !!(owner && String(interaction.user.id) === String(owner));
}

// Pack {name, value} fields into embeds that respect BOTH of Discord's limits:
// 25 fields per embed AND 6000 characters of total embed text. The vault grew
// from 13 products to ~90 when the site started auto-seeding its real catalog,
// and chunking on the field count alone produced a single 25-field embed that
// blew the 6000-char cap ("MAX_EMBED_SIZE_EXCEEDED").
//
// A single field's value is also capped at 1024 chars, so an over-long category
// is split across repeated fields ("VPN (cont.)") rather than truncated — the
// old .slice(0, 1024) silently dropped products off the end of big categories.
function packEmbedFields(fields, color, budget = 5000) {
  const MAX_FIELDS = 25, MAX_VALUE = 1024;

  const split = [];
  for (const f of fields) {
    const lines = String(f.value).split('\n');
    let buf = '', part = 0;
    for (const line of lines) {
      // +1 for the newline we'd add. A single line longer than MAX_VALUE is
      // hard-truncated; nothing we render comes close.
      if (buf && buf.length + 1 + line.length > MAX_VALUE) {
        split.push({ name: part === 0 ? f.name : `${f.name} (cont.)`, value: buf, inline: false });
        part++; buf = line.slice(0, MAX_VALUE);
      } else {
        buf = buf ? buf + '\n' + line : line.slice(0, MAX_VALUE);
      }
    }
    split.push({ name: part === 0 ? f.name : `${f.name} (cont.)`, value: buf || '—', inline: false });
  }

  const embeds = [];
  let cur = [], size = 0;
  const flush = () => {
    if (!cur.length) return;
    embeds.push(new EmbedBuilder().setColor(color).addFields(cur));
    cur = []; size = 0;
  };
  for (const f of split) {
    const cost = f.name.length + f.value.length;
    if (cur.length >= MAX_FIELDS || (cur.length && size + cost > budget)) flush();
    cur.push(f); size += cost;
  }
  flush();
  return embeds;
}

// Discord also caps a single message at 10 embeds.
async function sendEmbedBatches(channel, header, embeds) {
  const all = [header, ...embeds];
  for (let i = 0; i < all.length; i += 10) {
    await channel.send({ embeds: all.slice(i, i + 10) });
  }
}

// ─── Live status panel ───────────────────────────────────────────────────────
// /post-status used to render the statuses once and leave. The message was
// then wrong from the first change onward, and the only way to correct it was
// to post the whole thing again — which is what the admin asked not to have to
// do. The panel now edits itself instead.
//
// Discord caps a message at 10 embeds, so a panel is usually several messages.
// All of them are tracked, because a status can move between games and change
// which message it lands in.
const STATUS_PANEL_REFRESH_MS = Number(process.env.STATUS_REFRESH_MS) || 5 * 60 * 1000;
const STATUS_EMOJI = {
  undetected: { emoji: '🟢', label: 'UNDETECTED' },
  testing:    { emoji: '🧪', label: 'TESTING' },
  updating:   { emoji: '🔵', label: 'UPDATING' },
  detected:   { emoji: '🔴', label: 'DETECTED' },
};

// The last content we rendered, so a refresh that would change nothing costs
// no API calls. Reset on boot, which means the first tick after a restart
// always writes once — correct after downtime, and cheap.
//
// Keyed by guild: the panel is per server, so "unchanged since I last wrote it"
// has to be asked per server too. A single variable meant the second server's
// first refresh saw the first server's signature and skipped the write.
const statusPanelSignatures = new Map();

// Both /post-status and the refresher build from here, so what the timer
// writes can never drift from what the command posted.
async function buildStatusPanel() {
  const res = await axios.get(`${BACKEND_URL}/api/status`);
  const raw = Array.isArray(res.data) ? res.data : (res.data.statuses || []);
  // Respect the site's admin hide-map so Discord stays in sync with the page
  let hidden = {};
  try {
    const hs = await axios.get(`${BACKEND_URL}/api/state/global/ghostStatusHidden`);
    hidden = (hs.data && hs.data.value) || {};
  } catch (e) { /* no hide-map yet — show all */ }
  const rows = raw.filter(r => !hidden[String(r.product_id)] && !isNonStatusCategory(r.game_name));
  if (!rows.length) return null;

  const byGame = {};
  rows.forEach(r => {
    const g = r.game_name || 'Other';
    (byGame[g] = byGame[g] || []).push(r);
  });
  const counts = { undetected: 0, testing: 0, updating: 0, detected: 0 };
  rows.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });

  const fields = Object.keys(byGame).sort().map(game => ({
    name: game,
    value: byGame[game].map(r => {
      const s = STATUS_EMOJI[r.status] || { emoji: '⚪', label: (r.status || '?').toUpperCase() };
      const note = r.note ? ` — _${r.note}_` : '';
      return `${s.emoji} **${r.product_name}** · ${s.label}${note}`;
    }).join('\n'),
    inline: false,
  }));

  const header = new EmbedBuilder()
    .setColor(0x00ff88)
    .setTitle('📊 PRODUCT STATUS')
    .setDescription(`🟢 ${counts.undetected} Undetected  •  🧪 ${counts.testing} Testing  •  🔵 ${counts.updating} Updating  •  🔴 ${counts.detected} Detected`)
    .setFooter({ text: `${BOT_NAME}${SITE_URL ? ' | ' + SITE_URL : ''} • updates automatically`, iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  const all = [header, ...packEmbedFields(fields, 0x00ff88)];
  const messages = [];
  for (let i = 0; i < all.length; i += 10) messages.push(all.slice(i, i + 10));

  // Deliberately NOT built from the rendered embeds: those carry a timestamp
  // that changes every build, which would make every tick look like a change
  // and edit the panel forever.
  const signature = JSON.stringify(rows.map(r => [r.product_id, r.status, r.note || '']));
  return { messages, signature, count: rows.length };
}

// One panel PER GUILD. It used to be one panel full stop — a single `status`
// key holding one channel id and one message list — so running /post-status on
// the second server found the first server's panel sitting in that key, took it
// down as "the previous one", and overwrote the key. Two servers could never
// hold a panel at the same time, and the one that lost it never got an error.
//
// `kind` is a free-form key in a JSON blob on the backend, so making it
// `status:<guildId>` needs no route change and no migration.
const LEGACY_STATUS_KIND = 'status';
const statusKind = (guildId) => `${LEGACY_STATUS_KIND}:${guildId}`;

async function loadStatusPanels() {
  try {
    const r = await axios.get(`${BACKEND_URL}/api/status/panel`,
      { params: { secret: API_SECRET, kind: LEGACY_STATUS_KIND }, timeout: 10000 });
    return (r.data && r.data.panels) || {};
  } catch (err) {
    console.warn('[Status] could not load the panel references:', err.message);
    return null;
  }
}

async function loadStatusPanelRef(guildId) {
  const panels = await loadStatusPanels();
  if (!panels) return null;
  return panels[statusKind(guildId)] || null;
}

async function saveStatusPanelRef(guildId, channelId, messageIds) {
  try {
    await axios.post(`${BACKEND_URL}/api/status/panel`, {
      secret: API_SECRET, kind: statusKind(guildId),
      channel_id: channelId || null, message_ids: messageIds || [],
    }, { timeout: 10000 });
  } catch (err) {
    console.warn('[Status] could not save the panel reference:', err.message);
  }
}

// The panel that was posted before this was per-guild lives under the bare
// `status` key with no record of which server it is in. The channel knows, so
// ask it once and file the panel where it belongs. Deliberately NOT assumed to
// be the main guild: guessing wrong would adopt one server's panel into
// another and then edit it there forever.
async function adoptLegacyStatusPanel(panels) {
  const legacy = panels[LEGACY_STATUS_KIND];
  if (!legacy || !legacy.channel_id) return;
  let guildId = null;
  try {
    const ch = await client.channels.fetch(legacy.channel_id);
    guildId = ch && ch.guildId;
  } catch (_) { /* channel gone — drop the key below either way */ }

  if (guildId && !panels[statusKind(guildId)]) {
    panels[statusKind(guildId)] = legacy;
    await saveStatusPanelRef(guildId, legacy.channel_id, legacy.message_ids || []);
    console.log(`[Status] adopted the old shared panel into guild ${guildId}`);
  }
  delete panels[LEGACY_STATUS_KIND];
  try {
    await axios.post(`${BACKEND_URL}/api/status/panel`,
      { secret: API_SECRET, kind: LEGACY_STATUS_KIND, channel_id: null, message_ids: [] }, { timeout: 10000 });
  } catch (_) { /* it will be retried next tick */ }
}

// `force` skips the unchanged-check — used right after something writes a
// status, where the whole point is to show the change immediately.
//
// Every guild that has a panel gets refreshed, and one guild failing must not
// stop the next: they are separate servers, and a channel deleted on one says
// nothing about the other.
async function refreshStatusPanel({ force = false } = {}) {
  if (!API_SECRET) return;
  const panels = await loadStatusPanels();
  if (!panels) return;
  await adoptLegacyStatusPanel(panels);

  const targets = Object.keys(panels)
    .filter(k => k.startsWith(`${LEGACY_STATUS_KIND}:`))
    .map(k => ({ guildId: k.slice(LEGACY_STATUS_KIND.length + 1), ref: panels[k] }))
    .filter(t => t.ref && t.ref.channel_id && (t.ref.message_ids || []).length);
  if (!targets.length) return;

  let built;
  try { built = await buildStatusPanel(); } catch (err) {
    console.warn('[Status] panel refresh skipped:', err.message);
    return;
  }
  // No rows is not the same as "clear the panel" — it is almost always the
  // backend being briefly unreachable, and blanking a public channel over a
  // hiccup is worse than showing a slightly stale list.
  if (!built) return;

  for (const { guildId, ref } of targets) {
    try {
      await refreshOneStatusPanel(guildId, ref, built, force);
    } catch (err) {
      console.warn(`[Status] panel refresh failed for guild ${guildId}:`, err.message);
    }
  }
}

async function refreshOneStatusPanel(guildId, ref, built, force) {
  if (!force && built.signature === statusPanelSignatures.get(guildId)) return;

  let channel;
  try {
    channel = await client.channels.fetch(ref.channel_id);
  } catch (err) {
    // Channel deleted or no longer visible — forget the panel rather than
    // failing on a timer forever.
    console.warn('[Status] panel channel is gone, forgetting it:', err.message);
    await saveStatusPanelRef(guildId, null, []);
    statusPanelSignatures.delete(guildId);
    return;
  }
  if (!channel || !channel.isTextBased?.()) return;

  const ids = [...ref.message_ids];
  const wanted = built.messages;

  for (let i = 0; i < Math.min(ids.length, wanted.length); i++) {
    try {
      const msg = await channel.messages.fetch(ids[i]);
      await msg.edit({ embeds: wanted[i] });
    } catch (err) {
      // 10008 Unknown Message — somebody deleted part of the panel. Drop the
      // whole reference: a half-edited panel is worse than none, and the admin
      // can re-run /post-status.
      if (err.code === 10008) {
        console.warn('[Status] part of the panel was deleted — forgetting it');
        await saveStatusPanelRef(guildId, null, []);
        statusPanelSignatures.delete(guildId);
        return;
      }
      throw err;
    }
  }

  // The catalog grew past what the existing messages hold.
  for (let i = ids.length; i < wanted.length; i++) {
    const sent = await channel.send({ embeds: wanted[i] });
    ids.push(sent.id);
  }
  // …or shrank. Leaving the surplus would strand a stale copy of statuses
  // that are now rendered above it.
  for (let i = wanted.length; i < ids.length; i++) {
    try { const m = await channel.messages.fetch(ids[i]); await m.delete(); } catch (_) {}
  }
  const finalIds = ids.slice(0, wanted.length);

  statusPanelSignatures.set(guildId, built.signature);
  if (finalIds.length !== ref.message_ids.length || finalIds.some((id, i) => id !== ref.message_ids[i])) {
    await saveStatusPanelRef(guildId, ref.channel_id, finalIds);
  }
}

// ─── Announced status → actual status ────────────────────────────────────────
// The update forms take a product name as free text, so it rarely matches the
// catalog exactly ("C0D B07 - H8ED EXTERNAL" for "H8ED Private External").
//
// The one thing this must never do is guess. A wrong match sets the WRONG
// product's status on the public website, which is worse than not syncing at
// all — nobody would be looking for it. So it matches only when the answer is
// unambiguous, and when it is not, it hands back the near misses for the
// admin to choose from rather than picking one.
function normProductName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

async function resolveStatusProduct(typed) {
  const res = await axios.get(`${BACKEND_URL}/api/status`, { timeout: 10000 });
  const raw = Array.isArray(res.data) ? res.data : (res.data.statuses || []);
  const rows = raw.filter(r => !isNonStatusCategory(r.game_name));
  const t = normProductName(typed);
  if (!t) return { match: null, candidates: [] };

  const exact = rows.filter(r =>
    normProductName(r.product_name) === t ||
    normProductName(`${r.game_name} ${r.product_name}`) === t);
  if (exact.length === 1) return { match: exact[0], candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact };

  // One name contained in the other — catches both the typed prefix
  // ("H8ED PRIVATE EXTERNAL" for "COD - H8ED Private External") and the typed
  // extra ("C0D B07 - H8ED PRIVATE EXTERNAL").
  const contains = rows.filter(r => {
    const p = normProductName(r.product_name);
    return p && (t.includes(p) || p.includes(t));
  });
  if (contains.length === 1) return { match: contains[0], candidates: [] };
  if (contains.length > 1) return { match: null, candidates: contains };

  // Nothing lined up. Offer the closest by shared words so the reply can say
  // what to retype — but do NOT treat these as a match.
  const words = t.split(' ').filter(w => w.length > 2);
  const scored = rows
    .map(r => ({ r, score: words.filter(w => normProductName(r.product_name).split(' ').includes(w)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  return { match: null, candidates: scored.map(x => x.r) };
}

// Notes from the form are deliberately NOT written to the status row. They are
// announcement copy — paragraphs, pings, "@everyone" — and the status panel
// renders its note inline next to the product name, where that would be a wall
// of text against every other product.
async function syncStatusToSite(typedProduct, statusKey) {
  if (!API_SECRET) return { ok: false, reason: 'the bot has no API_SECRET, so it cannot write to the site' };
  const site = (STATUS_TYPES[statusKey] || {}).site;
  if (!site) return { ok: false, reason: `“${statusKey}” has no matching website status` };

  let found;
  try { found = await resolveStatusProduct(typedProduct); }
  catch (err) { return { ok: false, reason: `the website was unreachable (${err.message})` }; }

  if (!found.match) {
    const near = found.candidates.length
      ? ` Did you mean: ${found.candidates.map(c => `**${c.product_name}**`).join(', ')}?`
      : '';
    return { ok: false, reason: `nothing on the website matched “${typedProduct}”.${near}` };
  }

  try {
    await axios.post(`${BACKEND_URL}/api/status/update`, {
      secret: API_SECRET, product_id: found.match.product_id, status: site,
    }, { timeout: 10000 });
  } catch (err) {
    return { ok: false, reason: err.response?.data?.error || err.message };
  }
  // Show it on the panel now rather than at the next tick — the announcement
  // and the panel sitting next to it disagreeing is the thing being fixed.
  refreshStatusPanel({ force: true }).catch(() => {});
  return { ok: true, product: found.match, site };
}

// One line appended to the command's own reply. A silent failure here would be
// the worst outcome: the admin would believe the site had been updated.
function describeSync(sync) {
  if (!sync) return '';
  if (sync.ok) return `\n🌐 Website status set to **${sync.site.toUpperCase()}** for \`${sync.product.product_name}\` — the status panel has been updated too.`;
  return `\n⚠️ **The website was NOT updated** — ${sync.reason}\nThe announcement above still posted. Fix it with \`/statusupdate\` or from the admin panel.`;
}

// Only true for the bot owner's own Discord account — used for commands
// that operate across every server the bot is in (list/leave a guild),
// not just the guild the command was run from. Set OWNER_DISCORD_ID in
// Railway to your own Discord user ID.
function isBotOwner(interaction) {
  return !!process.env.OWNER_DISCORD_ID && interaction.user.id === process.env.OWNER_DISCORD_ID;
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
// NFKD first, and that step is the whole reason the second server behaved as if
// none of these settings existed. Its channels are named in MATHEMATICAL BOLD —
// "📩︱𝐈𝐧𝐯𝐢𝐭𝐞𝐬", where 𝐈 is U+1D408, not the letter I. Those codepoints are
// letters as far as \p{L} is concerned and they survived the strip, but
// toLowerCase() has nothing to map them to, so the normalized name stayed
// "𝐈𝐧𝐯𝐢𝐭𝐞𝐬" and never equalled "invites". Every name-based fallback in the bot
// — welcome, verify, invites, the lot — silently resolved to nothing there.
// NFKD decomposes the whole mathematical-alphanumeric block back to ASCII.
//
// Hyphens and underscores go too, so "𝐈𝐍𝐕𝐈𝐓𝐄_𝐓𝐑𝐀𝐂𝐊𝐄𝐑" answers to
// "invite-tracker". A separator is a typographic choice, not an identity.
function normalizeChannelName(name) {
  return (name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')            // combining marks left behind by the decomposition
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');   // drops emoji, pipes, spaces, hyphens, underscores
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
  new SlashCommandBuilder().setName('testinvite').setDescription('Admin: fire a test join announcement through the real invite tracker')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('show-voucher-stats').setDescription('📊 Invite leaderboard — everybody\'s invite tracker stats')
    .addUserOption(o => o.setName('user').setDescription('Show one member\'s stats instead of the leaderboard').setRequired(false))
    .addBooleanOption(o => o.setName('public').setDescription('Post it in the channel for everyone (staff only)').setRequired(false)),
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 2d, 1w, 1mo').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners 1-5 (default 1)').setMinValue(1).setMaxValue(5).setRequired(false))
    .addStringOption(o => o.setName('image').setDescription('Image URL for the giveaway embed (optional)').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current)').setRequired(false)),
  new SlashCommandBuilder().setName('setupvouch').setDescription('Staff: Post the Leave a Vouch panel')
    .addStringOption(o => o.setName('channel').setDescription('Panel channel (defaults to #leave-vouch)').setRequired(false))
    .addStringOption(o => o.setName('results_channel').setDescription('Where received vouches post (defaults to #vouches)').setRequired(false)),
  new SlashCommandBuilder().setName('exportvouches').setDescription('Staff: Download a backup file of all vouches on this server'),
  new SlashCommandBuilder().setName('importvouches').setDescription('Staff: Restore vouches from a backup file, or from the website')
    // Not required any more: source:website needs no file at all, and that is
    // the path that matters if the old server is gone with its backup.
    .addStringOption(o => o.setName('source').setDescription('Where to import from (default: the attached file)').setRequired(false)
      .addChoices({ name: 'file — an /exportvouches backup', value: 'file' },
                  { name: 'website — every approved vouch in the store database', value: 'website' }))
    .addAttachmentOption(o => o.setName('file').setDescription('The vouches backup .json file (source: file)').setRequired(false))
    .addBooleanOption(o => o.setName('repost').setDescription('Repost each vouch as an embed in the vouches channel? (default: true)').setRequired(false)),
  new SlashCommandBuilder().setName('commands').setDescription('Show all available bot commands'),
  new SlashCommandBuilder().setName('addstock').setDescription('Staff: Add accounts to stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('type').setDescription('steam | phone-verified | activision | email-outlook | 5m-bundle (blank = steam)').setRequired(false))
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file, one account per line').setRequired(false))
    .addStringOption(o => o.setName('accounts').setDescription('Paste accounts here (one per line) if not using a file').setRequired(false)),
  new SlashCommandBuilder().setName('stock').setDescription('Check how much stock is available'),
  new SlashCommandBuilder().setName('gensteam').setDescription('Generate an account')
    .addStringOption(o => o.setName('type').setDescription('steam | phone-verified | activision | email-outlook | 5m-bundle (blank = steam)').setRequired(false)),
  new SlashCommandBuilder().setName('postgensteam').setDescription('Staff: Post the Steam account generator panel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('clearstock').setDescription('Staff: Remove stock accounts (fix a bad upload)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm — this cannot be undone').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Account type to clear. Leave blank to clear ALL types').setRequired(false)),
  new SlashCommandBuilder().setName('postusefullinks').setDescription('Staff: Post the full useful-links list in one go')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('addusefullink').setDescription('Staff: Add a link to the useful-links list')
    .addStringOption(o => o.setName('title').setDescription('Display title for the link').setRequired(true))
    .addStringOption(o => o.setName('url').setDescription('The URL').setRequired(true)),
  new SlashCommandBuilder().setName('removeusefullink').setDescription('Staff: Remove a link by its number (see /listusefullinks)')
    .addIntegerOption(o => o.setName('number').setDescription('The link number to remove').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('listusefullinks').setDescription('Staff: Preview the useful-links list with numbers (only you can see it)'),
  new SlashCommandBuilder().setName('clearusefullinks').setDescription('Staff: Clear the entire useful-links list')
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm — this cannot be undone').setRequired(true)),
  new SlashCommandBuilder().setName('importusefullinks').setDescription('Staff: Bulk add links — one per line, formatted "Title - https://url"')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file, one "Title - https://url" per line').setRequired(false))
    .addStringOption(o => o.setName('links').setDescription('Paste "Title - https://url" lines here if not using a file').setRequired(false))
    .addStringOption(o => o.setName('mode').setDescription('append (default) or replace the whole list').setRequired(false)
      .addChoices({ name: 'Append to current list', value: 'append' }, { name: 'Replace entire list', value: 'replace' })),
  new SlashCommandBuilder().setName('genkey').setDescription('Staff: Generate redeemable key(s) that grant a role for a set duration')
    .addRoleOption(o => o.setName('role').setDescription('Role the key grants').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('How long the role lasts').setRequired(true)
      .addChoices(
        { name: 'Lifetime',   value: 'lifetime' },
        { name: '1 Year',     value: '365d' },
        { name: '3 Months',   value: '90d' },
        { name: '1 Month',    value: '30d' },
        { name: '2 Weeks',    value: '14d' },
        { name: '3 Days',     value: '3d' },
        { name: '1 Day',      value: '1d' },
        { name: '5 Minutes (testing)', value: '5m' },
      ))
    .addIntegerOption(o => o.setName('amount').setDescription('How many keys to generate (default 1, max 25)').setRequired(false).setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a key to receive a role for a limited time')
    .addStringOption(o => o.setName('key').setDescription('Your key, e.g. UH-XXXX-XXXX-XXXX').setRequired(true)),
  new SlashCommandBuilder().setName('listkeys').setDescription('Staff: View unredeemed and active keys on this server'),
  new SlashCommandBuilder().setName('revokekey').setDescription('Staff: Revoke a key — removes the role immediately if already redeemed')
    .addStringOption(o => o.setName('key').setDescription('The key to revoke').setRequired(true)),
  new SlashCommandBuilder().setName('postredeem').setDescription('Staff: Post a button-based key redeem panel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('setupclaim').setDescription('Staff: Post the customer role claim panel (Invoice ID + Email → Customer role)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('set-tos').setDescription('Staff: Set the Terms of Service content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-rules').setDescription('Staff: Set the Rules content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-guide').setDescription('Staff: Set the Guide content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('set-payment-method').setDescription('Staff: Set the Payment Methods content')
    .addAttachmentOption(o => o.setName('file').setDescription('.txt file instead of typing in a popup form').setRequired(false)),
  new SlashCommandBuilder().setName('post-tos').setDescription('Staff: Post the Terms of Service')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-rules').setDescription('Staff: Post the Rules')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-guide').setDescription('Staff: Post the Guide')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  new SlashCommandBuilder().setName('post-payment-method').setDescription('Staff: Post the Payment Methods')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post in (defaults to current channel)').setRequired(false)),
  // Everyone, not staff: this is the customer telling us what to read to them.
  new SlashCommandBuilder().setName('language').setDescription('Choose the language the bot answers you in')
    .addStringOption(o => o.setName('language').setDescription('Your language / tu idioma / votre langue').setRequired(true)
      .addChoices(...translate.LANGS.map(l => ({ name: `${l.flag} ${l.native}`, value: l.code })))),
  new SlashCommandBuilder().setName('listguilds').setDescription('Owner only: List every server the bot is currently in'),
  new SlashCommandBuilder().setName('leaveguild').setDescription('Owner only: Make the bot leave a specific server')
    .addStringOption(o => o.setName('guild_id').setDescription('The server ID to leave (from /listguilds)').setRequired(true)),

  // ─── Server snapshots ──────────────────────────────────────────────────────
  // Administrator only, and not by convenience: `restore` can create every
  // role and channel in a snapshot, and `create` reads the whole permission
  // layout of the server into a row someone else could later restore
  // elsewhere. Both are things only the people who already run the server
  // should be able to do.
  new SlashCommandBuilder().setName('serverbackup').setDescription('Admin: Snapshot this server, or rebuild it from one')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('create').setDescription('Save this server\'s roles, channels and permissions as a snapshot')
      .addStringOption(o => o.setName('label').setDescription('What to call it — e.g. "before the rebrand"').setRequired(false)))
    .addSubcommand(sub => sub.setName('list').setDescription('List saved snapshots'))
    .addSubcommand(sub => sub.setName('view').setDescription('Show exactly what is inside a snapshot')
      .addStringOption(o => o.setName('id').setDescription('Snapshot ID (from /serverbackup list)').setRequired(true)))
    .addSubcommand(sub => sub.setName('restore').setDescription('Rebuild this server from a snapshot — pick what to put back, never deletes anything')
      .addStringOption(o => o.setName('id').setDescription('Snapshot ID (from /serverbackup list)').setRequired(true))
      // Cross-guild restore is the disaster case: the snapshot was taken in
      // the server that is now gone, and is being poured into a fresh one.
      .addBooleanOption(o => o.setName('allow_other_server').setDescription('Allow restoring a snapshot taken in a DIFFERENT server').setRequired(false)))
    .addSubcommand(sub => sub.setName('export').setDescription('Download a snapshot as a JSON file')
      .addStringOption(o => o.setName('id').setDescription('Snapshot ID (from /serverbackup list)').setRequired(true)))
    .addSubcommand(sub => sub.setName('delete').setDescription('Delete a saved snapshot')
      .addStringOption(o => o.setName('id').setDescription('Snapshot ID (from /serverbackup list)').setRequired(true))),

  // ─── Cross-server mirroring ────────────────────────────────────────────────
  // `follow` is listed first on purpose: for an announcement channel it is
  // strictly the better answer, because Discord does the delivery and there is
  // nothing to keep running. `add` is for everything it does not cover.
  new SlashCommandBuilder().setName('mirror').setDescription('Admin: Copy what this server posts into another server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('follow').setDescription('Announcement channels: let another server follow this one — no relay needed')
      .addChannelOption(o => o.setName('from').setDescription('The announcement channel here').setRequired(true))
      .addStringOption(o => o.setName('to_channel_id').setDescription('Channel ID in the other server').setRequired(true)))
    .addSubcommand(sub => sub.setName('add').setDescription('Relay a channel here into a channel in another server')
      .addChannelOption(o => o.setName('from').setDescription('The channel here to copy FROM').setRequired(true))
      .addStringOption(o => o.setName('to_channel_id').setDescription('Channel ID in the other server to copy INTO').setRequired(true))
      .addBooleanOption(o => o.setName('include_humans').setDescription('Also copy messages people write (default: bot posts only)').setRequired(false))
      .addBooleanOption(o => o.setName('include_other_bots').setDescription('Also copy other bots and webhooks (default: only my own posts)').setRequired(false))
      .addIntegerOption(o => o.setName('rate_per_min').setDescription('Pause the route above this many messages a minute (default 20)').setMinValue(1).setMaxValue(600).setRequired(false))
      .addBooleanOption(o => o.setName('allow_pings').setDescription('Let @everyone in a copied post ping the other server (default: no)').setRequired(false)))
    .addSubcommand(sub => sub.setName('list').setDescription('Show every relay set up from this server'))
    .addSubcommand(sub => sub.setName('remove').setDescription('Stop a relay')
      .addStringOption(o => o.setName('id').setDescription('Route ID (from /mirror list)').setRequired(true)))
    .addSubcommand(sub => sub.setName('resume').setDescription('Restart a route that was paused')
      .addStringOption(o => o.setName('id').setDescription('Route ID (from /mirror list)').setRequired(true)))
    // The 3am command. No IDs to read off a channel that is scrolling.
    .addSubcommand(sub => sub.setName('panic').setDescription('Stop EVERY relay arriving in this server, right now')
      .addBooleanOption(o => o.setName('outbound_too').setDescription('Also stop everything leaving this server').setRequired(false)))
    .addSubcommand(sub => sub.setName('block').setDescription('Refuse all mirrors from a server, now and in future')
      .addStringOption(o => o.setName('guild_id').setDescription('The server ID to block').setRequired(true)))
    .addSubcommand(sub => sub.setName('unblock').setDescription('Allow mirrors from a server again')
      .addStringOption(o => o.setName('guild_id').setDescription('The server ID to unblock').setRequired(true)))
    .addSubcommand(sub => sub.setName('test').setDescription('Send a test post down every relay from a channel')
      .addChannelOption(o => o.setName('from').setDescription('The source channel to test').setRequired(true))),

  // ─── Shop payment backend (ported from p-bot) ──────────────────────────────
  new SlashCommandBuilder().setName('config').setDescription('Staff: Configure the shop payment backend')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('set').setDescription('Set a config value')
      .addStringOption(o => o.setName('setting').setDescription('Which setting to update').setRequired(true)
        .addChoices(
          { name: '💵 Cash App Cashtag',    value: 'cashapp' },
          { name: '🅿️ PayPal Email',         value: 'paypal'  },
          { name: '📧 Gmail Address',        value: 'gmail'   },
          { name: '🔑 Gmail App Password',   value: 'gmailpw' },
          { name: '🏪 Store Name',           value: 'store'   },
          { name: '💸 Cash App Fee %',       value: 'cashfee' },
          { name: '💸 PayPal Fee %',         value: 'payfee'  },
          { name: '📉 Crypto Discount %',    value: 'cryptodc'},
          { name: '₿ BTC xPub Key',          value: 'btcxpub' },
          { name: 'Ł LTC xPub Key',          value: 'ltcxpub' },
          // No 'logchan' choice: the order log channel is a Railway variable,
          // not a DB row. See the handler for why.
        ))
      .addStringOption(o => o.setName('value').setDescription('The value to set').setRequired(true)))
    .addSubcommand(sub => sub.setName('view').setDescription('View current shop payment backend config')),
  new SlashCommandBuilder().setName('order').setDescription('Staff: Look up or manage a shop order')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('lookup').setDescription('Look up an order by ID')
      .addStringOption(o => o.setName('order_id').setDescription('Order ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('forceconfirm').setDescription('Manually confirm a payment')
      .addStringOption(o => o.setName('order_id').setDescription('Order ID').setRequired(true))),
  new SlashCommandBuilder().setName('shopstock').setDescription('Staff: Manage shop product stock (payment backend)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('add').setDescription('Add keys/accounts to a product')
      .addStringOption(o => o.setName('product_id').setDescription('Product tier ID').setRequired(true))
      .addStringOption(o => o.setName('items').setDescription('Items to add, separated by commas or newlines').setRequired(true)))
    .addSubcommand(sub => sub.setName('check').setDescription('Check stock count for a product')
      .addStringOption(o => o.setName('product_id').setDescription('Product tier ID').setRequired(true))),
  new SlashCommandBuilder().setName('web-balance').setDescription('Staff: View or adjust a website account balance')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('view').setDescription('View a linked account balance by Discord user')
      .addUserOption(o => o.setName('user').setDescription('Discord user linked to the website account').setRequired(true)))
    .addSubcommand(sub => sub.setName('adjust').setDescription('Credit or debit a website account balance')
      .addUserOption(o => o.setName('user').setDescription('Discord user linked to the website account').setRequired(true))
      .addNumberOption(o => o.setName('amount').setDescription('Dollar amount — positive to credit, negative to debit').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason / note for the ledger').setRequired(false))),
  new SlashCommandBuilder().setName('webstatus').setDescription('Staff: Set a website product status (undetected/testing/updating/detected)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('game_name').setDescription('Game / category name (exactly as on the site)').setRequired(true))
    .addStringOption(o => o.setName('product_name').setDescription('Product name (exactly as on the site)').setRequired(true))
    .addStringOption(o => o.setName('status').setDescription('New status').setRequired(true)
      .addChoices(
        { name: 'Undetected', value: 'undetected' },
        { name: 'Testing', value: 'testing' },
        { name: 'Updating', value: 'updating' },
        { name: 'Detected', value: 'detected' },
      ))
    .addStringOption(o => o.setName('note').setDescription('Optional note shown with the status').setRequired(false)),
  new SlashCommandBuilder().setName('webreviews').setDescription('Staff: Moderate website reviews')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('list').setDescription('List the latest reviews (pending shown first)'))
    .addSubcommand(sub => sub.setName('approve').setDescription('Approve a review so it shows on the site')
      .addStringOption(o => o.setName('review_id').setDescription('Review ID (from /webreviews list)').setRequired(true)))
    .addSubcommand(sub => sub.setName('reject').setDescription('Unapprove a review (hide it from the site)')
      .addStringOption(o => o.setName('review_id').setDescription('Review ID (from /webreviews list)').setRequired(true)))
    .addSubcommand(sub => sub.setName('delete').setDescription('Permanently delete a review')
      .addStringOption(o => o.setName('review_id').setDescription('Review ID (from /webreviews list)').setRequired(true))),
  new SlashCommandBuilder().setName('claim-customer').setDescription('Verify a paid order and grant the customer role')
    .addStringOption(o => o.setName('order_id').setDescription('Your order / invoice ID').setRequired(true))
    // Optional since round 29 item 6: an order delivered by staff can carry no
    // address at all, and the Discord account named on it proves the claim on
    // its own. Discord requires every required option to precede the optional
    // ones, so this must stay below order_id.
    .addStringOption(o => o.setName('email').setDescription('The email used on the order (skip if the order has none)').setRequired(false))
    .addUserOption(o => o.setName('user').setDescription('Staff only: grant to another member').setRequired(false)),
  // `role` is the only required option. Identify the target EITHER by picking a
  // Discord member (resolved through their linked web account) OR by typing the
  // website username/email — the handler enforces that exactly one is given.
  // Discord's option ordering requires all required options first, so `role`
  // leads.
  new SlashCommandBuilder().setName('web-promote').setDescription('Set a website account\'s role — grant admin panel access (also fixes lockouts)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('role').setDescription('Role to assign').setRequired(true)
      .addChoices(
        { name: 'admin', value: 'admin' },
        { name: 'staff', value: 'staff' },
        { name: 'reseller', value: 'reseller' },
        { name: 'member', value: 'member' },
      ))
    .addUserOption(o => o.setName('user').setDescription('Discord member to promote (must have linked their website account)').setRequired(false))
    .addStringOption(o => o.setName('username').setDescription('Or: website username or email of the account').setRequired(false)),

  new SlashCommandBuilder().setName('post-status').setDescription('Post ALL website product statuses to a channel (in sync with the site)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post into (defaults to here)').setRequired(false)),
  new SlashCommandBuilder().setName('post-status-vault').setDescription('Post vault product stock (IN STOCK / SOLD OUT) to a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post into (defaults to here)').setRequired(false)),
].map(c => c.toJSON());

// Merge with support module commands
const allCommands = [
  ...ownCommands, ...support.supportCommands,
  ...smsCommands.map(c => c.toJSON()),
  ...manualCommands.map(c => c.toJSON()),
  ...storefrontCommands.map(c => c.toJSON()),
  ...productInfoCommands.map(c => c.toJSON()),
  ...communityCommands.map(c => c.toJSON()),
];

// ─── Command lockdown ─────────────────────────────────────────────────────────
// Every staff command was gated at RUNTIME by hasAccess() and by nothing else,
// so 44 of the 66 registered commands were listed in the slash picker of every
// member in the server. `/config`, `/web-promote`, `/clearstock`,
// `/web-balance`, `/leaveguild` — all of them typeable by anyone, all of them
// answering "❌ No permission." A refusal is not concealment: it still tells a
// stranger the command exists, what it takes, and that there is something worth
// finding a way into.
//
// The gate is `default_member_permissions: "0"`, not a permission bit. A bit
// like ManageGuild would have LOCKED OUT THIS SERVER'S OWN STAFF: STAFF_ROLE_ID
// is `1242149320095170570` ("Ticket Staff"), and that role holds none of the
// management permissions — hasAccess() lets it through on role id alone. "0"
// hides the command from everyone except members with Administrator, and leaves
// the owner free to hand any role back a specific command in
// Server Settings → Integrations → UH Services. That is the only mechanism
// Discord offers here: per-command permission overwrites can only be written by
// a user bearer token with `applications.commands.permissions.update`, never by
// a bot token, so the bot cannot grant them for you.
//
// PUBLIC is an allow-list on purpose. A command added later and forgotten about
// arrives LOCKED, which is the failure that costs nothing.
const PUBLIC_COMMANDS = new Set([
  'commands',            // the help list itself
  'downloads',           // buyers fetch their own files
  'redeem',              // buyer redeems a key they were given
  'claim-customer',      // buyer claims the customer role with invoice + email
  'stock',               // read-only stock count
  'gensteam',            // the generator members are here for
  'gennumber',           // ditto, SMS
  'show-voucher-stats',  // invite leaderboard; the `public:` flag is staff-gated inside
  'product-info',        // the catalogue is the shop window; `channel:` is staff-gated inside
]);

let _lockedCount = 0;
for (const c of allCommands) {
  if (PUBLIC_COMMANDS.has(c.name)) {
    // Explicitly clear rather than leave undefined: a command that is meant to
    // be public should say so in the payload, so a later default cannot quietly
    // hide it.
    c.default_member_permissions = null;
    continue;
  }
  c.default_member_permissions = '0';
  _lockedCount++;
}
console.log(`[Lockdown] ${_lockedCount}/${allCommands.length} commands hidden from non-admins; public: ${[...PUBLIC_COMMANDS].join(', ')}`);

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  ✅ UH SUPER BOT online            ║`);
  console.log(`║  Logged in as: ${client.user.tag.padEnd(19)}║`);
  console.log(`╚════════════════════════════════════╝\n`);

  // Before anything can be counted. A message arriving in the first seconds of
  // boot is judged against whatever is in memory, and until this returns that
  // is a container-local file — which after a deploy is empty.
  await loadCountingFromDb();

  // Cache guild invites
  for (const [, guild] of client.guilds.cache) {
    try {
      const inv = await guild.invites.fetch();
      const cache = new Map();
      inv.forEach(i => cache.set(i.code, { inviterId: i.inviter?.id, uses: i.uses }));
      inviteCache.set(guild.id, cache);
    } catch (_) {}
  }

  // Discord's own "X joined the server" line, turned off where this bot posts a
  // welcome of its own.
  //
  // The complaint was "why showing users landing on general channel, when
  // theres a welcome channel" — two different welcomes for the same person, in
  // two different rooms, one of them a chat channel nobody wanted it in. The
  // system channel is a GUILD setting, not something a bot writes; the only way
  // to stop it is to set the flag, which needs Manage Server.
  //
  // Guarded three ways, because turning a server's own setting off from code is
  // the sort of thing that should be conservative: only if this bot actually has
  // a welcome channel to replace it with, only if the flag is not already set,
  // and only if the permission is there — no attempt, no error spam.
  await suppressNativeJoinMessages();

  // Invite counters + claimed-reward counts. Loaded before anything can read
  // them, so a join arriving seconds after boot does not write a zeroed row
  // back over a member's real total.
  await loadInviteStats();

  // Moderation lists. Same reason: a message arriving before these load would
  // be judged against the hardcoded defaults, so an allow-listed gif link would
  // still get deleted for the first few seconds after every deploy.
  try { await antiscam.loadModLists(); } catch (e) { console.error('[AntiScam] load failed:', e.message); }

  // Mirror routes, before the first message can arrive. Loading them lazily
  // would leave the edit and delete listeners unable to tell "no mirrors" from
  // "not loaded yet", so an edit made in the first seconds after a deploy would
  // never reach the copy.
  try {
    const routes = await loadMirrorRoutes(true);
    const n = [...routes.values()].reduce((a, r) => a + r.length, 0);
    if (n) console.log(`[Mirror] ${n} route(s) across ${routes.size} source channel(s)`);
  } catch (e) { console.error('[Mirror] route load failed:', e.message); }

  // Resume SMS orders that were still open when the process died. Each one
  // represents provider credit already spent, so leaving them unpolled means
  // the refund window closes with nobody watching.
  try {
    const { rehydrateOrders } = require('./modules/sms-gen');
    if (typeof rehydrateOrders === 'function') await rehydrateOrders(client);
  } catch (e) {
    console.error('[SMS] rehydrate on boot failed:', e.message);
  }

  // Re-schedule any active giveaway timers that survived a restart
  for (const [msgId, gw] of giveaways) {
    if (gw.ended) continue;
    const remaining = new Date(gw.endsAt).getTime() - Date.now();
    if (remaining <= 0) {
      // Already expired while bot was offline — end it now
      endGiveaway(msgId, 'restart').catch(e => console.error('Giveaway restart-end error:', e));
    } else {
      // Still has time left — re-arm the timer for the remaining duration
      safeSetTimeout(() => {
        endGiveaway(msgId, 'rescheduled').catch(e => console.error('Giveaway rescheduled-end error:', e));
      }, remaining);
      console.log(`⏰ Rescheduled giveaway ${msgId} (${gw.prize}) — ${Math.round(remaining / 60000)}m remaining`);
    }
  }

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('📋 Registering slash commands...');
    // Global registration — required for the bot to work on any server it
    // joins, not just GUILD_ID. Takes up to ~1hr to propagate to every
    // server on updates (normal Discord behavior for public bots), but new
    // commands are usually visible within minutes in practice.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommands });
    console.log('✅ Global slash commands registered');
  } catch (err) { console.error('Failed to register commands:', err); }

  // ─── Access audit ───────────────────────────────────────────────────────────
  // The lockdown above hides staff commands from everyone except Administrator,
  // and hasAccess() lets Administrator through unconditionally. Both are only as
  // tight as the list of roles holding that permission — which is why this is
  // printed every boot: it is how a role named "VIP", handed out as a perk, was
  // found to grant /config, /web-promote and /web-balance adjust. That one has
  // since been dealt with in Discord, where it belongs. Taking a permission off
  // a live role is the owner's call, not the bot's, so this still only reports.
  //
  // The second line is the other half of the same question and the half that
  // stayed silent for longer: a staff role id that is not present in the guild
  // it is being checked against denies everyone, forever, and looks from the
  // outside exactly like "the bot ignores my role".
  for (const [, guild] of client.guilds.cache) {
    try {
      const admins = [...guild.roles.cache.values()]
        .filter(r => r.permissions.has(PermissionFlagsBits.Administrator) && !r.managed && r.id !== guild.id)
        .map(r => `${r.name} (${r.id})`);
      if (admins.length) {
        console.log(`[Access audit] ${guild.name}: ${admins.length} non-bot role(s) hold ADMINISTRATOR and can run every staff command → ${admins.join(', ')}`);
      }

      const staffIds = staffRoleIdsFor(guild.id);
      const present = staffIds.filter(id => guild.roles.cache.has(id));
      const missing = staffIds.filter(id => !guild.roles.cache.has(id));
      console.log(`[Access audit] ${guild.name}: staff roles → `
        + (present.map(id => `${guild.roles.cache.get(id).name} (${id})`).join(', ') || 'NONE — Administrator is the only way in'));
      if (missing.length) {
        console.warn(`[Access audit] ${guild.name}: ${missing.length} configured staff role id(s) do NOT exist here and grant nothing → ${missing.join(', ')}`);
      }
    } catch (e) { /* a guild we cannot read roles for tells us nothing either way */ }
  }

  // Start 2FA auth server
  // The panel's hooks are the bot's own functions, handed over rather than
  // reimplemented inside modules/panel.js. A second definition of "how a key is
  // minted" or "how a stock type is spelled" is how the panel and Discord end
  // up disagreeing about the same table.
  startAuthServer(client, {
    issueKey: issueKeyAndNotify,
    invalidateGuildSettings,
    panelHooks: {
      buildContentEmbeds,
      chunkEmbeds: chunkEmbedsIntoMessages,
      normalizeStockType,
      mintKeys: mintKeysForPanel,
      revokeKey: revokeKeyForPanel,
    },
  });

  // Redeemable-key expiry — catch up on anything that expired while the bot
  // was offline, then check every minute going forward.
  await sweepExpiredKeys();
  setInterval(sweepExpiredKeys, 60_000);

  // Keep the posted status panel current. The first pass is forced because
  // anything could have changed while the bot was down, and after a restart
  // there is no remembered signature to compare against.
  refreshStatusPanel({ force: true }).catch(err => console.warn('[Status] first refresh failed:', err.message));
  setInterval(() => {
    refreshStatusPanel().catch(err => console.warn('[Status] refresh failed:', err.message));
  }, STATUS_PANEL_REFRESH_MS);

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
    let inviterId  = null;
    let usedCode   = null;
    newInvites.forEach(inv => {
      const old = oldCache.get(inv.code);
      if (old && inv.uses > old.uses) { inviterId = old.inviterId; usedCode = inv.code; }
    });
    const newCache = new Map();
    newInvites.forEach(inv => newCache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses }));
    inviteCache.set(member.guild.id, newCache);

    // An account made minutes ago is the classic self-invite: it counts as an
    // invite, but not as a REAL one, so it earns no reward progress.
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const fake = accountAgeMs < FAKE_ACCOUNT_AGE_MS;

    const prior = await recordJoin(member.guild.id, member.id, inviterId, usedCode, fake);
    // A rejoin must not credit the same inviter twice. `existed` is null only
    // when the write itself failed, in which case fall back to crediting —
    // under-counting a genuine invite is the worse of the two errors here.
    const isRejoin = prior ? prior.existed === true : false;
    const creditTo = inviterId || (prior && prior.inviter_id) || null;

    if (creditTo && !isRejoin) {
      const d = getUserInviteData(member.guild.id, creditTo);
      d.total++;
      if (fake) d.fake++; else d.real++;
      await saveInviteStats(member.guild.id, creditTo);
    }

    await announceInvite(member, creditTo, fake, isRejoin);
  } catch (err) { console.error('Invite tracking error:', err); }

  const settings = await getGuildSettings(member.guild.id);
  const verifyChForDM = (settings.verifyChannelId && member.guild.channels.cache.get(settings.verifyChannelId))
    || findChannelByName(member.guild, settings.verifyChannelName);

  // DM new member
  try {
    await member.send(
      `👋 Welcome to **${member.guild.name}**!\n\nPlease head to **#${verifyChForDM?.name || settings.verifyChannelName}** and click **Verify Me** to access the server.`
    );
  } catch (_) {}

  // Welcome card
  try {
    const welcomeCh = (settings.welcomeChannelId && member.guild.channels.cache.get(settings.welcomeChannelId))
      || findChannelByName(member.guild, settings.welcomeChannelName);
    if (!welcomeCh) return;
    const buf = await createWelcomeCard(member);
    await welcomeCh.send({
      content: `Welcome <@${member.user.id}> to **${member.guild.name}**! 🎉`,
      files: [new AttachmentBuilder(buf, { name: 'welcome.png' })],
    });
  } catch (err) { console.error('Welcome card error:', err); }
});

// ─── Discord's own join line ─────────────────────────────────────────────────
// Two flags, not one:
//   SuppressJoinNotifications        — the "X joined the server" line itself.
//   SuppressJoinNotificationReplies  — the "Wave to say hi!" sticker prompt
//                                      Discord hangs off it, which outlives the
//                                      line and looks like the feature is still
//                                      half on.
// Boost and setup-tip flags are deliberately left as the operator set them:
// nothing in this bot replaces those, so turning them off would be taking a
// decision that is not ours.
async function suppressNativeJoinMessages() {
  const WANT = GuildSystemChannelFlags.SuppressJoinNotifications
             | GuildSystemChannelFlags.SuppressJoinNotificationReplies;

  for (const [, guild] of client.guilds.cache) {
    try {
      // Only where this bot has something to say instead. A guild that has not
      // configured a welcome channel and has no channel named like one is
      // relying on Discord's line, and silencing it would leave joins invisible.
      const settings = await getGuildSettings(guild.id);
      const welcomeCh = (settings.welcomeChannelId && guild.channels.cache.get(settings.welcomeChannelId))
        || findChannelByName(guild, settings.welcomeChannelName);
      if (!welcomeCh) continue;

      // Numbers, not BigInt: SystemChannelFlagsBitField is a 32-bit field and
      // its resolver rejects a BigInt outright.
      const current = Number(guild.systemChannelFlags?.bitfield ?? 0);
      if ((current & WANT) === WANT) continue;   // already off

      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        console.warn(`[Welcome] ${guild.name}: Discord still announces joins in `
          + `#${guild.systemChannel?.name || 'the system channel'}, and turning that off needs **Manage Server**. `
          + `Grant it, or untick "Send a random welcome message" in Server Settings → Overview.`);
        continue;
      }

      // OR, never assign: the operator may have set other flags on purpose.
      await guild.setSystemChannelFlags(current | WANT,
        'Bot posts its own welcome card in #' + welcomeCh.name);
      console.log(`[Welcome] ${guild.name}: Discord's own join message turned off — `
        + `#${welcomeCh.name} is the welcome now.`);
    } catch (e) {
      console.warn(`[Welcome] ${guild.name}: could not adjust the system channel flags —`, e.message);
    }
  }
}

// ─── Member leaves ───────────────────────────────────────────────────────────
// There was no guildMemberRemove handler at all, so `left` was permanently 0
// and `real` only ever grew. The #invites panel promises "users who leave don't
// count" — this is what makes that true.
client.on('guildMemberRemove', async member => {
  try {
    const inviterId = await recordLeave(member.guild.id, member.id);
    if (!inviterId) return;
    const d = getUserInviteData(member.guild.id, inviterId);
    // Clamped: a stats row rebuilt from a partial history could otherwise be
    // driven negative by leaves whose joins predate the table.
    if (d.real > 0) d.real--;
    d.left++;
    await saveInviteStats(member.guild.id, inviterId);

    const settings = await getGuildSettings(member.guild.id);
    const ch = inviteLogChannel(member.guild, settings);
    if (!ch) return;
    await ch.send({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setAuthor({ name: member.user?.tag || member.id, iconURL: member.user?.displayAvatarURL?.() })
        .setDescription(`👋 **${member.user?.tag || member.id}** left — invited by <@${inviterId}>, who is now on **${d.real}** real invite${d.real === 1 ? '' : 's'}.`)
        .setFooter({ text: 'UH SERVICES • Invite Tracker' })
        .setTimestamp()],
    }).catch(() => {});
  } catch (err) { console.error('Invite leave-tracking error:', err); }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  // Wrapped: this handler had no try/catch at all, so EVERY message in the
  // guild was a crash opportunity. A Supabase blip inside getGuildSettings, a
  // throw from the anti-scam scanner, or a DM arriving while the DB pool is
  // saturated became an unhandled rejection — which Node 20 turns into process
  // exit, and Railway only retries five times.
  //
  // The inner await is an IIFE for the same reason as interactionCreate: a
  // bare `return asyncFn()` in one of these branches would otherwise resolve
  // past the try. Here the branches return plain values, but the shape keeps
  // it safe against future edits.
  try {
    await (async () => {
      // DM support (support module handles !close in DMs)
      if (message.channel.type === ChannelType.DM) {
        await support.handleDM(message, client);
        return;
      }
      // Cross-server mirroring. FIRST, and in its own try/catch, because every
      // branch below this one can return: the counting channel returns, an
      // anti-scam prefix command returns. A relay placed after them would work
      // for most channels and silently do nothing in the ones that happen to
      // be something else as well.
      try { await relayMessage(message); }
      catch (e) { console.error('[mirror] relay error:', e && e.message); }

      // Counting game (dedicated channel — skip other message processing)
      const msgSettings = await getGuildSettings(message.guild.id);
      if (msgSettings.countingChannelId && message.channel.id === msgSettings.countingChannelId) {
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
    })();
  } catch (err) {
    // Log and carry on. A broken message must not take the bot down.
    console.error('[messageCreate] error:', err && err.stack ? err.stack : err);
  }
});

// An edit or a delete in a mirrored channel follows into the copies. Both are
// keyed on the message id in the database rather than on the route cache, so
// they still work for a copy made before the last restart.
//
// Only worth the round trip when a route exists at all — mirrorRoutes is null
// until the first message loads it, and an empty map afterwards on a bot with
// no mirrors set up, which is the case that must stay free.
const anyMirrors = () => mirrorRoutes && mirrorRoutes.size > 0;

client.on('messageUpdate', async (_old, message) => {
  try {
    if (!anyMirrors() || !message || !message.guild) return;
    if (!mirrorRoutes.has(message.channelId)) return;
    // A partial has no embeds or content to copy — fetching it is the only way
    // to know what it now says.
    if (message.partial) { message = await message.fetch().catch(() => null); if (!message) return; }
    await relayEdit(message);
  } catch (e) { console.error('[messageUpdate] mirror error:', e && e.message); }
});

client.on('messageDelete', async (message) => {
  try {
    if (!anyMirrors() || !message) return;
    // A deleted message is usually a partial — its channelId survives even
    // when nothing else does, which is all this needs.
    if (!mirrorRoutes.has(message.channelId)) return;
    await relayDelete(message);
  } catch (e) { console.error('[messageDelete] mirror error:', e && e.message); }
});

// A source server changing hands is the loudest signal available that a route's
// authorisation no longer means what it meant when it was granted. An admin of
// the source approved the relay; a new owner did not, and neither did the
// destination — they trusted a server that no longer exists in the form they
// trusted. Transfers are also how a stolen server is laundered.
//
// So every relay LEAVING that server stops on the spot and the receiving end is
// told why. This errs towards a false alarm: an honest handover costs one
// `/mirror resume`, while the miss costs somebody else's server.
client.on('guildUpdate', async (oldGuild, newGuild) => {
  try {
    if (!oldGuild || !newGuild || oldGuild.ownerId === newGuild.ownerId) return;
    const reason = `the source server **${newGuild.name}** changed owner ` +
      `(<@${oldGuild.ownerId}> → <@${newGuild.ownerId}>)`;
    console.warn(`[mirror] guild ${newGuild.id} owner ${oldGuild.ownerId} → ${newGuild.ownerId}`);

    let routes = [];
    try {
      ({ rows: routes } = await db.query(
        'SELECT * FROM mirror_routes WHERE enabled AND src_guild_id = $1', [newGuild.id]));
    } catch (e) { console.error('[mirror] owner-change lookup failed:', e.message); return; }
    if (!routes.length) return;

    for (const route of routes) {
      // skip: 'src' — the source server is the one whose control just changed,
      // so a notice posted there is a notice to whoever took it. The people who
      // need to know are at the other end.
      await pauseMirrorRoute(route, reason, { skip: 'src' })
        .catch(e => console.error(`[mirror] owner-change pause of ${route.id} failed:`, e.message));
    }
  } catch (e) { console.error('[guildUpdate] mirror error:', e && e.message); }
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  // One line per interaction, before anything can throw or hang. When a command
  // "does nothing", the first question is whether the gateway delivered it at
  // all — silence on this line means the problem is upstream of this process
  // (the client, or Discord) and no amount of reading handler code will find it.
  client._lastInteractionAt = Date.now();
  console.log(`[Interaction] ${interaction.commandName || interaction.customId || interaction.type}`
    + ` · ${interaction.user ? interaction.user.tag : '?'} · ${interaction.guild ? interaction.guild.name : 'DM'}`);
  try {
    // Awaited IIFE — see note: a bare `return asyncFn()` inside would otherwise
    // escape this try/catch and crash the process as an unhandled rejection.
    await (async () => {
    // 2FA button
    if (await handle2FAInteraction(interaction)) return;
    // Support module interactions
    if (await support.handleInteraction(interaction, client)) return;
    // SMS Gen (commands + select menus + buttons)
    const _smsCmd = interaction.commandName || '';
    const _smsId  = interaction.customId || '';
    if (['gennumber', 'post-smsgen', 'set-5sim-api', 'set-smspool-api', 'set-smsgen-channel'].includes(_smsCmd) || _smsId.startsWith('sms_')) {
      // await, not a bare return: inside an async fn  resolves this
      // function WITH p, so a rejection escapes the enclosing try/catch and
      // becomes an unhandled rejection — which Node 20 turns into process exit.
      return await handleSMSInteraction(interaction, client);
    }
    // Manual order delivery — owns its command, its duration select, its modal
    // and its own autocomplete, so it must be dispatched BEFORE the generic
    // autocomplete branch below (which only knows about /setdownload and would
    // otherwise let this one time out).
    if (await handleManualInteraction(interaction, client)) return;
    // The #website and #payment-methods panels. findChannelByName is handed in
    // rather than re-implemented in the module: it is the NFKD-folding resolver,
    // which is the only reason "#💰︱𝐏𝐚𝐲𝐦𝐞𝐧𝐭-𝐦𝐞𝐭𝐡𝐨𝐝𝐬" resolves at all.
    if (interaction.isChatInputCommand()
      && await handleStorefrontCommand(interaction, { findChannel: findChannelByName })) return;
    // /product-info — owns its command and its two dropdowns.
    if (interaction.isChatInputCommand() && await handleProductInfoCommand(interaction)) return;
    // #live-stream and #post-your-clips. Same findChannelByName for the same
    // reason: "🔴︱𝐋𝐢𝐯𝐞-𝐒𝐭𝐫𝐞𝐚𝐦" has to resolve.
    if (interaction.isChatInputCommand()
      && await handleCommunityCommand(interaction, { findChannel: findChannelByName })) return;
    // Autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'setdownload') {
      const focused = interaction.options.getFocused().toLowerCase();
      // Discord invalidates an autocomplete interaction after 3s; respond()
      // then rejects with 10062. Unawaited, that killed the process.
      // Match on the displayed label, so typing a GAME narrows to that game's
      // products — the product name alone is often not something an admin can
      // search by ("Ancient", "PREDATOR", "FULL").
      return await interaction.respond(
        getAllProducts()
          .filter(p => (p.label || p.name).toLowerCase().includes(focused))
          .slice(0, 25)
          .map(p => ({ name: (p.label || p.name).slice(0, 100), value: p.id }))
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
            { name: '🔐 Verification & Invites', value: '`/setup-verify` — Set up verification channel\n`/setup-invites` — Set up invite reward channel\n`/show-voucher-stats` — Invite leaderboard / one member\'s stats', inline: false },
            { name: '📦 Products & Downloads', value: '`/product-info` — Look up any product: price, plans, stock, features\n`/downloads` — Browse & download products\n`/setupdownloads` — Post download panel to #downloads\n`/setdownload` — Set a product download link', inline: false },
            { name: '📣 Updates & Status', value: '`/postupdate` — Post a product update\n`/statusupdate` — Post a status update\n`/announce` — Send a custom announcement', inline: false },
            { name: '🌐 Server Setup', value: '`/setup-website` — Post the website panel\n`/setup-payments` — Post the payment methods panel (live fees)\n`/setup-livestream` — Post the live-stream panel (staff announce from it)\n`/golive` — Announce a stream with its link (blank link = remove the announcement)\n`/setup-clips` — Post the post-your-clips panel (members post clips from it)\n`/setup-postyourpc` — Post the post-your-setup panel\n`/setup-suggestions` — Post the suggestions panel\n`/setup-giveaway` — Post the giveaways panel\n`/setupreseller` — Post reseller panel\n`/setresellerlinks` — Update reseller button links\n`/postimage` — Post an image', inline: false },
            { name: '💾 Server Snapshots', value: '`/serverbackup create` — Save the server\'s roles, channels & permissions\n`/serverbackup list|view|export` — Browse or download a snapshot\n`/serverbackup restore` — Rebuild from one: tick roles / categories / channels / permissions / emojis (never deletes anything)', inline: false },
            { name: '🔁 Cross-Server Mirroring', value: '`/mirror follow` — Announcement channels: let another server follow this one (Discord delivers it)\n`/mirror add` — Any channel: relay its posts into another server\n`/mirror list|remove|test` — Manage the relays\n`/mirror panic` — Stop everything arriving here, right now\n`/mirror block|unblock|resume` — Refuse a server outright, or restart a paused route', inline: false },
            { name: '🎫 Support Tickets', value: '`/panel` — Post the support panel\n`/clearlogs` — Clear ticket log channel\n`/reply` — Reply to a user\'s ticket', inline: false },
            { name: '📝 Vouches', value: '`/setupvouch` — Post the Leave a Vouch panel\n`/exportvouches` — Download a backup of all vouches\n`/importvouches` — Restore vouches from a backup file, or `source: website`', inline: false },
            { name: '🎮 Steam Stock', value: '`/gensteam [type]` — Generate a Steam account\n`/stock` — Check available stock\n`/addstock` — Staff: add accounts to stock', inline: false },
            { name: '💳 Shop Payment Backend', value: '`/config set|view` — Staff: configure payment backend\n`/order lookup|forceconfirm` — Staff: look up/confirm an order\n`/shopstock add|check` — Staff: manage shop product stock\n`/manual-order-delivery send` — Staff: hand-deliver a product and record a real order\n`/manual-order-delivery pending` — Staff: approve a website order that never settled', inline: false },
            { name: '📲 SMS Gen', value: '`/gennumber` — Generate a phone number (private dropdowns)\n`/post-smsgen` — Staff: Post the SMS Gen panel\n`/set-smspool-api` — Admin: Set SMSPool.net key\n`/set-5sim-api` — Admin: Set 5sim.net key', inline: false },
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
        const settings = await getGuildSettings(guild.id);
        let verifiedRole = (settings.verifiedRoleId && guild.roles.cache.get(settings.verifiedRoleId))
          || guild.roles.cache.find(r => r.name === settings.verifiedRoleName);
        if (!verifiedRole) verifiedRole = await guild.roles.create({ name: settings.verifiedRoleName, color: 0x5865f2 });
        const everyoneRole = guild.roles.everyone;
        const botRole = guild.members.me.roles.highest;
        await guild.channels.fetch();
        // Which channels a verified member is allowed to see, besides
        // get-verify. This used to be two hardcoded IDs from the original
        // server, which meant running /setup-verify anywhere else hid EVERY
        // channel from @everyone and then hid every channel from Verified as
        // well — the command's whole purpose, inverted, on any server but one.
        //
        // The set is read off the server instead: whatever @everyone can see
        // RIGHT NOW is what the public was already meant to have, so that is
        // what Verified keeps once @everyone loses it. Snapshotted before the
        // loop, because the loop is what takes the permission away.
        const VERIFIED_ALLOWED_IDS = [...guild.channels.cache.values()]
          .filter(ch => ch.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel))
          .map(ch => ch.id);
        let verifyCh = (settings.verifyChannelId && guild.channels.cache.get(settings.verifyChannelId))
          || findChannelByName(guild, settings.verifyChannelName);
        if (!verifyCh) verifyCh = await guild.channels.create({ name: settings.verifyChannelName, type: ChannelType.GuildText });
        for (const [, ch] of guild.channels.cache) {
          if (ch.id === verifyCh.id) continue;
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
        await verifyCh.send(withLanguageRow({ embeds: [embed], components: [row] }));
        await interaction.editReply('✅ Done!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /setup-invites ────────────────────────────────────────────────────
      // ── /show-voucher-stats ───────────────────────────────────────────────
      if (cmd === 'show-voucher-stats') {
        const guild    = interaction.guild;
        const wantsPublic = interaction.options.getBoolean('public') === true;
        const isStaff  = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        // Anyone can look, but only staff can put the leaderboard in a channel —
        // otherwise it is a one-command spam tool.
        const ephemeral = !(wantsPublic && isStaff);
        await interaction.deferReply({ ephemeral });

        const settings = await getGuildSettings(guild.id);
        const N        = settings.invitesNeeded || 10;
        const target   = interaction.options.getUser('user');

        if (target) {
          const d = getUserInviteData(guild.id, target.id);
          const available = Math.max(0, Math.floor(d.real / N) - d.usedKeys);
          const filled    = Math.round(((d.real % N) / N) * 10);
          const bar       = '█'.repeat(filled) + '░'.repeat(10 - filled);
          // Who they actually brought in, straight from the join log — the
          // counters cannot answer this.
          let names = [];
          try {
            const { rows } = await db.query(
              `SELECT member_id, left_at FROM invite_joins
               WHERE guild_id = $1 AND inviter_id = $2
               ORDER BY joined_at DESC LIMIT 15`,
              [String(guild.id), String(target.id)]
            );
            names = rows.map(r => `${r.left_at ? '👋' : '✅'} <@${r.member_id}>`);
          } catch (e) { console.error('[Invites] join list failed:', e.message); }

          const embed = new EmbedBuilder()
            .setColor(0x00e5ff)
            .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL() })
            .setTitle('📊 Invite Stats')
            .setDescription(`**Progress to next reward**\n${bar} ${d.real % N}/${N}`)
            .addFields(
              { name: '📨 Total',  value: `\`${d.total}\``, inline: true },
              { name: '✅ Real',   value: `\`${d.real}\``,  inline: true },
              { name: '👋 Left',   value: `\`${d.left}\``,  inline: true },
              { name: '🚫 Fake',   value: `\`${d.fake}\``,  inline: true },
              { name: '🎁 Available', value: `\`${available}\``, inline: true },
              { name: '🔑 Used',   value: `\`${d.usedKeys}\``, inline: true },
              { name: `👥 Invited (${names.length})`, value: names.length ? names.join('\n').slice(0, 1024) : '_nobody yet_', inline: false },
            )
            .setFooter({ text: 'UH SERVICES • Invite Tracker' })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        }

        const board = [...getGuildData(guild.id).entries()]
          .filter(([, d]) => d.total > 0)
          .sort((a, b) => b[1].real - a[1].real || b[1].total - a[1].total);

        if (!board.length) {
          return interaction.editReply({ content: '📭 No invites tracked yet.' });
        }

        const medals = ['🥇', '🥈', '🥉'];
        // Discord caps a description at 4096 chars; 25 rows is well inside it
        // and past the point anyone reads.
        const lines = board.slice(0, 25).map(([uid, d], i) => {
          const avail = Math.max(0, Math.floor(d.real / N) - d.usedKeys);
          return `${medals[i] || `\`${String(i + 1).padStart(2)}\``} <@${uid}> — **${d.real}** real · ${d.total} total · ${d.left} left · ${d.fake} fake${avail ? ` · 🎁 ${avail}` : ''}`;
        });

        const embed = new EmbedBuilder()
          .setColor(0x00e5ff)
          .setTitle('📊 Invite Leaderboard')
          .setDescription(lines.join('\n'))
          .setFooter({ text: `${board.length} member(s) with invites • ${N} real invites = 1 key` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      if (cmd === 'setup-invites') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const settings = await getGuildSettings(guild.id);
        let invCh = (settings.invitesChannelId && guild.channels.cache.get(settings.invitesChannelId)) || findChannelByName(guild, settings.invitesChannelName);
        if (!invCh) invCh = await guild.channels.create({ name: settings.invitesChannelName, type: ChannelType.GuildText });
        await invCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        try { const msgs = await invCh.messages.fetch({ limit: 10 }); await invCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🎉 Invite Your Friends & Earn Rewards!')
          .setDescription(`Invite your friends and earn **free keys**!\n\n**How it works:**\n1️⃣ Click **Your Invite Link** to get your link\n2️⃣ Share it with friends\n3️⃣ Once you have **${settings.invitesNeeded} real invites**, click **Redeem Your Key**!\n\nRedeem **unlimited times** — every ${settings.invitesNeeded} invites = 1 free key 🔑\n\n⚠️ *Fake invites & users who leave don't count!*`)
          .setColor(0x5865f2).setTimestamp().setFooter({ text: 'Invite Reward System' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('get_invite_link').setLabel('🔗 Your Invite Link').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('check_invites').setLabel('📊 Check Your Invites').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('redeem_key').setLabel('🎁 Redeem Your Key').setStyle(ButtonStyle.Success),
        );
        await invCh.send(withLanguageRow({ embeds: [embed], components: [row] }));
        // Naming the channel, because the failure this fixes was silent: the
        // command said "set up!" while the panel went into the log. If the
        // answer below is not the channel the operator meant, they can see so
        // without going to look for the post.
        const logCh = inviteLogChannel(guild, settings);
        await interaction.editReply(
          `✅ Invite panel posted to <#${invCh.id}> — **#${invCh.name}** (\`${invCh.id}\`).\n`
          + `📋 Join/leave lines go to ${logCh ? `<#${logCh.id}> — **#${logCh.name}**` : '**nowhere** — no invite log channel resolved'}.\n`
          + 'Wrong channel? Set **Invites channel ID** / **Invite log channel ID** in the web panel.'
        );
        return;
      }

      // ── /testinvite ────────────────────────────────────────────────────────
      // The only honest way to test a join announcement without asking someone
      // to join: call the SAME function guildMemberAdd calls, with the caller
      // standing in for the new member. Re-implementing the embed here would
      // test this command instead of the tracker.
      //
      // It exists because the tracker had been posting into the wrong channel
      // for its whole life and nothing errored — two channels with near-
      // identical names, both real, both writable. So the reply names the
      // channel it actually reached, which is the fact under test.
      if (cmd === 'testinvite') {
        await interaction.deferReply({ ephemeral: true });
        const settings = await getGuildSettings(interaction.guild.id);
        const ch = await announceInvite(interaction.member, interaction.user.id, false, false);
        if (!ch) {
          return interaction.editReply(
            '❌ No invite **log** channel could be resolved, so the announcement was dropped.\n' +
            `• \`INVITE_LOG_CHANNEL_ID\` → \`${settings.inviteLogChannelId || '(unset)'}\`\n` +
            `• name fallback → \`#${settings.inviteLogChannelName}\`\n` +
            'It no longer falls back to the invites panel channel — a log in the panel channel is the bug this split fixed.\n' +
            'Either the id points at a channel the bot cannot see, or it lacks **View Channel** / **Send Messages** there.'
          );
        }
        return interaction.editReply(
          `✅ Test join announcement posted to <#${ch.id}> — **#${ch.name}** (\`${ch.id}\`).\n` +
          'That is the exact channel a real join will use — the **log**, not the panel.\n' +
          `The reward panel lives separately in \`${settings.invitesChannelId || `#${settings.invitesChannelName}`}\`. ` +
          'Either can be changed in the web panel.'
        );
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
        // `chunks[2] || []` built an EMPTY select menu whenever there were
        // fewer than 51 products, and Discord rejects a menu with no options —
        // the whole reply fails, not just that row. Build only the rows that
        // have something in them.
        if (!chunks.length) {
          return interaction.reply({ content: '❌ No downloads are configured yet.', flags: 64 });
        }
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => {
            // "GAME - PRODUCT". The option VALUE stays the slug of the product
            // name, so an existing panel keeps working and the link table keeps
            // resolving; only what the customer reads changes.
            const text = p.label || p.name;
            return { label: text.length > 100 ? text.slice(0, 97) + '...' : text, value: p.id, description: p.url ? 'Download available' : 'Coming soon' };
          }));
        await interaction.reply({
          content: '### Product Downloads\nSelect your product below:',
          components: chunks.map((chunk, i) => new ActionRowBuilder().addComponents(
            makeMenu(`dl_page_${i + 1}`, `${(chunk[0].label || chunk[0].name).charAt(0)}–${(chunk[chunk.length - 1].label || chunk[chunk.length - 1].name).charAt(0)}  (Page ${i + 1} of ${chunks.length})`, chunk)
          )),
          flags: 64,
        });
        autoDelete(interaction, 120000);
        return;
      }

      // ── /setupdownloads ───────────────────────────────────────────────────
      if (cmd === 'setupdownloads') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const dlCh = findChannelByName(interaction.guild, 'downloads') || interaction.channel;

        // Force a refresh before posting. The panel message stays in the
        // channel indefinitely, so whatever it is built from here is what
        // customers see until someone runs this again — posting a stale list
        // is not something they can work around.
        await dlRefresh(true);
        const chunks = getProductChunks();
        if (!chunks.length) {
          return interaction.editReply({ content: '❌ No products to list — the backend returned an empty catalog and there is no cached table.' });
        }

        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => {
            // "GAME - PRODUCT". The option VALUE stays the slug of the product
            // name, so an existing panel keeps working and the link table keeps
            // resolving; only what the customer reads changes.
            const text = p.label || p.name;
            return { label: text.length > 100 ? text.slice(0, 97) + '...' : text, value: p.id, description: p.url ? 'Download available' : 'Coming soon' };
          }));
        const listed = chunks.reduce((n, c) => n + c.length, 0);
        const embed = new EmbedBuilder().setTitle('📦  PRODUCT DOWNLOADS').setColor(0x5865F2)
          .setURL(DOWNLOADS_URL)
          // The bare `@everyone https://uhservices.xyz/downloads` post that used
          // to sit above this one is now this paragraph and the button under
          // it. Two posts saying "downloads are over here" in the downloads
          // channel is one post too many, and the bare one said nothing about
          // what to do when you got there.
          .setDescription(
            `**Every file you have bought, in two places.**\n`
            + `Pick your product from a dropdown below and hit **DOWNLOAD**, or open the full library on the site — `
            + `same files, and your order history is next to them.\n\n`
            + `🌐 ${DOWNLOADS_URL}`
          )
          .addFields(
            { name: '📥 Here in Discord', value: `${listed} product${listed === 1 ? '' : 's'} across ${chunks.length} page${chunks.length === 1 ? '' : 's'} below.`, inline: true },
            { name: '🌐 On the site', value: 'Sign in with Discord — no password — for the full list and your keys.', inline: true },
            { name: '🆕 Updates', value: 'Links are replaced in place, so this panel always points at the current build.', inline: true },
          )
          .setFooter({ text: `${BOT_NAME}${SITE_URL ? ` | ${SITE_URL}` : ''} • ${MARK_DOWNLOADS}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();

        const linkRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Open downloads on the site').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(DOWNLOADS_URL),
          new ButtonBuilder().setLabel('My orders').setEmoji('📦').setStyle(ButtonStyle.Link).setURL(`${STORE_URL}/account`),
        );

        // One row per page, built from however many pages there actually are.
        // This was three hardcoded rows labelled "Page n of 3", so a fourth
        // page of products was dropped without a word and the labels lied as
        // soon as the catalog stopped being 62 items.
        //
        // Five action rows is a hard cap and a sixth REJECTS the whole message.
        // The link row is now one of the five, so the dropdowns get four — and
        // if that ever costs a page, the count that did not fit is REPORTED
        // rather than quietly dropped. downloads.js already caps at 5 pages, so
        // the two limits are stated together below.
        const MENU_ROWS = 4;
        const shownChunks = chunks.slice(0, MENU_ROWS);
        const notShown = listed - shownChunks.reduce((n, c) => n + c.length, 0);
        if (notShown > 0) console.warn(`[Downloads] ${notShown} products past page ${MENU_ROWS} are not on the panel`);

        const payload = withLanguageRow({
          embeds: [embed],
          components: [linkRow, ...shownChunks.map((chunk, i) => new ActionRowBuilder().addComponents(
            makeMenu(`dl_page_${i + 1}`, `${(chunk[0].label || chunk[0].name).charAt(0)}–${(chunk[chunk.length - 1].label || chunk[chunk.length - 1].name).charAt(0)}  (Page ${i + 1} of ${shownChunks.length})`, chunk)
          ))],
        });

        // Edit the panel already in the channel rather than stacking another
        // one under it — same marker-in-the-footer trick /setup-website uses,
        // and the reason this command stopped being a duplicate machine.
        const { edited } = await upsertPanel(dlCh, MARK_DOWNLOADS, payload, client.user);

        // The old bare-link post, if it is still sitting there. Matched as
        // narrowly as it can be — authored by this bot, carrying NO panel
        // marker, and containing nothing but the downloads URL (plus an
        // @everyone) once the markdown is stripped. Anything with a sentence in
        // it fails that test and is left alone, and whatever does go is named
        // in the reply rather than vanishing quietly.
        const superseded = [];
        try {
          const recent = await dlCh.messages.fetch({ limit: 50 });
          for (const m of recent.values()) {
            if (m.author.id !== client.user.id) continue;
            if (m.embeds.some(e => /panel:/.test((e.footer && e.footer.text) || ''))) continue;
            if (m.embeds.length > 1 || m.attachments.size) continue;
            const e = m.embeds[0];
            const body = [m.content, e && e.title, e && e.description, e && (e.footer && e.footer.text)]
              .filter(Boolean).join(' ')
              .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')   // markdown links → their two halves
              .replace(/@everyone|@here|<@&?\d+>/g, '')
              .replace(/https?:\/\/\S*?\/downloads\/?/gi, '')
              .replace(/[>*_`~\s]/g, '');
            if (body) continue;                        // it says something else — not ours to delete
            if (e && (e.fields || []).length) continue;
            try { await m.delete(); superseded.push(m.id); } catch (err) { console.warn('[Downloads] could not remove the old link post:', err.message); }
          }
        } catch (err) { console.warn('[Downloads] could not scan for the old link post:', err.message); }

        await interaction.editReply({
          content: `${edited ? '♻️ Refreshed' : '📌 Posted'} the download panel in <#${dlCh.id}> — ${listed} product${listed === 1 ? '' : 's'} across ${shownChunks.length} page(s), with the site link on it.`
            + (superseded.length ? `\n🧹 Removed ${superseded.length} old bare-link post(s) (\`${superseded.join('`, `')}\`) — the link lives on this panel now.` : '')
            + (notShown > 0 ? `\n⚠️ ${notShown} product(s) did not fit: the link row takes one of Discord's five rows, leaving ${MENU_ROWS} pages of 25. They are still on the site.` : ''),
        });
        return;
      }

      // ── /setdownload ──────────────────────────────────────────────────────
      if (cmd === 'setdownload') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const productId = interaction.options.getString('product');
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const product = getProduct(productId);
        if (!product) return interaction.editReply({ content: '❌ Product not found.' });

        // The write goes to the backend now, so it can fail — and if it does,
        // saying "updated" would be a lie that only surfaces when a customer
        // clicks a dead button. The old version wrote a local file that
        // Railway deleted on the next deploy and always reported success.
        try {
          await setProductUrl(productId, url);
        } catch (err) {
          const msg = (err.response && err.response.data && err.response.data.error) || err.message;
          return interaction.editReply({ content: `❌ Could not save the link: ${msg}\nNothing was changed — the website and the bot are still in sync.` });
        }
        await interaction.editReply({
          content: url
            // Echo the label AND the key it was saved under: the label is how
            // the admin found it, the name is what the website will look it up
            // by, and they are not the same string.
            ? `✅ Download link updated for **${product.label || product.name}**\n🔗 ${url}\n_Saved as \`${product.name}\` — live on the website's Downloads Manager too._`
            : `✅ Download link cleared for **${product.label || product.name}** — it now shows as coming soon on both the site and here.`,
        });
        return;
      }

      // ── /setwebsite ───────────────────────────────────────────────────────
      // Used to post an embed whose entire body was the URL as a markdown link,
      // and to remember which message that was in `websiteMessages` — an
      // in-memory object, so a restart lost it and the next /setwebsite posted a
      // SECOND one. Both are gone: it renders the same panel /setup-website
      // does, and finds the previous one by the marker in its own footer, which
      // is a fact about the message rather than a fact about this process.
      if (cmd === 'setwebsite') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const wsCh = findChannelByName(interaction.guild, 'website') || interaction.channel;
        const cfg = await storefrontConfig();
        const payload = buildWebsitePanel(interaction.guild, cfg, url);
        try {
          const { edited } = await upsertPanel(wsCh, MARK_SITE, payload, client.user);
          await interaction.editReply(
            `${edited ? '♻️ Refreshed' : '📌 Posted'} the website panel in <#${wsCh.id}> — **${url}**`
            + (cfg ? '' : '\n⚠️ The store did not answer, so the accepted-payments line was left off. Run it again once it is up.')
          );
        } catch (e) {
          await interaction.editReply(`❌ Could not post there: ${e.message}`);
        }
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
            await msg.edit(withLanguageRow({ embeds: [embed], components: [row] }));
            await interaction.editReply({ content: `✅ Reseller panel updated in <#${existing.channelId}>` }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await resCh.send(withLanguageRow({ embeds: [embed], components: [row] }));
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
          // The marker is what lets the NEXT giveaway find this one and clear
          // it. Without it in the footer the sweep below is blind.
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL} • ${MARK_GW_ENTRY}`, iconURL: client.user.displayAvatarURL() })
          .setTimestamp(endsAt);
        if (imageUrl) embed.setImage(imageUrl);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Participate (0)').setStyle(ButtonStyle.Primary),
        );

        await interaction.deferReply({ ephemeral: true });

        // "when a giveaway is done, make sure next time giveaway is done it
        // clears the old giveaway + giveaway results." Done BEFORE the new post
        // so the channel is never holding two giveaways at once, and scoped to
        // the two disposable markers so `/setup-giveaway`'s panel survives.
        const swept = await clearOldGiveaway(targetCh);

        // A giveaway is one of the few posts that pings the whole server, so it
        // is read by more people who do not read English than almost anything
        // else the bot writes.
        const msg = await targetCh.send(withLanguageRow({ content: '@everyone', embeds: [embed], components: [row] }));

        // imageUrl is stored, not just closed over: endGiveaway() runs from the
        // restart path too, where the closure is long gone, and an ended card
        // that silently loses its picture reads as a different giveaway.
        giveaways.set(msg.id, { prize, channelId: targetCh.id, guildId: interaction.guild.id, endsAt: endsAt.toISOString(), participants: new Set(), ended: false, winnerCount, imageUrl });
        saveGiveaways();

        safeSetTimeout(() => {
          endGiveaway(msg.id, 'timer').catch(e => console.error('Giveaway end error:', e));
        }, durMs);

        await interaction.editReply({ content: `✅ Giveaway started in <#${targetCh.id}>! Ends ${endsTs}`
          + (swept.length ? `\n🧹 Cleared ${swept.length} post${swept.length === 1 ? '' : 's'} from the previous giveaway. The \`/setup-giveaway\` panel was left alone.` : '') });
        autoDelete(interaction, 8000);
        return;
      }

      // ── /setupvouch ────────────────────────────────────────────────────────
      if (cmd === 'setupvouch') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const chanName    = interaction.options.getString('channel') || null;
        const resultsName = interaction.options.getString('results_channel') || null;
        const vSettings = await getGuildSettings(interaction.guild.id);

        // Panel channel: defaults to #leave-vouch (or this server's configured channel)
        let targetCh = (vSettings.leaveVouchChannelId && interaction.guild.channels.cache.get(vSettings.leaveVouchChannelId)) || interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.get(chanName) || findChannelByName(interaction.guild, chanName.replace('#','')); if (f) targetCh = f; }

        // Results channel: defaults to #vouches (or this server's configured channel)
        let resultsCh = (vSettings.vouchesChannelId && interaction.guild.channels.cache.get(vSettings.vouchesChannelId)) || targetCh;
        if (resultsName) { const f = interaction.guild.channels.cache.get(resultsName) || findChannelByName(interaction.guild, resultsName.replace('#','')); if (f) resultsCh = f; }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('📝 Leave a Vouch')
          .setDescription('We value your feedback!\nClick the button below to leave a vouch.\n\n**Your feedback helps us grow** 💡')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('leave_vouch').setLabel('📝 Leave a Vouch').setStyle(ButtonStyle.Primary),
        );
        await targetCh.send(withLanguageRow({ embeds: [embed], components: [row] }));
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
        // Attaching a file and not naming a source is the obvious thing to do,
        // so it still means "file" — the option only has to be set to ask for
        // the website.
        const source = (interaction.options.getString('source') || (attachment ? 'file' : null) || 'file').toLowerCase();

        let backup;
        if (source === 'website') {
          // The store database is the copy that survives losing this server:
          // every Discord vouch is pushed there as it happens, and every
          // website vouch is written there first. Restoring a fresh server is
          // therefore this one command, with nothing to have kept safe.
          if (!API_SECRET) {
            return interaction.editReply({ content: '❌ `API_SECRET` is not set on the bot — it cannot read the website\'s vouches.' });
          }
          try {
            const res = await axios.get(`${BACKEND_URL}/api/reviews/admin/all`, {
              params: { secret: API_SECRET }, timeout: 15000,
            });
            const reviews = (res.data && res.data.reviews) || [];
            backup = {
              exportedFrom: 'website',
              // Unapproved rows are the moderation queue, not vouches. Posting
              // them into #vouches would publish exactly what an admin has not
              // yet agreed to publish.
              entries: reviews.filter(r => r.approved).map(r => ({
                userId: r.discord_id || null,
                username: r.display_name || 'Unknown',
                rating: r.rating,
                feedback: r.body || '',
                // The website serves its own copy of the screenshot, so this
                // link keeps working after the Discord CDN one it came from
                // has expired — which is the only reason a rebuilt server gets
                // its vouch images back at all.
                imageUrl: r.image || null,
                timestamp: r.created_at || new Date().toISOString(),
              })),
            };
          } catch (e) {
            const why = e.response?.data?.error || e.message;
            return interaction.editReply({ content: `❌ Could not read the website's vouches: ${why}` });
          }
        } else {
          if (!attachment || !attachment.name?.toLowerCase().endsWith('.json')) {
            return interaction.editReply({ content: '❌ Attach the `.json` backup from `/exportvouches`, or run this with `source: website`.' });
          }
          try {
            const res = await fetch(attachment.url);
            const text = await res.text();
            backup = JSON.parse(text);
          } catch (e) {
            console.error('Import vouches parse error:', e);
            return interaction.editReply({ content: '❌ Could not read that file — is it a valid vouches backup .json?' });
          }
        }

        const incoming = Array.isArray(backup.entries) ? backup.entries : null;
        if (!incoming) {
          return interaction.editReply({ content: '❌ That file doesn\'t look like a vouches backup (missing `entries`).' });
        }

        const ivSettings = await getGuildSettings(interaction.guild.id);
        const gData = vouchData.get(interaction.guild.id) || { count: 0, channelId: ivSettings.vouchesChannelId, entries: [] };
        gData.entries = gData.entries || [];

        const vouchCh =
          (ivSettings.vouchesChannelId && interaction.guild.channels.cache.get(ivSettings.vouchesChannelId)) ||
          (gData.channelId && interaction.guild.channels.cache.get(gData.channelId));

        // Running the import twice is a normal thing to do — the first attempt
        // half-finished, or the website gained vouches since. Without this,
        // every re-run duplicates the whole history into #vouches.
        const seen = new Set(gData.entries.map(e => `${e.userId || e.username}|${e.feedback}|${e.timestamp}`));

        let imported = 0, skipped = 0;
        for (const old of incoming) {
          const key = `${old.userId || old.username}|${old.feedback || ''}|${old.timestamp}`;
          if (seen.has(key)) { skipped++; continue; }
          seen.add(key);
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
          content: `✅ Imported **${imported}** vouch${imported === 1 ? '' : 'es'} from ${source === 'website' ? 'the website' : 'backup'}` +
            `${skipped ? ` (**${skipped}** already here, skipped)` : ''}` +
            `${repost ? ` and reposted them in <#${vouchCh?.id || ivSettings.vouchesChannelId}>` : ' (silently, no repost)'}.`,
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

        await addStockAccounts(interaction.guild.id, type, lines);
        const totalNow = await getStockCount(interaction.guild.id, type);

        await interaction.editReply({
          content: `✅ Added **${lines.length}** account${lines.length === 1 ? '' : 's'} to **${stockTypeLabel(type)}** (\`${type}\`). Total in stock: **${totalNow}**.`,
        });
        return;
      }

      // ── /stock ────────────────────────────────────────────────────────────
      if (cmd === 'stock') {
        await interaction.reply({ embeds: [await buildStockEmbed(interaction.guild.id)], flags: 64 });
        return;
      }

      // ── /gensteam ─────────────────────────────────────────────────────────
      if (cmd === 'gensteam') {
        if (!await canAccessStock(interaction.member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = normalizeStockType(interaction.options.getString('type'));
        return await claimStockAccount(interaction, type);
      }

      // ── /postgensteam ────────────────────────────────────────────────────
      if (cmd === 'postgensteam') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('⚙️ Account Generator')
          .setDescription(
            `Click a button below to generate an account.\n\n` +
            `You need the **💎 Gen Member** role (or higher) to use this.\n` +
            `Limit: one account per person every **${STOCK_COOLDOWN_HOURS}h**, per account type. Staff/OVERSEER have no limit.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        // Chunked into rows of 5. Discord rejects the whole message if a row is
        // over-full, which would silently break the panel the moment someone
        // adds a fifth or sixth account type.
        const genButtons = GEN_PANEL_TYPES.map(t =>
          new ButtonBuilder().setCustomId(`gensteam_claim::${t.type}`).setLabel(t.label).setEmoji(t.emoji).setStyle(ButtonStyle.Primary)
        );
        const genRows = [];
        for (let i = 0; i < genButtons.length; i += 5) {
          genRows.push(new ActionRowBuilder().addComponents(...genButtons.slice(i, i + 5)));
        }
        const utilRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gensteam_check_stock').setLabel('Check Stock').setEmoji('📦').setStyle(ButtonStyle.Secondary)
        );

        // The generator panel is a post customers READ before they press
        // anything — the role they need and the cooldown they get are both in
        // it — so it carries the language dropdown like every other public
        // post. It was the one that got missed. withLanguageRow drops the row
        // rather than the panel if the account types ever grow past four rows
        // of buttons.
        await channel.send(withLanguageRow({ embeds: [embed], components: [...genRows, utilRow] }));
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
        const type = typeArg ? normalizeStockType(typeArg) : null;
        const { removed, types } = await clearStockDB(interaction.guild.id, type);

        if (type) {
          return interaction.reply({ content: `🗑️ Cleared **${removed}** account${removed === 1 ? '' : 's'} from **${stockTypeLabel(type)}**.`, flags: 64 });
        }
        return interaction.reply({
          content: `🗑️ Cleared **${removed}** account${removed === 1 ? '' : 's'} across **${types}** type${types === 1 ? '' : 's'}. Stock is now empty.`,
          flags: 64,
        });
      }

      // ── /postusefullinks ─────────────────────────────────────────────────
      if (cmd === 'postusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const embed = await buildUsefulLinksEmbed(interaction.guild.id);
        const links = await getUsefulLinks(interaction.guild.id);

        await channel.send(withLanguageRow({ embeds: [embed] }));
        await interaction.reply({ content: `✅ Posted **${links.length}** links in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /addusefullink ───────────────────────────────────────────────────
      if (cmd === 'addusefullink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const title = interaction.options.getString('title');
        const url   = interaction.options.getString('url');

        try { new URL(url); } catch (_) {
          return interaction.reply({ content: '❌ That doesn\'t look like a valid URL — make sure it starts with `https://`.', flags: 64 });
        }

        await addUsefulLink(interaction.guild.id, title, url);
        const links = await getUsefulLinks(interaction.guild.id);

        return interaction.reply({
          content: `✅ Added **${title}** as link **#${links.length}**. Run \`/postusefullinks\` to repost the updated list.`,
          flags: 64,
        });
      }

      // ── /removeusefullink ────────────────────────────────────────────────
      if (cmd === 'removeusefullink') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const number  = interaction.options.getInteger('number');
        const removed = await removeUsefulLinkByNumber(interaction.guild.id, number);

        if (!removed) {
          return interaction.reply({ content: `❌ No link at #${number}. Run \`/listusefullinks\` to see current numbers.`, flags: 64 });
        }

        return interaction.reply({
          content: `🗑️ Removed **${removed.label}**. Run \`/postusefullinks\` to repost the updated list.`,
          flags: 64,
        });
      }

      // ── /listusefullinks ─────────────────────────────────────────────────
      if (cmd === 'listusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        return interaction.reply({ embeds: [await buildUsefulLinksEmbed(interaction.guild.id)], flags: 64 });
      }

      // ── /clearusefullinks ────────────────────────────────────────────────
      if (cmd === 'clearusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const confirm = interaction.options.getBoolean('confirm');
        if (!confirm) {
          return interaction.reply({ content: '⚠️ Set `confirm` to **True** to actually clear the list — this cannot be undone.', flags: 64 });
        }

        const removed = await clearUsefulLinks(interaction.guild.id);
        return interaction.reply({ content: `🗑️ Cleared **${removed}** link${removed === 1 ? '' : 's'}. List is now empty.`, flags: 64 });
      }

      // ── /importusefullinks ───────────────────────────────────────────────
      if (cmd === 'importusefullinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });

        const attachment = interaction.options.getAttachment('file');
        const pasted      = interaction.options.getString('links');
        const mode         = interaction.options.getString('mode') || 'append';

        let raw = '';
        if (attachment) {
          try {
            const res = await fetch(attachment.url);
            raw += (await res.text()) + '\n';
          } catch (e) {
            console.error('importusefullinks file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
        }
        if (pasted) raw += pasted + '\n';

        if (!raw.trim()) {
          return interaction.editReply({ content: '❌ Provide either a `file` or paste `links` — one per line, formatted `Title - https://url`.' });
        }

        const { parsed, skipped } = parseUsefulLinksBulk(raw);

        if (!parsed.length) {
          return interaction.editReply({ content: '❌ No valid lines found. Each line needs to look like `Title - https://example.com`.' });
        }

        await bulkInsertUsefulLinks(interaction.guild.id, parsed, mode);
        const totalNow = (await getUsefulLinks(interaction.guild.id)).length;

        let msg = `✅ ${mode === 'replace' ? 'Replaced the list with' : 'Added'} **${parsed.length}** link${parsed.length === 1 ? '' : 's'}. Total now: **${totalNow}**.`;
        if (skipped.length) {
          msg += `\n⚠️ Skipped **${skipped.length}** line${skipped.length === 1 ? '' : 's'} that didn't match \`Title - https://url\`:\n` +
            skipped.slice(0, 5).map(l => `\`${l.slice(0, 80)}\``).join('\n') +
            (skipped.length > 5 ? `\n...and ${skipped.length - 5} more` : '');
        }
        msg += `\nRun \`/postusefullinks\` to repost the updated list.`;

        return interaction.editReply({ content: msg });
      }

      // ── /genkey ──────────────────────────────────────────────────────────
      if (cmd === 'genkey') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const role        = interaction.options.getRole('role');
        const durationStr = interaction.options.getString('duration');
        const amount      = interaction.options.getInteger('amount') || 1;

        const durationMs = parseKeyDuration(durationStr);
        if (durationMs === null) {
          return interaction.reply({ content: '❌ Invalid duration.', flags: 64 });
        }

        const durationLabel = DURATION_LABELS[durationStr] || durationStr;

        const generated = [];
        for (let i = 0; i < amount; i++) {
          const key = await generateKeyString();
          await createKeyRow({
            key,
            guildId: interaction.guild.id,
            roleId: role.id,
            roleName: role.name,
            durationMs,
            createdBy: interaction.user.id,
          });
          generated.push(key);
        }

        // Keys grant a paid role, so who minted them and for what is exactly
        // the kind of thing the gen log exists to answer. The key STRINGS stay
        // out of it — anyone who can read the channel could redeem one.
        logGeneration(client, {
          kind: 'key',
          user: interaction.user,
          what: `${amount} × ${role.name}`,
          detail: `Duration: ${durationLabel}`,
          source: '/genkey',
          guildId: interaction.guild && interaction.guild.id,
        }).catch(() => {});

        return interaction.reply({
          content: `✅ Generated **${amount}** key${amount === 1 ? '' : 's'} for **${role.name}** (${durationLabel}):\n` +
            generated.map(k => `\`${k}\``).join('\n') +
            `\n\nEach works once with \`/redeem\` — keep them safe.`,
          flags: 64,
        });
      }

      // ── /redeem ──────────────────────────────────────────────────────────
      if (cmd === 'redeem') {
        return redeemKey(interaction, interaction.options.getString('key'));
      }

      // ── /listkeys ────────────────────────────────────────────────────────
      if (cmd === 'listkeys') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const { rows } = await db.query(
          `SELECT * FROM keys WHERE guild_id = $1 AND status IN ('unredeemed','active') ORDER BY created_at DESC`,
          [interaction.guild.id]
        );
        const entries    = rows.map(rowToKeyEntry);
        const unredeemed = entries.filter(e => e.status === 'unredeemed');
        const active     = entries.filter(e => e.status === 'active');

        const fmtUnredeemed = unredeemed.length
          ? unredeemed.slice(0, 15).map(e => `\`${e.key}\` — ${e.roleName}`).join('\n') +
            (unredeemed.length > 15 ? `\n...and ${unredeemed.length - 15} more` : '')
          : 'None';

        const fmtActive = active.length
          ? active.slice(0, 15).map(e => {
              const expiry = e.expiresAt
                ? `expires <t:${Math.floor(new Date(e.expiresAt).getTime() / 1000)}:R>`
                : 'lifetime — never expires';
              return `<@${e.redeemedBy}> — ${e.roleName} — ${expiry}`;
            }).join('\n') + (active.length > 15 ? `\n...and ${active.length - 15} more` : '')
          : 'None';

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🔑 Keys')
          .addFields(
            { name: `Unredeemed (${unredeemed.length})`, value: fmtUnredeemed, inline: false },
            { name: `Active (${active.length})`, value: fmtActive, inline: false },
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /revokekey ───────────────────────────────────────────────────────
      if (cmd === 'revokekey') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const keyInput = interaction.options.getString('key').trim().toUpperCase();
        const entry = await getKeyEntry(keyInput);

        if (!entry) return interaction.reply({ content: '❌ That key doesn\'t exist.', flags: 64 });
        if (entry.status === 'revoked' || entry.status === 'expired') {
          return interaction.reply({ content: `❌ That key is already ${entry.status}.`, flags: 64 });
        }

        if (entry.status === 'active' && entry.redeemedBy) {
          try {
            const member = await interaction.guild.members.fetch(entry.redeemedBy).catch(() => null);
            const role   = interaction.guild.roles.cache.get(entry.roleId);
            if (member && role && member.roles.cache.has(role.id)) {
              await member.roles.remove(role);
            }
          } catch (e) { console.error('[keys] revoke role removal error:', e); }
        }

        await markKeyStatus(keyInput, 'revoked');
        return interaction.reply({ content: `🗑️ Key \`${keyInput}\` revoked.`, flags: 64 });
      }

      // ── /postredeem ──────────────────────────────────────────────────────
      if (cmd === 'postredeem') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🔑 Redeem Your Key')
          .setDescription(
            `**Instructions:**\n` +
            `• Click the button below to open the redeem form.\n` +
            `• Enter your key exactly as it was sent to you.\n` +
            `• Once submitted, your role will be activated automatically.\n\n` +
            `If you need help, open a support ticket.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('redeem_open_modal').setLabel('Redeem Key').setEmoji('🔑').setStyle(ButtonStyle.Primary)
        );

        await channel.send(withLanguageRow({ embeds: [embed], components: [row] }));
        await interaction.reply({ content: `✅ Posted the redeem panel in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /setupclaim (post the customer-role claim panel) ───────────────────
      if (cmd === 'setupclaim') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });

        const channel = interaction.options.getChannel('channel') || interaction.channel;

        const embed = new EmbedBuilder()
          .setColor(0x00ff88)
          .setTitle('🎫 Claim Your Customer Role')
          .setDescription(
            `Purchased from the store? Claim your **Customer** role here.\n\n` +
            `**How to claim:**\n` +
            `• Click **Claim** below.\n` +
            `• Enter your **Invoice ID** (order ID) and the **Email** you used at checkout.\n` +
            `• If they match a paid order, the Customer role is granted instantly.\n\n` +
            `Your Invoice ID and email are on your order confirmation.`
          )
          .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('claim_customer_open').setLabel('Claim').setEmoji('🎫').setStyle(ButtonStyle.Success)
        );

        await channel.send(withLanguageRow({ embeds: [embed], components: [row] }));
        await interaction.reply({ content: `✅ Posted the claim panel in <#${channel.id}>.`, flags: 64 });
        return;
      }

      // ── /set-tos, /set-rules, /set-guide ────────────────────────────────
      if (cmd === 'set-tos' || cmd === 'set-rules' || cmd === 'set-guide' || cmd === 'set-payment-method') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const key = cmd.replace('set-', '');
        const meta = CONTENT_TYPES[key];
        const attachment = interaction.options.getAttachment('file');

        if (attachment) {
          await interaction.deferReply({ ephemeral: true });
          let body;
          try {
            const res = await fetch(attachment.url);
            body = (await res.text()).trim();
          } catch (e) {
            console.error('set-content file fetch error:', e);
            return interaction.editReply({ content: '❌ Could not read that file.' });
          }
          if (!body) return interaction.editReply({ content: '❌ That file is empty.' });

          const existing = await getGuildContent(interaction.guild.id, key);
          const title = existing?.title || meta.defaultTitle;
          // 4000 was the modal's limit leaking into the file path. A file has
          // no such ceiling and the renderer pages anything over one embed, so
          // truncating here threw away terms the operator meant to publish.
          // 40k is a sanity bound, not a format limit.
          await setGuildContent(interaction.guild.id, key, title, body.slice(0, 40000), interaction.user.id);
          const preview = await buildContentEmbeds(interaction.guild.id, key);
          return interaction.editReply({
            content: `✅ ${meta.label} updated from file (${body.length} chars → ${preview.length} page(s)). ` +
              `This is exactly how \`/post-${key}\` will look:`,
            embeds: preview.slice(0, 10),
          });
        }

        // No file — open a popup form instead
        const existing = await getGuildContent(interaction.guild.id, key);
        const modal = new ModalBuilder().setCustomId(`set_content_modal::${key}`).setTitle(`Set ${meta.label}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('content_title').setLabel('Title').setStyle(TextInputStyle.Short)
              .setValue(existing?.title || meta.defaultTitle).setRequired(true).setMaxLength(256)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('content_body').setLabel('Content').setStyle(TextInputStyle.Paragraph)
              .setValue(existing?.body || '').setRequired(true).setMaxLength(4000)
          )
        );
        return interaction.showModal(modal);
      }

      // ── /post-tos, /post-rules, /post-guide ──────────────────────────────
      if (cmd === 'post-tos' || cmd === 'post-rules' || cmd === 'post-guide' || cmd === 'post-payment-method') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const key = cmd.replace('post-', '');
        const meta = CONTENT_TYPES[key];

        const embeds = await buildContentEmbeds(interaction.guild.id, key);
        if (!embeds) {
          return interaction.reply({ content: `❌ No ${meta.label} content set yet. Run \`/set-${key}\` first.`, flags: 64 });
        }

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        // 6000 characters across all embeds in one message is a hard Discord
        // limit, and exceeding it rejects the WHOLE message — the terms would
        // post as nothing at all. Send in runs that fit instead.
        // The dropdown goes on EVERY message of a paginated document, not just
        // the last: it translates the message it is attached to, so a reader
        // looking at page 2 needs one there to translate page 2.
        const messages = chunkEmbedsIntoMessages(embeds);
        for (const m of messages) await channel.send(withLanguageRow({ embeds: m }));

        await interaction.reply({
          content: `✅ Posted ${meta.label} in <#${channel.id}>` +
            (embeds.length > 1 ? ` — ${embeds.length} pages over ${messages.length} message(s).` : '.'),
          flags: 64,
        });
        return;
      }

      // ── /language ────────────────────────────────────────────────────────
      if (cmd === 'language') {
        const code = interaction.options.getString('language');
        const meta = translate.LANG_BY_CODE.get(code);
        if (!meta) return interaction.reply({ content: '❌ Unknown language.', flags: 64 });
        const saved = await translate.setUserLang(interaction.guildId || 'dm', interaction.user.id, code);
        if (!saved) {
          return interaction.reply({ content: '❌ Could not save that just now — try again in a moment.', flags: 64 });
        }
        // Answered in the language just chosen, translated by the same path
        // every post uses. If translation is down, this sentence arrives in
        // English — which is itself the honest signal that it is down.
        const body = code === translate.DEFAULT_LANG
          ? 'Done. Anything this bot sends you privately — order deliveries included — will be in English.'
          : await translate.translateText(
              'Done. Anything this bot sends you privately — order deliveries included — will be in this language from now on.'
              + ' Posts in the server stay in English for everyone; use the language dropdown under a post to read that one.',
              code);
        return interaction.reply({ content: `${meta.flag} **${meta.native}** — ${body}`, flags: 64 });
      }

      // ── /listguilds ──────────────────────────────────────────────────────
      if (cmd === 'listguilds') {
        if (!isBotOwner(interaction)) return interaction.reply({ content: '❌ Owner only.', flags: 64 });

        const guilds = [...client.guilds.cache.values()];
        const list = guilds
          .map(g => `**${g.name}**\nID: \`${g.id}\` · Members: ${g.memberCount} · Owner: <@${g.ownerId}>`)
          .join('\n\n');

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`🌐 In ${guilds.length} server${guilds.length === 1 ? '' : 's'}`)
          .setDescription(list.slice(0, 4000) || 'Not in any servers.')
          .setFooter({ text: 'Use /leaveguild guild_id:<id> to remove the bot from one' });

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /leaveguild ──────────────────────────────────────────────────────
      if (cmd === 'leaveguild') {
        if (!isBotOwner(interaction)) return interaction.reply({ content: '❌ Owner only.', flags: 64 });

        const targetId = interaction.options.getString('guild_id');
        const target = client.guilds.cache.get(targetId);
        if (!target) {
          return interaction.reply({ content: `❌ Not in a server with ID \`${targetId}\`. Check \`/listguilds\` for the exact ID.`, flags: 64 });
        }

        const name = target.name;
        await target.leave();
        return interaction.reply({ content: `✅ Left **${name}** (\`${targetId}\`).`, flags: 64 });
      }

      // ── /serverbackup ────────────────────────────────────────────────────
      if (cmd === 'serverbackup') {
        if (!interaction.guild) return interaction.reply({ content: '❌ Run this in a server.', flags: 64 });
        // Administrator, not hasAccess(). `restore` builds out an entire
        // server and `create` reads its whole permission layout into a row —
        // neither is a staff-shift task.
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator only.', flags: 64 });
        }
        const sub = interaction.options.getSubcommand();

        // ── create ──
        if (sub === 'create') {
          await interaction.deferReply({ flags: 64 });
          try {
            // The caches are what get read, and they are only complete if we
            // ask. A partial cache produces a snapshot that looks fine and is
            // missing half the server — the worst possible failure for a
            // backup, because it is only discovered at restore time.
            await interaction.guild.roles.fetch();
            await interaction.guild.channels.fetch();
            try { await interaction.guild.emojis.fetch(); } catch (_) {}

            const snap = serverBackup.snapshotGuild(interaction.guild);
            const counts = serverBackup.snapshotCounts(snap);
            const label = (interaction.options.getString('label') || '').slice(0, 120) || null;

            const { rows } = await db.query(
              `INSERT INTO guild_snapshots (guild_id, guild_name, label, taken_by, counts, data)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, taken_at`,
              [interaction.guild.id, interaction.guild.name, label, interaction.user.id,
               JSON.stringify(counts), JSON.stringify(snap)]);

            return interaction.editReply({ embeds: [new EmbedBuilder()
              .setColor(0x00d26a)
              .setTitle('📸 Snapshot saved')
              .setDescription(`**${interaction.guild.name}**${label ? `\n*${label}*` : ''}`)
              .addFields(
                { name: 'ID', value: `\`${rows[0].id}\``, inline: true },
                { name: 'Roles', value: String(counts.roles), inline: true },
                { name: 'Categories', value: String(counts.categories), inline: true },
                { name: 'Channels', value: String(counts.channels), inline: true },
                { name: 'Permission rules', value: String(counts.overwrites), inline: true },
                { name: 'Emojis', value: String(counts.emojis), inline: true },
              )
              .setFooter({ text: 'Structure and permissions only — message history is not included.' })
              .setTimestamp()] });
          } catch (err) {
            console.error('[ServerBackup] create failed:', err);
            return interaction.editReply({ content: `❌ Could not save the snapshot: ${err.message}` });
          }
        }

        // ── list ──
        if (sub === 'list') {
          await interaction.deferReply({ flags: 64 });
          // `data` is deliberately not selected: it is hundreds of KB per row,
          // and everything shown here lives in `counts`.
          const { rows } = await db.query(
            `SELECT id, guild_name, label, taken_by, taken_at, counts
               FROM guild_snapshots WHERE guild_id = $1 ORDER BY taken_at DESC LIMIT 20`,
            [interaction.guild.id]);
          if (!rows.length) {
            return interaction.editReply({ content: 'No snapshots yet. `/serverbackup create` takes one.' });
          }
          const body = rows.map(r => {
            const c = r.counts || {};
            return `\`${r.id}\` · <t:${Math.floor(new Date(r.taken_at).getTime() / 1000)}:f>` +
                   `${r.label ? ` · **${r.label}**` : ''}\n` +
                   `　${c.roles || 0} roles · ${c.categories || 0} categories · ${c.channels || 0} channels · by <@${r.taken_by}>`;
          }).join('\n\n');
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x5865F2).setTitle(`📚 Snapshots of ${interaction.guild.name}`)
            .setDescription(body.slice(0, 4000))
            .setFooter({ text: '/serverbackup view id:<ID> to see inside one' })] });
        }

        // ── view / export / delete / restore all need the row ──
        const snapId = interaction.options.getString('id');
        if (!/^\d{1,19}$/.test(String(snapId || ''))) {
          return interaction.reply({ content: '❌ That is not a snapshot ID. `/serverbackup list` shows them.', flags: 64 });
        }
        await interaction.deferReply({ flags: 64 });
        const { rows } = await db.query('SELECT * FROM guild_snapshots WHERE id = $1', [snapId]);
        const row = rows[0];
        if (!row) return interaction.editReply({ content: `❌ No snapshot with ID \`${snapId}\`.` });

        // A snapshot holds the full permission layout of a server. Reading one
        // taken elsewhere would let an admin of any guild the bot is in dump
        // another guild's structure — so the row is fetched by id alone (ids
        // are not guessable in sequence terms, but they ARE sequential) and
        // then checked. `restore` opts out of this on purpose; see below.
        const sameGuild = row.guild_id === interaction.guild.id;

        if (sub === 'delete') {
          if (!sameGuild) return interaction.editReply({ content: '❌ That snapshot belongs to another server.' });
          await db.query('DELETE FROM guild_snapshots WHERE id = $1', [snapId]);
          return interaction.editReply({ content: `🗑️ Snapshot \`${snapId}\` deleted.` });
        }

        if (sub === 'view') {
          if (!sameGuild) return interaction.editReply({ content: '❌ That snapshot belongs to another server.' });
          const snap = row.data;
          const cats = (snap.channels || []).filter(c => c.type === serverBackup.CH.GuildCategory);
          const byCat = new Map(cats.map(c => [c.id, []]));
          const loose = [];
          for (const c of (snap.channels || [])) {
            if (c.type === serverBackup.CH.GuildCategory) continue;
            (byCat.get(c.parentId) || loose).push(c);
          }
          const tree = cats.map(cat =>
            `**${cat.name}**\n` + ((byCat.get(cat.id) || []).map(c => `　#${c.name}`).join('\n') || '　*(empty)*')
          ).concat(loose.length ? [`**(no category)**\n` + loose.map(c => `　#${c.name}`).join('\n')] : []).join('\n');

          const roleNames = (snap.roles || []).filter(serverBackup.isRestorableRole)
            .map(r => r.name).filter(n => n !== '@everyone');

          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`🔎 Snapshot ${snapId}${row.label ? ` — ${row.label}` : ''}`)
            .setDescription(`Taken <t:${Math.floor(new Date(row.taken_at).getTime() / 1000)}:R> from **${row.guild_name}**`)
            .addFields(
              { name: `Roles (${roleNames.length})`, value: (roleNames.join(', ') || '—').slice(0, 1024) },
              { name: 'Structure', value: (tree || '—').slice(0, 1024) },
            )] });
        }

        if (sub === 'export') {
          if (!sameGuild) return interaction.editReply({ content: '❌ That snapshot belongs to another server.' });
          const buf = Buffer.from(JSON.stringify(row.data, null, 2), 'utf8');
          // 8MB is the floor on Discord's upload limit. A snapshot that big is
          // not something to truncate silently into an invalid JSON file.
          if (buf.length > 7.5 * 1024 * 1024) {
            return interaction.editReply({ content: `❌ That snapshot is ${(buf.length / 1048576).toFixed(1)}MB — too large to attach here.` });
          }
          return interaction.editReply({
            content: `📦 Snapshot \`${snapId}\` — structure and permissions only, no message history.`,
            files: [new AttachmentBuilder(buf, { name: `snapshot-${snapId}.json` })],
          });
        }

        if (sub === 'restore') {
          // The cross-guild case is the whole point of the feature — the
          // server is gone and this is being poured into a fresh one — so it
          // is allowed, but never by accident. It has to be asked for.
          const allowOther = interaction.options.getBoolean('allow_other_server') === true;
          if (!sameGuild && !allowOther) {
            return interaction.editReply({
              content: `❌ Snapshot \`${snapId}\` was taken in **${row.guild_name || 'another server'}** (\`${row.guild_id}\`), not this one.\n` +
                       `If that is deliberate — rebuilding a lost server here — run it again with \`allow_other_server: True\`.`,
            });
          }

          // Everything ticked to begin with — the old behaviour is still the
          // default, and untick is a deliberate act.
          return interaction.editReply(
            await buildRestoreConfirm(interaction.guild, row, snapId, allowOther, serverBackup.ALL_PARTS));
        }

        return interaction.editReply({ content: '❌ Unknown subcommand.' });
      }

      // ── /mirror ────────────────────────────────────────────────────────────
      if (cmd === 'mirror') {
        if (!interaction.guild) return interaction.reply({ content: '❌ Server only.', flags: 64 });
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator only.', flags: 64 });
        }
        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: 64 });

        // A relay points content INTO someone else's server. Being an admin
        // here is permission to send from this server; it is not permission to
        // put things in that one. So the destination is checked from the
        // destination's side: this bot must be in it, and the person asking
        // must be an admin there too.
        //
        // Without this, an admin of any server the bot joins could pipe an
        // unlimited feed into any other server it is in — including this one.
        const resolveDestination = async (channelId) => {
          if (!/^\d{17,20}$/.test(channelId)) return { error: 'That is not a channel ID. Right-click a channel → Copy Channel ID.' };
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (!ch) return { error: 'I cannot see that channel. Either the ID is wrong or I am not in that server.' };
          if (!ch.guild) return { error: 'That is not a channel in a server.' };
          if (typeof ch.isTextBased !== 'function' || !ch.isTextBased()) return { error: 'That channel cannot receive posts.' };

          const me = await ch.guild.members.fetchMe().catch(() => null);
          const perms = me ? ch.permissionsFor(me) : null;
          if (!perms || !perms.has(PermissionFlagsBits.SendMessages)) {
            return { error: `I cannot post in **#${ch.name}** (${ch.guild.name}). Give me Send Messages there first.` };
          }

          const them = await ch.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!them) return { error: `You are not in **${ch.guild.name}**. Only someone who administrates the receiving server can point a mirror at it.` };
          if (!them.permissions.has(PermissionFlagsBits.Administrator)
              && !them.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return { error: `You are not an admin of **${ch.guild.name}**. Being an admin here does not make it your call what gets posted there.` };
          }
          return { channel: ch, webhookable: !!(perms && perms.has(PermissionFlagsBits.ManageWebhooks)) };
        };

        // ── follow: Discord does the delivery ────────────────────────────────
        if (sub === 'follow') {
          const from = interaction.options.getChannel('from');
          const dest = await resolveDestination(interaction.options.getString('to_channel_id').trim());
          if (dest.error) return interaction.editReply({ content: `❌ ${dest.error}` });

          if (from.type !== ChannelType.GuildAnnouncement) {
            return interaction.editReply({ content:
              `❌ **#${from.name}** is not an Announcement channel, and Follow only works on those.\n\n` +
              'Two ways forward:\n' +
              `• Channel Settings on **#${from.name}** → turn on **Announcement Channel**, then run this again. Discord then delivers every published post itself — nothing to keep running, no permissions to keep granted.\n` +
              '• Or use `/mirror add`, which relays through me instead. Works on any channel, but only while I am online.' });
          }
          try {
            await from.addFollower(dest.channel.id, `Mirror requested by ${interaction.user.tag}`);
          } catch (e) {
            return interaction.editReply({ content:
              `❌ Discord refused the follow: ${e.message}\n\nI need **Manage Webhooks** in **#${dest.channel.name}** (${dest.channel.guild.name}) — that is what a follow creates.` });
          }
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x2ecc71).setTitle('✅ Following')
            .setDescription(`**#${from.name}** → **#${dest.channel.name}** in **${dest.channel.guild.name}**`)
            .addFields(
              { name: 'How this one works', value: 'Discord delivers it, not me. It keeps working if I go offline, and it costs nothing to run.' },
              { name: 'The catch', value: 'Only posts that are **Published** get through — someone has to press Publish on each one, or the post has to be made by something that publishes automatically. Posts made before now are not sent.' },
              { name: 'To undo', value: `Delete the webhook Discord made in **#${dest.channel.name}** (Channel Settings → Integrations).` })] });
        }

        // ── add: relay through the bot ───────────────────────────────────────
        if (sub === 'add') {
          const from = interaction.options.getChannel('from');
          if (typeof from.isTextBased !== 'function' || !from.isTextBased()) {
            return interaction.editReply({ content: `❌ **#${from.name}** is not a channel messages get posted in.` });
          }
          const dest = await resolveDestination(interaction.options.getString('to_channel_id').trim());
          if (dest.error) return interaction.editReply({ content: `❌ ${dest.error}` });

          // A block is the destination's standing answer, and it has to be
          // checked here rather than at relay time: /mirror add UPSERTs and
          // sets enabled = true, so without this, "remove" is undone by
          // whoever still holds admin at both ends.
          try {
            const { rows: [blocked] } = await db.query(
              'SELECT 1 FROM mirror_blocks WHERE guild_id = $1 AND blocked_guild_id = $2',
              [dest.channel.guild.id, interaction.guild.id]);
            if (blocked) {
              return interaction.editReply({ content:
                `❌ **${dest.channel.guild.name}** has blocked mirrors from this server. An admin there can lift it with \`/mirror unblock guild_id:${interaction.guild.id}\`.` });
            }
          } catch (e) { console.error('[mirror] block check failed:', e.message); }

          // The loop check, before the row exists. Named rather than just
          // refused: told "that would loop", an operator has to go find it.
          let existing = [];
          try { ({ rows: existing } = await db.query('SELECT * FROM mirror_routes WHERE enabled')); }
          catch (_) { /* an empty list only ever makes this check weaker, never wrong */ }
          const cycle = mirror.findCycle(existing, from.id, dest.channel.id);
          if (cycle) {
            const path = cycle.map(id => `<#${id}>`).join(' → ');
            return interaction.editReply({ content:
              `❌ That would make a loop:\n${path}\n\nThe two servers would post at each other until I am rate-limited off Discord, which stops every other command as well.` });
          }

          const botOnly = interaction.options.getBoolean('include_humans') !== true;
          const includeOtherBots = interaction.options.getBoolean('include_other_bots') === true;
          const allowPings = interaction.options.getBoolean('allow_pings') === true;
          const ratePerMin = interaction.options.getInteger('rate_per_min') || null;
          let row;
          try {
            ({ rows: [row] } = await db.query(
              `INSERT INTO mirror_routes (src_guild_id, src_channel_id, dst_guild_id, dst_channel_id, bot_only, include_other_bots, allow_pings, rate_per_min, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (src_channel_id, dst_channel_id) DO UPDATE
                 SET bot_only = EXCLUDED.bot_only, include_other_bots = EXCLUDED.include_other_bots,
                     allow_pings = EXCLUDED.allow_pings, rate_per_min = EXCLUDED.rate_per_min,
                     enabled = true, paused_reason = NULL, paused_at = NULL
               RETURNING *`,
              [interaction.guild.id, from.id, dest.channel.guild.id, dest.channel.id,
               botOnly, includeOtherBots, allowPings, ratePerMin, interaction.user.id]));
          } catch (e) {
            return interaction.editReply({ content: `❌ Could not save the route: ${e.message}` });
          }
          await loadMirrorRoutes(true);
          mirrorWebhookCache.delete(dest.channel.id);
          mirrorRate.clear(`r:${row.id}`);

          const notes = [];
          notes.push(!botOnly
            ? '**Every** message in this channel is copied, including ones people write.'
            : includeOtherBots
              ? 'Posts made by **any bot or webhook** here are copied. Messages people write are left here.'
              : 'Only posts **I** make are copied — not other bots, not webhooks, not people. That is deliberate: a webhook counts as a bot to Discord, so "any bot" would let anyone with Manage Webhooks here relay whatever they like.');
          notes.push(allowPings
            ? '`@everyone` in a copied post **will** ping the other server.'
            : '`@everyone` in a copied post is copied as text but **will not ping** the other server.');
          if (!dest.webhookable) {
            notes.push(`I do not have **Manage Webhooks** in **#${dest.channel.name}**, so copies will be posted under my own name instead of **${interaction.guild.name}**\'s. Grant it and they will wear the right identity.`);
          }
          notes.push('Buttons that only mean something in this server are removed on the way over. The translate dropdown is kept — it works anywhere.');
          notes.push('Edits and deletions here follow into the copy. Posts made before now are not sent.');
          notes.push(`Above **${ratePerMin || mirror.DEFAULT_RATE_PER_MIN} messages a minute** this route pauses itself and tells both ends why — so a compromised source server cannot use it as a firehose. \`/mirror resume id:${row.id}\` restarts it.`);

          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x2ecc71).setTitle('✅ Mirror added')
            .setDescription(`**#${from.name}** → **#${dest.channel.name}** in **${dest.channel.guild.name}**\nRoute \`#${row.id}\``)
            .addFields({ name: 'What this does', value: notes.map(n => `• ${n}`).join('\n').slice(0, 1024) })
            .setFooter({ text: 'This relay only runs while I am online. /mirror test sends one through now.' })] });
        }

        // ── list ─────────────────────────────────────────────────────────────
        if (sub === 'list') {
          let rows;
          try {
            ({ rows } = await db.query(
              'SELECT * FROM mirror_routes WHERE src_guild_id = $1 OR dst_guild_id = $1 ORDER BY id',
              [interaction.guild.id]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not read the routes: ${e.message}` }); }
          if (!rows.length) {
            return interaction.editReply({ content:
              'No mirrors set up.\n\n`/mirror follow` — announcement channels, delivered by Discord itself.\n`/mirror add` — any channel, relayed by me.' });
          }
          const out = rows.map(r => {
            const dir = r.src_guild_id === interaction.guild.id ? 'out' : 'in';
            return `${dir === 'out' ? '📤' : '📥'} ${mirror.describeRoute(r, id => `<#${id}>`)}`;
          });
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x5865f2).setTitle('🔁 Mirrors')
            .setDescription(out.join('\n').slice(0, 4000))
            .setFooter({ text: '📤 leaves this server • 📥 arrives here • /mirror remove id:<ID> stops one' })] });
        }

        // ── remove ───────────────────────────────────────────────────────────
        if (sub === 'remove') {
          const id = interaction.options.getString('id').replace(/^#/, '').trim();
          if (!/^\d+$/.test(id)) return interaction.editReply({ content: '❌ That is not a route ID. `/mirror list` shows them.' });
          let row;
          try {
            // Either end can stop a mirror. The receiving server especially:
            // being unable to turn off an inbound feed would make this a way
            // to spam a server permanently.
            ({ rows: [row] } = await db.query(
              `DELETE FROM mirror_routes
                WHERE id = $1 AND (src_guild_id = $2 OR dst_guild_id = $2) RETURNING *`,
              [id, interaction.guild.id]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not remove it: ${e.message}` }); }
          if (!row) return interaction.editReply({ content: '❌ No route with that ID involves this server.' });
          await loadMirrorRoutes(true);
          mirrorWebhookCache.delete(row.dst_channel_id);
          return interaction.editReply({ content:
            `✅ Stopped route \`#${row.id}\` — <#${row.src_channel_id}> no longer copies into <#${row.dst_channel_id}>.\n` +
            'Copies already posted are left where they are; removing a mirror does not delete anything.' });
        }

        // ── resume ───────────────────────────────────────────────────────────
        // The other half of an automatic pause. Deliberately manual: a route
        // that paused itself because 300 messages arrived in a minute should
        // stay off until a person has looked at the source channel and decided
        // it was a restock and not a raid. A timer would just re-open the tap
        // every few minutes for as long as the flood lasts.
        if (sub === 'resume') {
          const id = interaction.options.getString('id').replace(/^#/, '').trim();
          if (!/^\d+$/.test(id)) return interaction.editReply({ content: '❌ That is not a route ID. `/mirror list` shows them.' });
          let row;
          try {
            ({ rows: [row] } = await db.query(
              'SELECT * FROM mirror_routes WHERE id = $1 AND (src_guild_id = $2 OR dst_guild_id = $2)',
              [id, interaction.guild.id]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not read the route: ${e.message}` }); }
          if (!row) return interaction.editReply({ content: '❌ No route with that ID involves this server.' });
          if (row.enabled !== false) return interaction.editReply({ content: `ℹ️ Route \`#${row.id}\` is already running.` });

          // A block belongs to the receiving server, so the sending server does
          // not get to undo it by resuming. Without this check the source end
          // could walk straight back through a door the destination shut.
          try {
            const { rows: [blocked] } = await db.query(
              'SELECT 1 FROM mirror_blocks WHERE guild_id = $1 AND blocked_guild_id = $2',
              [row.dst_guild_id, row.src_guild_id]);
            if (blocked) {
              return interaction.editReply({ content:
                `❌ The receiving server has blocked mirrors from **${row.src_guild_id}**. An admin **there** has to run \`/mirror unblock guild_id:${row.src_guild_id}\` first.` });
            }
          } catch (e) { console.error('[mirror] resume block check failed:', e.message); }

          try {
            await db.query(
              'UPDATE mirror_routes SET enabled = true, paused_reason = NULL, paused_at = NULL WHERE id = $1',
              [row.id]);
          } catch (e) { return interaction.editReply({ content: `❌ Could not resume it: ${e.message}` }); }
          await loadMirrorRoutes(true);
          // The old counts are not evidence about the next minute, and leaving
          // them would trip the limit again on the first message through.
          mirrorRate.clear(`r:${row.id}`);
          mirrorRate.clear(`g:${row.dst_guild_id}`);
          return interaction.editReply({ content:
            `✅ Route \`#${row.id}\` is running again — <#${row.src_channel_id}> → <#${row.dst_channel_id}>.` +
            (row.paused_reason ? `\nIt had been paused because: ${row.paused_reason}` : '') +
            '\nMessages posted while it was paused are **not** backfilled.' });
        }

        // ── panic ────────────────────────────────────────────────────────────
        // One command, no IDs. The situation this is for is an admin watching a
        // channel scroll faster than they can read a route number off it, at an
        // hour when nobody wants to reason about direction flags. Inbound is
        // stopped by default because that is the damage being done to *this*
        // server; outbound is opt-in because stopping it punishes the servers
        // downstream for something happening here.
        if (sub === 'panic') {
          const outboundToo = interaction.options.getBoolean('outbound_too') === true;
          const reason = `panic stop by ${interaction.user.tag} in ${interaction.guild.name}`;
          let rows;
          try {
            ({ rows } = await db.query(
              outboundToo
                ? `UPDATE mirror_routes SET enabled = false, paused_reason = $2, paused_at = now()
                     WHERE enabled AND (dst_guild_id = $1 OR src_guild_id = $1) RETURNING *`
                : `UPDATE mirror_routes SET enabled = false, paused_reason = $2, paused_at = now()
                     WHERE enabled AND dst_guild_id = $1 RETURNING *`,
              [interaction.guild.id, reason]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not stop them: ${e.message}` }); }
          await loadMirrorRoutes(true);
          for (const r of rows) {
            mirrorRate.clear(`r:${r.id}`);
            mirrorWebhookCache.delete(r.dst_channel_id);
          }
          if (!rows.length) {
            return interaction.editReply({ content:
              `✅ Nothing was running${outboundToo ? '' : ' into this server'}. Nothing to stop.` +
              (outboundToo ? '' : '\nRelays *leaving* this server are untouched — add `outbound_too:true` to stop those as well.') });
          }
          const lines = rows.map(r => `\`#${r.id}\` <#${r.src_channel_id}> → <#${r.dst_channel_id}>`);
          const srcGuilds = [...new Set(rows.filter(r => r.src_guild_id !== interaction.guild.id).map(r => r.src_guild_id))];
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0xe74c3c).setTitle(`⛔ ${rows.length} relay${rows.length === 1 ? '' : 's'} stopped`)
            .setDescription(lines.join('\n').slice(0, 3000))
            .addFields({ name: 'This is a pause, not a removal', value:
              'The routes still exist and `/mirror resume id:<ID>` restarts any of them.\n' +
              (srcGuilds.length
                ? `If a **source server** is compromised, pausing is not enough — whoever holds admin at both ends can add a new route. \`/mirror block guild_id:${srcGuilds[0]}\` refuses that server permanently.`
                : 'Use `/mirror remove id:<ID>` to delete one outright.') })] });
        }

        // ── block ────────────────────────────────────────────────────────────
        // Removing a route is not durable on its own: /mirror add UPSERTs and
        // sets enabled = true, so anyone still holding admin at both ends can
        // re-add exactly what was just removed. This is keyed on the GUILD and
        // not the channel, because the channel is the part they can change in
        // two clicks.
        if (sub === 'block') {
          const gid = interaction.options.getString('guild_id').trim();
          if (!/^\d{5,25}$/.test(gid)) return interaction.editReply({ content: '❌ That is not a server ID. `/mirror list` shows the routes; the ID is the server the copies come from.' });
          if (gid === interaction.guild.id) return interaction.editReply({ content: '❌ That is this server. Blocking yourself would stop your own outbound relays being accepted anywhere.' });
          let killed = [];
          try {
            await db.query(
              `INSERT INTO mirror_blocks (guild_id, blocked_guild_id, created_by) VALUES ($1,$2,$3)
                 ON CONFLICT (guild_id, blocked_guild_id) DO NOTHING`,
              [interaction.guild.id, gid, interaction.user.id]);
            // A block that left the live route running would be a sign on a
            // door that is still open.
            ({ rows: killed } = await db.query(
              `DELETE FROM mirror_routes WHERE dst_guild_id = $1 AND src_guild_id = $2 RETURNING *`,
              [interaction.guild.id, gid]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not block it: ${e.message}` }); }
          await loadMirrorRoutes(true);
          for (const r of killed) { mirrorRate.clear(`r:${r.id}`); mirrorWebhookCache.delete(r.dst_channel_id); }
          return interaction.editReply({ content:
            `⛔ **${gid}** is blocked. Nothing from that server can be mirrored here, and \`/mirror add\` pointed at this server will be refused.\n` +
            (killed.length
              ? `${killed.length} live route${killed.length === 1 ? '' : 's'} removed: ${killed.map(r => `\`#${r.id}\``).join(', ')}.\n`
              : 'No live routes from it existed.\n') +
            `Lift it with \`/mirror unblock guild_id:${gid}\`.` });
        }

        // ── unblock ──────────────────────────────────────────────────────────
        if (sub === 'unblock') {
          const gid = interaction.options.getString('guild_id').trim();
          if (!/^\d{5,25}$/.test(gid)) return interaction.editReply({ content: '❌ That is not a server ID.' });
          let row;
          try {
            ({ rows: [row] } = await db.query(
              'DELETE FROM mirror_blocks WHERE guild_id = $1 AND blocked_guild_id = $2 RETURNING *',
              [interaction.guild.id, gid]));
          } catch (e) { return interaction.editReply({ content: `❌ Could not lift it: ${e.message}` }); }
          if (!row) return interaction.editReply({ content: `ℹ️ **${gid}** was not blocked here.` });
          return interaction.editReply({ content:
            `✅ **${gid}** is no longer blocked. Nothing has been re-created — an admin of that server has to run \`/mirror add\` again.` });
        }

        // ── test ─────────────────────────────────────────────────────────────
        if (sub === 'test') {
          const from = interaction.options.getChannel('from');
          const routes = (await loadMirrorRoutes(true)).get(from.id) || [];
          if (!routes.length) return interaction.editReply({ content: `❌ Nothing is mirrored out of **#${from.name}**.` });

          // A real post through the real path — the point is to find out
          // whether permissions and webhooks actually work, which a dry run
          // by definition cannot tell you.
          const probe = await from.send({ embeds: [new EmbedBuilder()
            .setColor(0x5865f2).setTitle('🔁 Mirror test')
            .setDescription(`Sent by ${interaction.user.tag} to check the relay. Safe to delete.`)
            .setTimestamp()] }).catch(e => ({ error: e.message }));
          if (probe.error) return interaction.editReply({ content: `❌ I cannot even post in **#${from.name}**: ${probe.error}` });

          // The listener will have relayed it; give it a moment, then report
          // what actually landed rather than what should have.
          await new Promise(r => setTimeout(r, 2500));
          let copies = [];
          try {
            ({ rows: copies } = await db.query(
              'SELECT route_id, dst_message_id FROM mirror_messages WHERE src_message_id = $1', [probe.id]));
          } catch (_) {}
          const byRoute = new Map(copies.map(c => [String(c.route_id), c.dst_message_id]));
          const lines = routes.map(r => byRoute.has(String(r.id))
            ? `✅ \`#${r.id}\` → <#${r.dst_channel_id}>`
            : `❌ \`#${r.id}\` → <#${r.dst_channel_id}> — nothing arrived, check the log`);
          return interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(byRoute.size === routes.length ? 0x2ecc71 : 0xe67e22)
            .setTitle(`Mirror test — ${byRoute.size}/${routes.length} arrived`)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: 'The test post is still in the source channel — delete it and the copies go with it.' })] });
        }

        return interaction.editReply({ content: '❌ Unknown subcommand.' });
      }

      if (cmd === 'statusupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('setstatus_modal').setTitle('Status Update');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_product').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_status').setLabel('STATUS (updating > updated / detected)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_notes').setLabel('NOTES (optional, separate with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_ping').setLabel('PING ROLE (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }

      // ── /config (shop payment backend, ported from p-bot) ──────────────────
      if (cmd === 'config') {
        // Owner-only: /config set rewrites BTC_XPUB, LTC_XPUB, PAYPAL_EMAIL,
        // CASHAPP_CASHTAG and the Gmail credentials through the backend. A
        // staff member who can change the xpub can take every crypto payment.
        if (!hasOwnerAccess(interaction)) {
          return interaction.reply({ content: '❌ Only the server owner/admin can change payment configuration.', flags: 64 });
        }
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === 'view') {
          try {
            const res = await axios.get(`${BACKEND_URL}/api/config`);
            const cfg = res.data;
            const embed = new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('⚙️ Shop Payment Backend Config')
              .addFields(
                { name: '🏪 Store Name',      value: cfg.store_name || 'Not set',        inline: true },
                { name: '💵 Cash App',        value: cfg.cashapp_cashtag || '❌ Not set', inline: true },
                { name: '🅿️ PayPal',          value: cfg.paypal_email || '❌ Not set',    inline: true },
                { name: '💸 Cash App Fee',    value: `${cfg.cashapp_fee}%`,               inline: true },
                { name: '💸 PayPal Fee',      value: `${cfg.paypal_fee}%`,                inline: true },
                { name: '📉 Crypto Discount', value: `${cfg.crypto_discount}%`,           inline: true },
                { name: '₿ BTC Enabled',      value: cfg.payment_methods.btc ? '✅' : '❌', inline: true },
                { name: 'Ł LTC Enabled',      value: cfg.payment_methods.ltc ? '✅' : '❌', inline: true },
              )
              .setFooter({ text: 'Use /config set to update values' }).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            return interaction.editReply({ content: `❌ Failed to fetch config: ${err.message}` });
          }
        }

        if (sub === 'set') {
          const CONFIG_KEYS = {
            cashapp:  { key: 'CASHAPP_CASHTAG',        label: 'Cash App Cashtag' },
            paypal:   { key: 'PAYPAL_EMAIL',            label: 'PayPal Email' },
            gmail:    { key: 'GMAIL_USER',              label: 'Gmail Address' },
            gmailpw:  { key: 'GMAIL_PASSWORD',          label: 'Gmail App Password' },
            store:    { key: 'STORE_NAME',              label: 'Store Name' },
            cashfee:  { key: 'CASHAPP_FEE_PERCENT',     label: 'Cash App Fee %' },
            payfee:   { key: 'PAYPAL_FEE_PERCENT',      label: 'PayPal Fee %' },
            cryptodc: { key: 'CRYPTO_DISCOUNT_PERCENT', label: 'Crypto Discount %' },
            btcxpub:  { key: 'BTC_XPUB',                label: 'BTC xPub Key' },
            ltcxpub:  { key: 'LTC_XPUB',                label: 'LTC xPub Key' },
            // logchan removed on purpose. ORDER_LOG_CHANNEL_ID is set directly
            // in Railway (owner's decision, 2026-07-26) and the backend now
            // rejects it as an env-only key. Leaving the option here would have
            // let one slash command write a `config` row that silently
            // overrides Railway at boot and sends the whole order feed to the
            // wrong channel — the exact failure this audit started from.
          };
          const setting = interaction.options.getString('setting');
          const value = interaction.options.getString('value');
          if (setting === 'logchan') {
            return interaction.editReply({
              content: '❌ The order log channel is set in Railway, not here.\n'
                + 'Set `ORDER_LOG_CHANNEL_ID` on the SUPERBOT service and redeploy — '
                + 'storing it in the database would override the Railway value at boot.',
            });
          }
          const meta = CONFIG_KEYS[setting];
          if (!meta) return interaction.editReply({ content: '❌ Unknown setting.' });

          try {
            await axios.post(`${BACKEND_URL}/api/config/update`, { secret: API_SECRET, key: meta.key, value });
            const embed = new EmbedBuilder()
              .setColor(0x00ff00).setTitle('✅ Config Updated')
              .addFields(
                { name: 'Setting', value: meta.label, inline: true },
                { name: 'Value', value: setting === 'gmailpw' ? '`[hidden]`' : `\`${value}\``, inline: true },
              ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            return interaction.editReply({ content: `❌ Failed to update: ${err.message}` });
          }
        }
      }

      // ── /order (shop payment backend, ported from p-bot) ───────────────────
      if (cmd === 'order') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const order_id = interaction.options.getString('order_id');

        if (sub === 'lookup') {
          try {
            // GET /api/orders/:id is gated on the public ref, the owning
            // session, staff, or the bot's secret. This request carried NONE of
            // those, so it got the same 404 as a stranger enumerating ids — the
            // command could not have worked for anyone since that route was
            // hardened, whatever id was typed.
            const res = await axios.get(`${BACKEND_URL}/api/orders/${encodeURIComponent(order_id)}`, {
              params: { secret: API_SECRET }, timeout: 10000,
            });
            const o = res.data;
            const statusEmoji = { waiting: '⏳', paid: '💰', underpaid: '⚠️', delivered: '✅', expired: '❌', cancelled: '🚫' }[o.status] || '❓';

            // Every field below is nullable on a real row — an order that never
            // reached a payment method has payment_method null, and
            // `.toUpperCase()` on it threw INSIDE this try, which the catch then
            // reported as "Order not found". A present order must not be able to
            // render as a missing one.
            //
            // Timestamps go out as Discord markers rather than
            // `toLocaleString()`: that renders in the CONTAINER's timezone (UTC
            // on Railway), so staff read a time that is not theirs and not the
            // customer's. `<t:…:f>` is rendered by each viewer's own client.
            const when = t => {
              const d = t ? new Date(t) : null;
              return d && !isNaN(d.getTime()) ? `<t:${Math.floor(d.getTime() / 1000)}:f>` : '—';
            };
            const money = n => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2)}`);
            const dash = v => (v == null || v === '' ? '—' : String(v));
            // An embed field caps at 1024 characters and Discord rejects the
            // whole message if one goes over — so a 40-item order must lose
            // lines, and it must SAY it lost them. Silent truncation in a staff
            // lookup reads as "that is the whole order", which is exactly the
            // wrong thing to believe while answering a customer.
            const block = (lines, cap = 1024) => {
              const kept = [];
              let len = 0;
              for (const line of lines) {
                if (len + line.length + 1 > cap - 40) break;
                kept.push(line); len += line.length + 1;
              }
              if (kept.length < lines.length) kept.push(`_… ${lines.length - kept.length} more not shown_`);
              return kept.join('\n') || '—';
            };

            const embed = new EmbedBuilder()
              .setColor(o.status === 'delivered' ? 0x00ff00 : o.status === 'waiting' ? 0xffff00 : o.status === 'paid' ? 0x00b0f4 : 0xff0000)
              .setTitle(`${statusEmoji} Order ${o.invoice_no || `#${o.order_id || order_id}`}`)
              .addFields(
                { name: 'Status',    value: String(o.status || 'unknown').toUpperCase(), inline: true },
                { name: 'Payment',   value: String(o.payment_method || '—').toUpperCase(), inline: true },
                { name: 'Delivered', value: o.delivered ? '✅ Yes' : '❌ No', inline: true },
              );

            // The customer block only arrives when the backend recognised this
            // request as privileged. Rendering the headings unconditionally
            // would print a row of em-dashes that looks like an order with no
            // buyer, rather than a reply that was not entitled to say.
            if (o.email || o.discord_id || o.web_user_id) {
              embed.addFields({
                name: '👤 Customer',
                value: block([
                  `**Email:** ${dash(o.email)}`,
                  `**Discord:** ${o.discord_id ? `<@${o.discord_id}> \`${o.discord_id}\`` : '—'}`,
                  `**Web account:** ${o.web_user_id ? `#${o.web_user_id}` : '—'}`,
                ]),
              });
            }

            const moneyLines = [`**Subtotal:** ${money(o.subtotal)}`];
            if (o.coupon_code) moneyLines.push(`**Coupon:** \`${o.coupon_code}\` −${money(o.coupon_discount)}`);
            if (o.fee) moneyLines.push(`**Fee:** ${money(o.fee)}`);
            moneyLines.push(`**Total:** ${money(o.total)}`);
            if (o.amount_received != null) {
              // What was actually received against what was owed — the number
              // that decides whether an order is short, and by how much.
              const native = o.amount_received_native ? ` (${o.amount_received_native} ${o.amount_received_unit || ''})`.trimEnd() : '';
              const delta = o.total != null ? Number(o.amount_received) - Number(o.total) : null;
              const note = delta == null || Math.abs(delta) < 0.005 ? ''
                : delta < 0 ? ` — ⚠️ short ${money(Math.abs(delta))}` : ` — over by ${money(delta)}`;
              moneyLines.push(`**Received:** ${money(o.amount_received)}${native}${note}`);
            }
            if (o.paid_from_balance) moneyLines.push('**Paid from store balance:** ✅');
            embed.addFields({ name: '💵 Money', value: block(moneyLines) });

            embed.addFields({
              name: '🕒 Timeline',
              value: block([
                `**Created:** ${when(o.created_at)}`,
                `**Paid:** ${when(o.paid_at)}`,
                `**Delivered:** ${when(o.delivered_at)}`,
                `**Expires:** ${when(o.expires_at)}`,
              ]),
            });

            const items = Array.isArray(o.items) ? o.items : [];
            if (items.length) {
              embed.addFields({
                name: `🛒 Items (${items.length})`,
                value: block(items.map(it => {
                  const name = it.name || it.product_name || 'Unknown product';
                  // `name` on the snapshot usually already carries the tier —
                  // "Punisher Phone External Bo7 (Day)" — so only append the
                  // tier when it is not already in there.
                  const tier = it.tier_label && !String(name).toLowerCase().includes(String(it.tier_label).toLowerCase())
                    ? ` [${it.tier_label}]` : '';
                  return `• **${it.qty || 1}×** ${name}${tier} — ${money(it.price)}`;
                })),
              });
            }

            const goods = Array.isArray(o.delivered_goods) ? o.delivered_goods : [];
            if (goods.length) {
              const lines = [];
              for (const g of goods) {
                const tier = g.tier_label ? ` [${g.tier_label}]` : '';
                lines.push(`• **${g.qty || 1}×** ${g.product || 'Unknown product'}${tier}`);
                for (const k of (Array.isArray(g.items) ? g.items : [])) lines.push(`\`${k}\``);
              }
              embed.addFields({ name: '📦 Delivered', value: block(lines) });
            }

            // Everything needed to find this payment in PayPal, Cash App or on
            // chain, which is the whole reason staff run this command when an
            // order is stuck.
            const payLines = [];
            if (o.crypto_address)   payLines.push(`**Address:** \`${o.crypto_address}\``);
            if (o.payment_note)     payLines.push(`**Note / memo:** \`${o.payment_note}\``);
            if (o.provider_txn_id)  payLines.push(`**Txn id:** \`${o.provider_txn_id}\``);
            if (o.external_ref)     payLines.push(`**External ref:** \`${o.external_ref}\``);
            if (payLines.length) embed.addFields({ name: '🔗 Payment detail', value: block(payLines) });

            embed.setTimestamp();
            if (o.invoice_no && o.order_id) embed.setFooter({ text: `Internal id #${o.order_id}` });
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            const msg = (err.response && err.response.data && err.response.data.error) || err.message;
            return interaction.editReply({ content: `❌ Order \`${order_id}\` not found or error: ${msg}` });
          }
        }

        if (sub === 'forceconfirm') {
          try {
            await axios.post(`${BACKEND_URL}/api/orders/confirm`, { secret: API_SECRET, order_id, amount_received: 0, method: 'manual' });
            const embed = new EmbedBuilder()
              .setColor(0x00ff00).setTitle('✅ Order Force Confirmed')
              .setDescription(`Order \`${order_id}\` has been manually confirmed and delivery triggered.`)
              .setFooter({ text: `Confirmed by ${interaction.user.tag}` }).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            return interaction.editReply({ content: `❌ Failed: ${err.message}` });
          }
        }
      }

      // ── /shopstock (shop payment backend stock — renamed from p-bot's
      // /stock to avoid colliding with the existing Steam key-stock /stock) ──
      if (cmd === 'shopstock') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
          const product_id = interaction.options.getString('product_id');
          const items = interaction.options.getString('items').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
          try {
            const res = await axios.post(`${BACKEND_URL}/api/stock/add`, { secret: API_SECRET, product_id, items });
            const embed = new EmbedBuilder()
              .setColor(0x00ff00).setTitle('✅ Stock Added')
              .addFields(
                { name: 'Product ID', value: product_id, inline: true },
                { name: 'Items Added', value: `${res.data.added}`, inline: true },
              ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            return interaction.editReply({ content: `❌ Failed: ${err.message}` });
          }
        }

        if (sub === 'check') {
          const product_id = interaction.options.getString('product_id');
          try {
            const res = await axios.get(`${BACKEND_URL}/api/stock/${product_id}`);
            const embed = new EmbedBuilder()
              .setColor(res.data.available > 0 ? 0x00ff00 : 0xff0000).setTitle('📦 Stock Status')
              .addFields(
                { name: 'Product ID', value: product_id, inline: true },
                { name: 'Available', value: `${res.data.available}`, inline: true },
              ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            return interaction.editReply({ content: `❌ Failed: ${err.message}` });
          }
        }
      }

      // ── /web-balance (website wallet — view / adjust) ──────────────────────
      if (cmd === 'web-balance') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('user');

        if (sub === 'view') {
          try {
            const res = await axios.get(`${BACKEND_URL}/api/balance/by-discord/${target.id}`, { params: { secret: API_SECRET } });
            const b = res.data;
            const embed = new EmbedBuilder()
              .setColor(0x00ff88).setTitle('💳 Website Balance')
              .addFields(
                { name: 'Account', value: b.username || 'N/A', inline: true },
                { name: 'Email', value: b.email || 'N/A', inline: true },
                { name: 'Balance', value: `$${Number(b.balance).toFixed(2)}`, inline: true },
                { name: 'Discord', value: `<@${target.id}>`, inline: true },
              ).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            return interaction.editReply({ content: `❌ ${msg}` });
          }
        }

        if (sub === 'adjust') {
          const amount = interaction.options.getNumber('amount');
          const reason = interaction.options.getString('reason') || `Manual adjustment by ${interaction.user.tag}`;
          if (!amount || amount === 0) return interaction.editReply({ content: '❌ Amount must be non-zero.' });
          const amount_cents = Math.round(amount * 100);
          try {
            const res = await axios.post(`${BACKEND_URL}/api/balance/adjust`, {
              secret: API_SECRET, discord_id: target.id, amount_cents, description: reason,
            });
            const embed = new EmbedBuilder()
              .setColor(amount >= 0 ? 0x00ff00 : 0xffb400)
              .setTitle(amount >= 0 ? '➕ Balance Credited' : '➖ Balance Debited')
              .addFields(
                { name: 'User', value: `<@${target.id}>`, inline: true },
                { name: 'Change', value: `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`, inline: true },
                { name: 'New Balance', value: `$${Number(res.data.balance).toFixed(2)}`, inline: true },
                { name: 'Reason', value: reason, inline: false },
              ).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            return interaction.editReply({ content: `❌ ${msg}` });
          }
        }
      }

      // ── /webstatus (website product status) ────────────────────────────────
      if (cmd === 'webstatus') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const game_name = interaction.options.getString('game_name');
        const product_name = interaction.options.getString('product_name');
        const status = interaction.options.getString('status');
        const note = interaction.options.getString('note') || null;
        try {
          await axios.post(`${BACKEND_URL}/api/status/update`, {
            secret: API_SECRET, game_name, product_name, status, note,
          });
          // 🧪 for testing rather than another coloured circle — the three
          // circles are already spoken for and a fourth would read as one of
          // them at a glance.
          const emoji = { undetected: '🟢', testing: '🧪', updating: '🟡', detected: '🔴' }[status] || '⚪';
          const embed = new EmbedBuilder()
            .setColor({ undetected: 0x00ff00, testing: 0x00b8ff, updating: 0xffb400, detected: 0xff0000 }[status] || 0x979c9f)
            .setTitle(`${emoji} Website Status Updated`)
            .addFields(
              { name: 'Product', value: `${game_name} — ${product_name}`, inline: false },
              { name: 'Status', value: status.toUpperCase(), inline: true },
            ).setFooter({ text: `By ${interaction.user.tag}` }).setTimestamp();
          if (note) embed.addFields({ name: 'Note', value: note, inline: false });
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          return interaction.editReply({ content: `❌ ${msg}` });
        }
      }

      // ── /webreviews (moderate website reviews) ─────────────────────────────
      if (cmd === 'webreviews') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
          try {
            const res = await axios.get(`${BACKEND_URL}/api/reviews/admin/all`, { params: { secret: API_SECRET } });
            const reviews = res.data.reviews || [];
            if (!reviews.length) return interaction.editReply({ content: 'No reviews submitted yet.' });
            // Pending first, then most recent, cap at 15 for embed size.
            reviews.sort((a, b) => (a.approved === b.approved ? 0 : a.approved ? 1 : -1));
            const lines = reviews.slice(0, 15).map(r => {
              const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
              const flag = r.approved ? '✅' : '🕗 PENDING';
              const body = (r.body || '').replace(/\n/g, ' ').slice(0, 80);
              return `\`#${r.id}\` ${flag} ${stars} — **${r.display_name || 'Anon'}**: ${body}`;
            });
            const embed = new EmbedBuilder()
              .setColor(0x5865F2).setTitle('📝 Website Reviews')
              .setDescription(lines.join('\n'))
              .setFooter({ text: 'Use /webreviews approve|reject|delete <review_id>' }).setTimestamp();
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            return interaction.editReply({ content: `❌ ${msg}` });
          }
        }

        const review_id = interaction.options.getString('review_id');
        if (sub === 'approve' || sub === 'reject') {
          try {
            await axios.patch(`${BACKEND_URL}/api/reviews/${review_id}/approve`, {
              secret: API_SECRET, approved: sub === 'approve',
            });
            return interaction.editReply({ content: `${sub === 'approve' ? '✅ Approved' : '🚫 Unapproved'} review \`#${review_id}\`.` });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            return interaction.editReply({ content: `❌ ${msg}` });
          }
        }
        if (sub === 'delete') {
          try {
            await axios.delete(`${BACKEND_URL}/api/reviews/${review_id}`, { params: { secret: API_SECRET } });
            return interaction.editReply({ content: `🗑 Deleted review \`#${review_id}\`.` });
          } catch (err) {
            const msg = err.response?.data?.error || err.message;
            return interaction.editReply({ content: `❌ ${msg}` });
          }
        }
      }

      // ── /claim-customer (verify a paid order → grant customer role) ────────
      if (cmd === 'claim-customer') {
        await interaction.deferReply({ ephemeral: true });
        const order_id = interaction.options.getString('order_id');
        const email = interaction.options.getString('email');
        const otherUser = interaction.options.getUser('user');
        // Only staff may grant the role to someone other than themselves.
        if (otherUser && otherUser.id !== interaction.user.id && !hasAccess(interaction)) {
          return interaction.editReply({ content: '❌ Only staff can grant the role to another member.' });
        }
        const targetMember = otherUser && hasAccess(interaction)
          ? await interaction.guild.members.fetch(otherUser.id).catch(() => null)
          : interaction.member;
        if (!targetMember) return interaction.editReply({ content: '❌ Could not resolve the target member.' });

        try {
          // Verified against the TARGET, not the caller — otherwise staff
          // granting on someone's behalf would verify themselves, and the
          // account the order gets attached to would be the wrong one.
          const v = await claimOrderFor(targetMember, order_id, email);
          if (!v.success) return interaction.editReply({ content: claimRefusal(v, order_id) });

          const role = await resolveCustomerRole(interaction.guild);
          if (!role) return interaction.editReply({ content: '❌ The customer role is not configured for this server — set it in the web panel (Settings → Customer role).' });

          const failure = await grantCustomerRole(targetMember, role);
          if (failure) {
            return interaction.editReply({ content: `⚠️ Order \`${v.invoice_no || order_id}\` is verified and attached to their account, but I could not add the role: ${failure}` });
          }
          const embed = new EmbedBuilder()
            .setColor(0x00ff88).setTitle('✅ Customer Verified')
            // Echo the canonical invoice number the backend matched, not the
            // string as typed — it confirms which order was actually claimed
            // when a customer supplies the old numeric id.
            .setDescription(`<@${targetMember.id}> has been granted the <@&${role.id}> role for order \`${v.invoice_no || order_id}\`.`)
            .addFields({
              name: 'Site account',
              value: v.account_created
                ? `Created **${v.username}** — they can sign in at uhservices.xyz with **SIGN IN WITH DISCORD**.`
                : `Linked to **${v.username}**.`,
              inline: false,
            }, {
              name: 'Orders attached',
              value: v.orders_attached === 1 ? '1 order' : `${v.orders_attached} orders`,
              inline: true,
            })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          return interaction.editReply({ content: `❌ Order not found or error: ${msg}` });
        }
      }

      // ── /web-promote (grant website roles, incl. admin panel access) ───────
      // The bot holds API_SECRET (the "master key" on Railway), so a Discord
      // Administrator can set a website account's role without being logged
      // into the site — which is both how you hand someone admin panel access
      // and how you recover from an admin lockout. Gated to Administrator both
      // by setDefaultMemberPermissions and this server-side check (the former
      // alone is a UI hint that server settings can override).
      if (cmd === 'web-promote') {
        await interaction.deferReply({ ephemeral: true });
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.editReply({ content: '❌ Administrator only.' });
        }
        if (!API_SECRET) {
          return interaction.editReply({ content: '❌ API_SECRET is not configured on the bot — cannot reach the backend.' });
        }
        const targetUser = interaction.options.getUser('user');
        const username = interaction.options.getString('username');
        const role = interaction.options.getString('role');

        if (!targetUser && !username) {
          return interaction.editReply({ content: '❌ Pick a Discord member in `user`, or type a website `username` / email. One of the two is required.' });
        }
        if (targetUser && username) {
          return interaction.editReply({ content: '❌ Give **either** `user` **or** `username`, not both — they could point at two different accounts.' });
        }

        // Snowflakes stay STRINGS end to end. A 19-digit Discord id exceeds
        // Number.MAX_SAFE_INTEGER, so any numeric round-trip silently rewrites
        // it into a different, non-existent id.
        const payload = targetUser
          ? { secret: API_SECRET, discord_id: String(targetUser.id), role }
          : { secret: API_SECRET, username, role };
        const label = targetUser ? `<@${targetUser.id}>` : `\`${username}\``;

        try {
          const res = await axios.post(`${BACKEND_URL}/api/auth/set-role`, payload);
          const u = res.data?.user || {};
          const prev = res.data?.previous_role;
          const embed = new EmbedBuilder()
            .setColor(0x00ff88).setTitle('✅ Website Role Updated')
            .setDescription(
              `**${u.username || username}** is now **${u.role || role}** on the website.` +
              (prev && prev !== (u.role || role) ? `\nPrevious role: \`${prev}\`` : '')
            )
            .setFooter({ text: 'Set via bot — API_SECRET' })
            .setTimestamp();
          if ((u.role || role) === 'admin') {
            embed.addFields({
              name: 'Admin panel access',
              value: 'They log in to the site as normal, then unlock the panel with the panel password (set in Railway).',
            });
          } else if ((u.role || role) === 'staff') {
            // Staff have no second password to be handed. The role IS the
            // access, so this says what appears and what it does — otherwise
            // the natural next question is "what do I send them?", and the
            // honest answer (nothing) reads like the command half-worked.
            embed.addFields({
              name: 'Staff panel access',
              value:
                'No password to send — the role is the access. They log in to the site as normal and a **🛡 shield** appears in the dock; ' +
                'it opens the admin panel limited to **Tickets**, **Status Manager** and **Downloads Manager**.\n' +
                'They can edit and hide, but **not delete** anything. Set them back to `member` here to revoke it — it takes effect on their next click.',
            });
          }
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          const status = err.response?.status;
          const msg = err.response?.data?.error || err.message;
          // The backend's 404 for a Discord lookup already explains that the
          // account has to be linked first, so pass it through rather than
          // flattening it to a generic "not found".
          if (status === 404) return interaction.editReply({ content: `❌ ${msg} (${label})` });
          if (status === 409) return interaction.editReply({ content: `❌ ${msg}` });
          if (status === 429) return interaction.editReply({ content: '❌ Rate limited by the backend — wait a minute and try again.' });
          return interaction.editReply({ content: `❌ Could not set role: ${msg}` });
        }
      }

      // ── /post-status (post ALL website product statuses, in sync w/ site) ──
      if (cmd === 'post-status') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const targetCh = interaction.options.getChannel('channel') || interaction.channel;
        try {
          const built = await buildStatusPanel();
          if (!built) return interaction.editReply({ content: '❌ No product statuses to post.' });

          // Take the previous panel down first. Two panels would both keep
          // refreshing themselves, and only one of them is the one anybody is
          // actually looking at — the other becomes a second source of truth
          // that stays convincingly up to date.
          //
          // THIS GUILD'S previous panel. Looking it up without the guild is
          // what made posting here delete the other server's panel.
          const prev = await loadStatusPanelRef(interaction.guildId);
          if (prev && prev.channel_id) {
            try {
              const ch = await client.channels.fetch(prev.channel_id);
              for (const id of prev.message_ids || []) {
                try { const m = await ch.messages.fetch(id); await m.delete(); } catch (_) {}
              }
            } catch (_) { /* channel gone — nothing to clean up */ }
          }

          const ids = [];
          for (const embeds of built.messages) {
            const sent = await targetCh.send({ embeds });
            ids.push(sent.id);
          }
          await saveStatusPanelRef(interaction.guildId, targetCh.id, ids);
          statusPanelSignatures.set(interaction.guildId, built.signature);

          const mins = Math.max(1, Math.round(STATUS_PANEL_REFRESH_MS / 60000));
          return interaction.editReply({
            content: `✅ Posted ${built.count} product statuses to ${targetCh}.\n`
              + `It **keeps itself up to date** from now on — re-checked every ${mins} min and edited in place, `
              + `and updated straight away whenever \`/postupdate\` changes a status. You should not need to run this again.`,
          });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          return interaction.editReply({ content: `❌ Could not post statuses: ${msg}` });
        }
      }

      // ── /post-status-vault (post vault product stock: IN STOCK / SOLD OUT) ──
      if (cmd === 'post-status-vault') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ ephemeral: true });
        const targetCh = interaction.options.getChannel('channel') || interaction.channel;
        try {
          // Vault catalog = products flagged vault=true. Each row is a priced
          // tier (id = tier_id) joined with its parent product, same shape as
          // GET /api/products.
          const res = await axios.get(`${BACKEND_URL}/api/products/vault`);
          const rows = Array.isArray(res.data) ? res.data : [];
          const tiers = rows.filter(r => r.id != null);
          if (!tiers.length) return interaction.editReply({ content: '❌ No vault products to post.' });

          // One bulk stock lookup for every vault tier → tier_id: available.
          let stock = {};
          try {
            const ids = Array.from(new Set(tiers.map(t => t.id))).join(',');
            const sr = await axios.get(`${BACKEND_URL}/api/stock/bulk?ids=${ids}`);
            stock = (sr.data && sr.data.stock) || {};
          } catch (e) { /* stock lookup failed — treat all as 0 below */ }

          const availFor = t => {
            const n = stock[t.id];
            return typeof n === 'number' ? n : 0;
          };

          // Roll tiers up to their parent product. A vault item like a VPN has
          // several plan tiers that all deliver from the same key pool, so one
          // line per tier listed the same product 4-5 times and tripled the
          // embed for no extra information.
          const products = new Map();
          tiers.forEach(t => {
            const key = t.product_id != null ? String(t.product_id) : `${t.category}||${t.product_name}`;
            const p = products.get(key) || { category: t.category || 'VAULT', name: t.product_name || t.name, avail: 0 };
            p.avail += availFor(t);
            products.set(key, p);
          });
          const items = Array.from(products.values());

          let inStockCount = 0, soldOutCount = 0;
          items.forEach(p => { p.avail > 0 ? inStockCount++ : soldOutCount++; });

          // Group by category (game_name) so the embed mirrors the vault page.
          const byCat = {};
          items.forEach(p => {
            const c = p.category || 'VAULT';
            (byCat[c] = byCat[c] || []).push(p);
          });

          const fields = Object.keys(byCat).sort().map(cat => ({
            name: cat,
            value: byCat[cat]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(p => {
                const badge = p.avail > 0 ? `🟢 **IN STOCK**${p.avail <= 5 ? ` · ${p.avail} left` : ''}` : '🔴 **SOLD OUT**';
                return `${badge} — ${p.name}`;
              }).join('\n'),
            inline: false,
          }));

          const header = new EmbedBuilder()
            .setColor(0x00ffe7)
            .setTitle('🔐 VAULT STOCK')
            .setDescription(`🟢 ${inStockCount} In Stock  •  🔴 ${soldOutCount} Sold Out`)
            .setFooter({ text: `${BOT_NAME}${SITE_URL ? ' | ' + SITE_URL : ''}`, iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

          await sendEmbedBatches(targetCh, header, packEmbedFields(fields, 0x00ffe7));
          return interaction.editReply({ content: `✅ Posted ${items.length} vault products to ${targetCh}.` });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          return interaction.editReply({ content: `❌ Could not post vault stock: ${msg}` });
        }
      }
    }

    // ── Select menus ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      // Language dropdown — first, and deliberately knowing nothing about which
      // post it is on. It translates the embeds of the message it was clicked
      // from, which is what makes it work on posts written long before it
      // existed and on posts nobody has thought of yet.
      // `startsWith`, not `===`: a dropdown sent into a DM appends the guild it
      // came from (`xlate_lang::<guildId>`) so the choice is remembered where
      // the order-delivery path will look for it.
      if (interaction.customId === 'xlate_lang' || interaction.customId.startsWith('xlate_lang::')) {
        // The one thing it is told about the message: which of the words in it
        // are catalogue keys. deliveryEmbed recognises its own delivery DM and
        // hands back the product, game and term it wrote; every other post
        // gets an empty list and translates exactly as before.
        return translate.handleLanguageSelect(interaction, {
          chunkEmbedsIntoMessages,
          protectFor: (message) => (message && message.embeds || [])
            .flatMap(e => protectFromEmbed(e.toJSON ? e.toJSON() : (e.data || e))),
        });
      }

      // What to restore from a snapshot. Re-renders the confirmation with the
      // new selection: the numbers in it are re-planned against the live guild
      // so they describe what the button under them will actually do, and the
      // choice is carried in that button's customId rather than in a Map here.
      if (interaction.customId.startsWith('sbparts::')) {
        if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator only.', flags: 64 });
        }
        const [, snapId, allowOther] = interaction.customId.split('::');
        await interaction.deferUpdate();
        const { rows } = await db.query('SELECT * FROM guild_snapshots WHERE id = $1', [snapId]);
        if (!rows[0]) return interaction.editReply({ embeds: [], components: [], content: `❌ Snapshot \`${snapId}\` is gone.` });
        return interaction.editReply(
          await buildRestoreConfirm(interaction.guild, rows[0], snapId, allowOther === '1', interaction.values));
      }

      // /product-info's category → product pair. Both live in the module so the
      // browse panel posted into a channel keeps working across restarts with
      // no state here at all.
      if (await handleProductInfoSelect(interaction)) return;

      // Steam stock — type chosen from the postgensteam panel dropdown
      if (interaction.customId === 'gensteam_select_type') {
        if (!await canAccessStock(interaction.member)) {
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
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('status_transition').setLabel(isTimeExt ? 'TIME ADDED (e.g. 12 hours, 3 days)' : 'STATUS (updating > updated / detected)').setStyle(TextInputStyle.Short).setRequired(isTimeExt).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('NOTES (separate bullet points with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('custom_title').setLabel('CUSTOM TITLE (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('IMAGE URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
        );
        await interaction.showModal(modal);
        try { await interaction.deleteReply(); } catch (_) {}
        return;
      }

      // Download page select
      // The panel can now be up to 5 pages, and a panel posted before that
      // change is still sitting in #downloads with the old three.
      if (/^dl_page_[1-5]$/.test(interaction.customId)) {
        const product = getProduct(interaction.values[0]);
        if (!product) {
          // Product ids are slugs of the product NAME now, not the old
          // hand-written ids, so an option in a panel message posted before
          // this change no longer resolves. Say what to do about it instead of
          // a bare "not found" that reads like the product was deleted.
          return interaction.reply({
            content: '❌ This download panel is out of date — ask an admin to run `/setupdownloads` again.',
            flags: 64,
          });
        }
        const embed = new EmbedBuilder().setTitle(`📦  ${product.label || product.name}`).setColor(0x57F287)
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

      // Website-ticket buttons first: they are posted into the ticket log
      // channel by modules/webTickets.js and are answered before
      // getGuildSettings, which hits the DB on every button press and is not
      // needed for them.
      if (await handleWebTicketButton(interaction)) return;

      // "How do I pay?" on the payment panel. Also before getGuildSettings —
      // it answers from /api/config and needs nothing from this guild's row.
      if (await handleStorefrontButton(interaction)) return;

      // 📢 Show everyone, on a private product card. Reads the catalogue, not
      // this guild's settings.
      if (await handleProductInfoButton(interaction)) return;

      // "How do I get notified?" / "How do I record a clip?" — both answer from
      // static text and need nothing from this guild's settings row.
      if (await handleCommunityButton(interaction)) return;

      // Server-snapshot restore. Answered before getGuildSettings for the same
      // reason: it does not need it, and this is a long job that should not
      // start with an avoidable DB round trip.
      if (customId === 'sbrestore_cancel') {
        return interaction.update({ content: 'Cancelled — nothing was changed.', embeds: [], components: [] });
      }
      if (customId.startsWith('sbrestore::')) {
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Administrator only.', flags: 64 });
        }
        // A fourth segment is what to restore. A button from before the
        // selector existed has three, and `null` there means everything —
        // which is exactly what that button promised when it was posted.
        const [, snapId, allowOther, parts] = customId.split('::');
        return runRestore(interaction, snapId, allowOther === '1', parts == null ? null : serverBackup.decodeParts(parts));
      }

      const btnSettings = await getGuildSettings(guild.id);

      // Steam stock panel — one of the fixed type buttons (Steam / Steam Phone
      // Verified / Email: Outlook)
      if (customId.startsWith('gensteam_claim::')) {
        if (!await canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }
        const type = customId.split('::')[1];
        return claimStockAccount(interaction, type);
      }

      // Steam stock panel — Check Stock button
      if (customId === 'gensteam_check_stock') {
        return interaction.reply({ embeds: [await buildStockEmbed(guild.id)], flags: 64 });
      }

      // Legacy single "Generate Account" button, kept for any panel posted
      // before the 4-button layout — safe to leave in even after re-posting.
      // Redeem panel — opens the key-entry modal
      if (customId === 'redeem_open_modal') {
        const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('🔑 Redeem Key');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('redeem_key_input')
              .setLabel('Your Key')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('UH-XXXX-XXXX-XXXX')
              .setRequired(true)
              .setMaxLength(64)
          )
        );
        return interaction.showModal(modal);
      }

      // Claim panel — opens the Invoice ID + Email modal
      if (customId === 'claim_customer_open') {
        const modal = new ModalBuilder().setCustomId('claim_customer_modal').setTitle('🎫 Claim Customer Role');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('claim_order_id')
              .setLabel('Invoice ID')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Your order / invoice ID')
              .setRequired(true)
              .setMaxLength(64)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('claim_email')
              .setLabel('Email used at checkout (optional)')
              .setStyle(TextInputStyle.Short)
              // An order handed over by staff can have no address on it, and a
              // required field the buyer cannot possibly fill is what made
              // their own paid order unclaimable. Leaving it blank falls back
              // to the Discord account named on the order. Round 29 item 6.
              .setPlaceholder('you@example.com — leave blank to claim by Discord')
              .setRequired(false)
              .setMaxLength(120)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === 'gensteam_open') {
        if (!await canAccessStock(member)) {
          return interaction.reply({ content: `❌ You need the **💎 Gen Member** role to generate an account.`, flags: 64 });
        }

        const types = (await getStockTypes(guild.id)).filter(t => t.count > 0);
        if (!types.length) {
          return interaction.reply({ content: '❌ No stock is currently available for any account type. Check back later!', flags: 64 });
        }

        // Only one type in stock — skip the picker and claim immediately.
        if (types.length === 1) {
          return claimStockAccount(interaction, types[0].type);
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('gensteam_select_type')
          .setPlaceholder('Choose an account type')
          .addOptions(types.map(t =>
            new StringSelectMenuOptionBuilder().setLabel(t.type).setValue(t.type).setDescription(`${t.count} available`)
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
        // Update button label with new count. update() REPLACES the component
        // list, so the language row has to be sent again or the first person to
        // enter takes the translator away from everyone after them.
        const updatedRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('giveaway_enter').setLabel(`🎉 Participate (${gw.participants.size})`).setStyle(ButtonStyle.Primary),
        );
        await interaction.update(withLanguageRow({ components: [updatedRow] }));
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
        const verifiedRole = (btnSettings.verifiedRoleId && guild.roles.cache.get(btnSettings.verifiedRoleId))
          || guild.roles.cache.find(r => r.name === btnSettings.verifiedRoleName);
        if (!verifiedRole) { await interaction.reply({ content: '⚠️ Verified role not found.', ephemeral: true }); autoDelete(interaction, 5000); return; }
        if (member.roles.cache.has(verifiedRole.id)) { await interaction.reply({ content: '✅ You are already verified!', ephemeral: true }); autoDelete(interaction, 5000); return; }
        // Was `catch (_) { reply('❌ Something went wrong.') }` — the one thing
        // a member could not act on and staff could not diagnose. assignRole
        // names the cause instead; see its comment for the two hierarchy rules.
        const why = await assignRole(member, verifiedRole, 'Verify button');
        if (why) { await interaction.reply({ content: `❌ I could not verify you — ${why}`, flags: 64 }); return; }
        await interaction.reply({ content: '🎉 You have been verified! Welcome!', ephemeral: true }); autoDelete(interaction, 5000);
        return;
      }

      // Get invite link
      if (customId === 'get_invite_link') {
        try {
          const invCh = (btnSettings.invitesChannelId && guild.channels.cache.get(btnSettings.invitesChannelId))
            || findChannelByName(guild, btnSettings.invitesChannelName)
            || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
          const invite = await invCh.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Invite link for ${member.user.tag}` });
          const cache = inviteCache.get(guild.id) || new Map();
          cache.set(invite.code, { inviterId: member.user.id, uses: 0 });
          inviteCache.set(guild.id, cache);
          const embed = new EmbedBuilder().setTitle('🔗 Your Personal Invite Link')
            .setDescription(`Your **permanent** invite link:\n\n**https://discord.gg/${invite.code}**\n\nEvery **${btnSettings.invitesNeeded} real invites** = 1 free key 🔑\nThis link never expires and is unique to you!`)
            .setColor(0x5865f2).setTimestamp();
          await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        } catch (_) { await interaction.reply({ content: '❌ Could not create invite.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Check invites
      if (customId === 'check_invites') {
        const data = getUserInviteData(guild.id, member.user.id);
        const N = btnSettings.invitesNeeded;
        const available = Math.floor(data.real / N) - data.usedKeys;
        const filled = Math.min(data.real % N, N);
        const bar = '█'.repeat(filled) + '░'.repeat(N - filled);
        const next = data.real % N === 0 && data.real > 0 ? 'Ready to redeem! 🎁' : `${N - (data.real % N)} more needed`;
        const embed = new EmbedBuilder().setTitle('📊 Your Invite Stats')
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }))
          .setDescription(`**Progress:**\n${bar} ${data.real % N}/${N}\n\n**Next Reward:** ${next}\n\n📨 **Total** — ${data.total}\n✅ **Real** — ${data.real}\n🎁 **Available Keys** — ${available}\n🔑 **Used Keys** — ${data.usedKeys}\n👋 **Left** — ${data.left}\n🚫 **Fake** — ${data.fake}`)
          .setColor(0x5865f2).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        return;
      }

      // Redeem key
      if (customId === 'redeem_key') {
        const data = getUserInviteData(guild.id, member.user.id);
        const N = btnSettings.invitesNeeded;
        const available = Math.floor(data.real / N) - data.usedKeys;
        if (available <= 0) {
          const needed = N - (data.real % N);
          await interaction.reply({ content: `❌ Need **${N} invites**. You have **${data.real}**. ${needed} more needed!`, ephemeral: true }); autoDelete(interaction, 5000); return;
        }
        data.usedKeys++;
        // Persisted before the confirmation goes out: this counter is the only
        // thing standing between a member and redeeming the same reward again.
        await saveInviteStats(guild.id, member.user.id);
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
      // Reply-to-website-ticket modal (modules/webTickets.js)
      if (await handleWebTicketModal(interaction)) return;

      // The two member-facing panel modals: "I'm going live" and "Make a
      // suggestion" (modules/communityPanels.js). Both ungated on purpose —
      // they are the half of those panels that members use.
      if (await handleCommunityModal(interaction)) return;

      // Redeem panel modal
      if (interaction.customId === 'redeem_modal') {
        const keyInput = interaction.fields.getTextInputValue('redeem_key_input');
        return redeemKey(interaction, keyInput);
      }

      // Claim panel modal — verify a paid order → grant the Customer role
      if (interaction.customId === 'claim_customer_modal') {
        await interaction.deferReply({ ephemeral: true });
        const order_id = interaction.fields.getTextInputValue('claim_order_id').trim();
        // Optional since round 29 item 6 — an order delivered by hand can carry
        // no address, and the Discord account below proves the claim without one.
        const email = (interaction.fields.getTextInputValue('claim_email') || '').trim();
        try {
          const v = await claimOrderFor(interaction.member, order_id, email);
          if (!v.success) {
            return interaction.editReply({
              content: claimRefusal(v, order_id,
                '\nUse the address from your order confirmation — if you no longer have it, open a support ticket and staff can grant the role.'),
            });
          }

          const role = await resolveCustomerRole(interaction.guild);
          if (!role) return interaction.editReply({ content: '❌ The customer role is not configured for this server — staff can set it in the web panel (Settings → Customer role). Open a ticket and staff can grant it manually in the meantime.' });

          const failure = await grantCustomerRole(interaction.member, role);
          if (failure) {
            return interaction.editReply({ content: `⚠️ Invoice \`${v.invoice_no || order_id}\` is verified and attached to your account, but I could not add the role: ${failure}\nOpen a support ticket and staff can grant it manually.` });
          }
          const VIA = { discord: 'Discord account on the order', account: 'Your site account', email: 'Email on the order' };
          const embed = new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle('✅ Claim Successful')
            .addFields(
              { name: 'Invoice ID', value: `\`${v.invoice_no || order_id}\``, inline: true },
              { name: 'User', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Verified by', value: VIA[v.via] || 'Order record', inline: true },
              { name: 'Role Added', value: `<@&${role.id}>`, inline: false },
              // The point of the whole item: the order stops being a loose
              // invoice number and starts being something they can open.
              {
                name: v.account_created ? '🆕 Account created' : '👤 Your account',
                value: v.account_created
                  ? `**${v.username}** — sign in at https://uhservices.xyz with **SIGN IN WITH DISCORD** to see your orders and redeem your keys. No password needed.`
                  : `**${v.username}** — your orders are at https://uhservices.xyz/account`,
                inline: false,
              },
              {
                name: 'Orders now on your account',
                value: v.orders_attached === 1
                  ? 'This one.'
                  : `${v.orders_attached} orders, including this one.`,
                inline: false,
              },
            )
            .setFooter({ text: BOT_NAME, iconURL: client.user.displayAvatarURL() })
            .setTimestamp();
          return interaction.editReply({ embeds: [embed] });
        } catch (err) {
          const msg = err.response?.data?.error || err.message;
          return interaction.editReply({ content: `❌ Invoice not found or error: ${msg}` });
        }
      }

      // TOS/Rules/Guide content modal
      if (interaction.customId.startsWith('set_content_modal::')) {
        const key = interaction.customId.split('::')[1];
        const title = interaction.fields.getTextInputValue('content_title');
        const body  = interaction.fields.getTextInputValue('content_body');
        await setGuildContent(interaction.guild.id, key, title, body, interaction.user.id);
        // Show the rendered result, not just a tick. "It saved" was never in
        // doubt — what the operator could not see was what it would look like,
        // which is the thing that was actually wrong.
        const preview = await buildContentEmbeds(interaction.guild.id, key);
        return interaction.reply({
          content: `✅ ${CONTENT_TYPES[key].label} saved to the database. This is exactly how \`/post-${key}\` will look:`,
          embeds: preview.slice(0, 10),
          flags: 64,
        });
      }

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

        // Bullets when the admin wrote a pipe-separated list, prose when they
        // pasted prose. The old code did the first unconditionally, which is
        // how `# ⚠️ INJECTION ERROR FIX` came out as `• # ⚠️ INJECTION ERROR FIX`.
        const notes = formatNotes(notesRaw);
        const embedColor = newStatus ? newStatus.color : getProductColor(product);
        const fields = [
          { name: 'Product', value: `\`${product}\``, inline: false },
          { name: 'Type',    value: `${typeInfo.emoji}  ${typeInfo.label}`, inline: false },
        ];
        if ((typeKey === 'time_extension' || typeKey === 'new_feature') && statusRaw) fields.push({ name: 'Time Added', value: statusRaw, inline: false });
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: true }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: true }); }
        else if (newStatus) fields.push({ name: 'Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        // A field value is capped at 1024 characters and going over REJECTS the
        // whole message. A long paste is prose, and prose belongs in the
        // description (4096) — so it moves rather than being cut.
        const longNotes = notes && !fitsField(notes);
        if (notes && !longNotes) fields.push({ name: 'Notes', value: notes, inline: false });

        const embed = new EmbedBuilder()
          .setTitle((customTitle ? customTitle.toUpperCase() : product.toUpperCase()))
          .setColor(embedColor).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (longNotes) embed.setDescription(clampDescription(notes));
        if (imageUrl) embed.setThumbnail(imageUrl);

        const productData = getProductByName(product);
        const downloadUrl = productData ? (productData.url || '') : '';
        const buttonRow = downloadUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(downloadUrl).setStyle(ButtonStyle.Link)) : null;
        // The preview card. Discord unfurls a link in the plain content and
        // never one inside an embed — that is the whole difference between the
        // post the user liked and the post they were shown. The download link
        // is skipped: it already has a button, and a second card for it would
        // be the same address twice.
        const previewContent = withPreview('', notes, { skip: [downloadUrl, imageUrl] });
        const payload = { embeds: [embed], ...(previewContent ? { content: previewContent } : {}), ...(buttonRow ? { components: [buttonRow] } : {}) };

        // Deferred because the sync below is two more network calls, and a
        // modal reply has about three seconds before Discord declares the
        // interaction dead and the admin sees "This interaction failed"
        // despite everything having worked.
        await interaction.deferReply({ flags: 64 });

        // The embed announces that the status changed. This is what makes it
        // true. Until now /postupdate told the server a product was updating
        // while the website's status page — and the /post-status panel next to
        // it — went on saying whatever they said before, and the only way to
        // reconcile them was to remember to go and do it by hand.
        let siteSync = null;
        if (newStatus) {
          const key = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus);
          siteSync = await syncStatusToSite(product, key);
        }

        try {
          const posted = await interaction.channel.send(withLanguageRow(payload));
          await interaction.editReply({ content: `✅ Update posted to <#${interaction.channel.id}>${describeSync(siteSync)}` });
          // A warning needs long enough to actually be read.
          autoDelete(interaction, siteSync && !siteSync.ok ? 30000 : 5000);
          // The modal has an image_url field, but only for people who already
          // host the picture somewhere. This is for the far commoner case: the
          // screenshot is sitting on the poster's desktop.
          offerImageUpload({ interaction, message: posted, embed, fileBase: `update-${posted.id}` });
        } catch (err) { await interaction.editReply({ content: `❌ Failed: ${err.message}${describeSync(siteSync)}` }); autoDelete(interaction, 12000); }
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

        const body = normalizeMarkdown(message);
        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (title) embed.setTitle(title);
        embed.setDescription(clampDescription(body)).setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const buttonRow = dlUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(dlUrl).setStyle(ButtonStyle.Link)) : null;
        try {
          // The ping and, under it, any link from the body as a bare URL — the
          // only place Discord will draw a preview card for it.
          const posted = await targetCh.send(withLanguageRow({ content: withPreview(pingText, body, { skip: [dlUrl] }), embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) }));
          await interaction.reply({ content: `✅ Announcement posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
          // Offered here even when the announcement went to another channel:
          // the admin is typing in THIS one, so this is where they can drop a
          // file. autoDelete only removes the reply above, not the follow-up.
          offerImageUpload({ interaction, message: posted, embed, fileBase: `announce-${posted.id}` });
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
        const ssNotes = formatNotes(notesRaw);
        const ssLong = ssNotes && !fitsField(ssNotes);
        if (ssNotes && !ssLong) fields.push({ name: 'Notes', value: ssNotes, inline: false });
        const embed = new EmbedBuilder().setTitle('Status Change').setColor(getProductColor(product)).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (ssLong) embed.setDescription(clampDescription(ssNotes));
        const statusCh = findChannelByName(interaction.guild, 'statusupdates') || interaction.channel;
        let pingText = '@everyone';
        if (pingStr) { const clean = pingStr.replace('@','').trim().toLowerCase(); if (clean==='everyone') pingText='@everyone'; else if (clean==='here') pingText='@here'; else { const rm=pingStr.match(/\d+/); if(rm) pingText=`<@&${rm[0]}>`; else { const r=interaction.guild.roles.cache.find(r=>r.name.toLowerCase()===clean); if(r) pingText=`<@&${r.id}>`; } } }
        // Same sync as /postupdate. This command is the one actually named
        // "status update", so it announcing a change the website never hears
        // about is the more surprising of the two.
        await interaction.deferReply({ flags: 64 });
        let siteSync = null;
        if (newStatus) {
          const key = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus);
          siteSync = await syncStatusToSite(product, key);
        }

        try {
          const posted = await statusCh.send(withLanguageRow({ content: withPreview(pingText, ssNotes), embeds: [embed] }));
          await interaction.editReply({ content: `✅ Status update posted to <#${statusCh.id}>${describeSync(siteSync)}` });
          autoDelete(interaction, siteSync && !siteSync.ok ? 30000 : 5000);
          offerImageUpload({ interaction, message: posted, embed, fileBase: `status-${posted.id}` });
        } catch (err) { await interaction.editReply({ content: `❌ Failed: ${err.message}${describeSync(siteSync)}` }); autoDelete(interaction, 12000); }
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
          // The author's Discord avatar HASH, captured here because most
          // people who leave a vouch have never logged into the website —
          // there is no web_users row for the backend to read one off. Null
          // for a member still on a default avatar. See
          // backend/migrations/review_avatars.sql.
          avatarHash: interaction.user.avatar || null,
          rating: ratingNum,
          feedback,
          imageUrl,
          timestamp: nowIso,
        };
        gData.entries = gData.entries || [];
        gData.entries.push(entry);
        vouchData.set(interaction.guild.id, gData);
        saveVouches();

        const vouchSettings = await getGuildSettings(interaction.guild.id);
        // Settings (panel/setupvouch) always wins over the older cached
        // gData.channelId — otherwise a stale value from before Settings
        // was configured gets stuck forever, ignoring later fixes.
        const vouchCh =
          (vouchSettings.vouchesChannelId && interaction.guild.channels.cache.get(vouchSettings.vouchesChannelId)) ||
          (gData.channelId && interaction.guild.channels.cache.get(gData.channelId));

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

        // …and onto the storefront, where it becomes the durable copy.
        syncVouchToWebsite(interaction.guild.id, entry, vouchMsg?.id);

        await interaction.reply({ content: '✅ Thank you for your vouch!', ephemeral: true });
        // This flow invented the upload-it-here step; it now shares the one
        // copy in modules/imageAttach.js with /announce, /postupdate and
        // /statusupdate. The helper declines by itself when the embed already
        // carries a picture, which is the `imageUrl` case.
        offerImageUpload({
          interaction, message: vouchMsg, embed, fileBase: `vouch-${entry.id}`,
          onAttached: (url) => {
            entry.imageUrl = url;
            saveVouches();
            // Second sync, same external_id: the vouch already reached the
            // website without a picture, and this is the picture.
            syncVouchToWebsite(interaction.guild.id, entry, vouchMsg.id);
          },
        });
        return;
      }
    }

    })();
  } catch (err) {
    console.error('Interaction error:', err.stack || err);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
      else await interaction.reply({ content: `❌ An error occurred: ${err.message}`, flags: 64 });
    } catch (_) {}
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
// Last-resort process guards. There were none: any unhandled rejection
// anywhere in the bot terminated the process on Node 20.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// Railway sends SIGTERM on every deploy and SIGKILLs ~10s later. Without a
// handler the bot was cut off mid-work — a delivery DM half-sent, a giveaway
// write half-flushed. Destroy the gateway connection cleanly and flush state
// first.
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[Bot] ${signal} received — shutting down cleanly…`);
  try { if (typeof saveVouches === 'function') saveVouches(); } catch (e) { console.error('[Bot] saveVouches on shutdown failed:', e.message); }
  try { client.destroy(); } catch (e) { console.error('[Bot] client.destroy failed:', e.message); }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Gateway health ───────────────────────────────────────────────────────────
// There were no listeners on any of these, so a dropped or zombied websocket
// looked exactly like a healthy bot: the process stays up, /health still says
// ready, and commands simply stop arriving with nothing written anywhere.
client.on('shardDisconnect',   (ev, id)  => console.warn(`[Gateway] shard ${id} DISCONNECTED — code ${ev && ev.code}`));
client.on('shardReconnecting', (id)      => console.warn(`[Gateway] shard ${id} reconnecting…`));
client.on('shardResume',       (id, n)   => console.log(`[Gateway] shard ${id} resumed (${n} events replayed)`));
client.on('shardReady',        (id)      => console.log(`[Gateway] shard ${id} ready`));
client.on('shardError',        (err, id) => console.error(`[Gateway] shard ${id} error:`, err && err.message));
client.on('error',             (err)     => console.error('[Client] error:', err && err.message));

client.login(TOKEN);
