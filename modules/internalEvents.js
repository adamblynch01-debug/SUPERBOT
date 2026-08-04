// ─── Internal event endpoints (backend → AIO bot) ────────────────────────────
'use strict';
//
// The storefront backend (P-BOT repo, service captivating-happiness) POSTs
// /internal/<event> here via its BOT_INTERNAL_URL. This file is the bot half of
// that contract.
//
// It supersedes modules/paymentBridge.js, which carried the routes ported from
// p-bot's retired standalone bot process. Three of the four events worked;
// ops_alert had no route at all, so every alert 404'd and the backend — which
// swallows notify failures by design — logged "Could not reach bot" and moved
// on. Alerts still landed in the ops_alerts table, so nothing was lost
// permanently, but nobody was ever pinged.
//
// The bridge's DB-backed channel lookups and vouch embed are preserved here
// verbatim; what is added is the missing route plus the hardening noted at each
// site below.
//
// Events: new_order, deliver_goods, web_review, ops_alert, restock.

const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { query } = require('../db');
const { registerWebTicketRoutes } = require('./webTickets');
const { getUserLang, translateEmbeds, DEFAULT_LANG } = require('./translate');

// A delivery DM in the buyer's own language, but ONLY if they have chosen one
// with /language. No choice means no lookup hit, no network call and byte-for-
// byte the message this has always sent — which is the right default for the
// one path in this system that must never get slower or more fragile. The
// license keys travel inside ``` fences, which modules/translate.js masks.
async function localizeForBuyer(discordId, guildId, embeds) {
  try {
    const lang = await getUserLang(guildId || process.env.GUILD_ID || 'dm', String(discordId));
    if (!lang || lang === DEFAULT_LANG) return embeds;
    return await translateEmbeds(embeds, lang);
  } catch (err) {
    console.warn('[Internal] delivery DM translation skipped:', err.message);
    return embeds;
  }
}

// Discord's hard caps. Exceeding any one rejects the WHOLE message, so
// everything user-supplied is clipped on the way in. Clipping is always marked
// — a silent truncation is how /post-status-vault lost half its catalogue.
const LIMIT = { name: 256, value: 1024, desc: 4096, fields: 25 };

function clip(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const marker = ` … (+${s.length - max} chars)`;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

// Markers the backend writes into delivered_goods when there is nothing real to
// hand over. Kept in sync with the backend's utils/delivery.js FAILURE_MARKERS.
// The bridge did not filter these, so a buyer whose order failed was DM'd a
// code block reading OUT_OF_STOCK as though it were their product.
const FAILURE_MARKERS = new Set([
  'OUT_OF_STOCK', 'PRODUCT_NOT_FOUND', 'MANUAL_DELIVERY_REQUIRED',
  'NO_ACCOUNT_LINKED', 'ALREADY_CREDITED', 'CREDIT_FAILED',
]);

// A delivered line, named the way the buyer bought it:
//     GAME — PRODUCT — DURATION  ×N
// The backend's delivery.js attaches game, tier_label and qty to every entry
// in delivered_goods; older payloads have none of them and fall back to the
// bare product name, which is all this ever showed.
//
// The game leads because it is the coarsest thing and the only one the buyer
// definitely recognises — they picked a tile before they picked a product.
// Skipped when it would only repeat itself: an HWID spoofer's game is
// "HWID Spoofer", and "HWID Spoofer — H8ED PERMANENT SPOOFER" reads like a
// bug. Balance top-ups and donations have no game at all, by design.
function lineLabel(g) {
  const game = (g && g.game) ? String(g.game).trim() : '';
  let s = (g && g.product) || 'Item';
  if (game && !new RegExp(`(^|\\s)${game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(s)) {
    s = `${game} — ${s}`;
  }
  if (g && g.tier_label) s += ` — ${g.tier_label}`;
  if (g && Number(g.qty) > 1) s += ` ×${Number(g.qty)}`;
  return s;
}

const SEVERITY_COLOR = { error: 0xED4245, warn: 0xFEE75C, info: 0x5865F2 };

// orders.total_cents is CENTS; payment_info.amount is DOLLARS. The bridge did
// `total_cents / 100` unguarded, which renders "$NaN" when the field is absent.
function formatAmount(order, payment_info) {
  const cents = Number(order && order.total_cents);
  if (Number.isFinite(cents)) return `$${(cents / 100).toFixed(2)}`;
  const dollars = Number(payment_info && payment_info.amount);
  if (Number.isFinite(dollars)) return `$${dollars.toFixed(2)}`;
  return 'unknown';
}

// ─── auth ────────────────────────────────────────────────────────────────────
// The bridge compared `req.body.secret !== process.env.API_SECRET`. If
// API_SECRET is ever unset that is `undefined !== undefined` — false — so an
// unauthenticated request passes and anyone who finds the URL can DM the bot's
// users arbitrary text and forge order notifications. Unset now means refuse,
// and the compare is constant-time.
function requireSecret(req, res, next) {
  const expected = process.env.API_SECRET;
  if (!expected) {
    console.error('[Internal] API_SECRET is not set — refusing internal events');
    return res.status(503).json({ error: 'API_SECRET not configured on this bot' });
  }
  const got = req.body && req.body.secret;
  if (typeof got !== 'string' || got.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so length is checked first —
  // and that check is the one thing that legitimately leaks, which is why the
  // secret is a fixed-length random string.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// ─── channel resolution ──────────────────────────────────────────────────────
// THE ORDER LOG BUG LIVED HERE. Every order notification returned HTTP 200 and
// posted nothing, because this lookup could never succeed:
//
//   * The `config` table is keyed (guild_id, key) — but it is EMPTY in
//     production (verified 2026-07-26), and the two repos even disagreed about
//     whether guild_id exists at all. So the SELECT returned zero rows.
//   * The bot defaults GUILD_ID to null, so `WHERE guild_id = NULL` matches
//     nothing even when rows do exist.
//   * The catch swallowed any error into a console line nobody reads.
//   * Nothing on the bot side read ORDER_LOG_CHANNEL_ID from the environment,
//     so the one thing an operator can actually set was ignored.
//
// Env var first now: it is operator-settable, it survives an empty config
// table, and it does not depend on two services agreeing on a guild id. The DB
// lookup remains as a fallback for /config set logchan, and tolerates a table
// with or without guild_id rather than throwing.
async function getLogChannelId(guildId) {
  // Railway is the source of truth, by the owner's decision (2026-07-26).
  // The env var wins outright and the DB is never consulted when it is set.
  const fromEnv = process.env.ORDER_LOG_CHANNEL_ID || process.env.ORDERS_CHANNEL_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();

  // Only reached if the variable is missing. The backend now refuses to store
  // this key in `config` at all, so a row here is stale — name it rather than
  // using it silently, because a wrong channel id looks exactly like the
  // original "orders never log" bug.
  try {
    const { rows } = await query(
      `SELECT value FROM config
        WHERE key = 'ORDER_LOG_CHANNEL_ID'
          AND (guild_id = $1 OR guild_id IS NULL)
        ORDER BY guild_id NULLS LAST
        LIMIT 1`,
      [guildId || null]
    );
    if (rows[0]?.value) {
      console.warn('[Internal] ORDER_LOG_CHANNEL_ID is NOT set in the environment — falling back to a `config` table row. Set the Railway variable and delete that row.');
      return rows[0].value;
    }
    return null;
  } catch (err) {
    // Loud on purpose: a schema mismatch here silently disables the entire
    // order feed, which is exactly how this went unnoticed.
    console.error('[Internal] ORDER_LOG_CHANNEL_ID config lookup FAILED — order log is disabled until ORDER_LOG_CHANNEL_ID is set as an env var:', err.message);
    return null;
  }
}

// Preserved from paymentBridge, including the original guild's known channel as
// the last fallback.
async function getVouchesChannelId(guildId) {
  try {
    const { rows } = await query(
      `SELECT vouches_channel_id FROM guild_settings WHERE guild_id = $1`,
      [guildId]
    );
    return rows[0]?.vouches_channel_id || process.env.VOUCHES_CHANNEL_ID || '1242134878263447552';
  } catch (err) {
    console.error('[Internal] Could not read vouches channel:', err.message);
    return process.env.VOUCHES_CHANNEL_ID || '1242134878263447552';
  }
}

// Tries each id in order and returns the first channel that exists and can be
// posted to, so a stale id degrades to the next fallback rather than dropping
// the message. The bridge fetched one id and gave up if it missed.
async function firstSendable(client, ids) {
  for (const id of ids.filter(Boolean)) {
    try {
      const ch = await client.channels.fetch(String(id));
      if (ch && typeof ch.send === 'function') return ch;
    } catch {
      /* wrong id, no access, or deleted — try the next */
    }
  }
  return null;
}

function registerInternalRoutes(app, client) {
  // LOG_CHANNEL_ID is NOT in these chains, deliberately.
  //
  // It belongs to the anti-scam module (modules/antiscam.js:16) — it is the
  // moderation log. Having it as the last fallback here meant that while
  // ORDER_LOG_CHANNEL_ID was unset, every "Order Delivered" embed and every
  // ops alert was posted into #ANTI-SCAM-BOT, mixed in with scam warnings.
  // Customer emails and order ids ended up in a moderation channel, and the
  // order log looked like it "worked" so the real misconfiguration stayed
  // hidden.
  //
  // A missing order channel is now a visible failure (503 to the backend, which
  // logs it) rather than a quiet delivery to the wrong room.
  // Orders and ops alerts are DIFFERENT audiences and belong in different
  // channels. Order embeds are a business feed staff read for fulfilment; ops
  // alerts are infrastructure noise (a watcher losing its connection, a
  // payment that could not be matched) that would drown the order feed if
  // mixed in.
  //
  // So: ALERTS_CHANNEL_ID is checked FIRST for alerts and is never used for
  // orders. If it is set, alerts go there and nowhere near the order log. The
  // remaining entries are a safety net for the case where it is unset — an
  // alert nobody sees is worse than an alert in the wrong room, which is the
  // one place that trade-off is worth making. Orders have no such net: a
  // misdelivered order embed leaks customer emails, so it fails loudly instead.
  const ordersChannel = async (guildId) => firstSendable(client, [
    await getLogChannelId(guildId),
    process.env.ORDERS_CHANNEL_ID,
  ]);

  const alertsChannel = async (guildId) => firstSendable(client, [
    process.env.ALERTS_CHANNEL_ID,
    await getLogChannelId(guildId),
    process.env.ORDERS_CHANNEL_ID,
  ]);

  // Last resort for anything a human must see. An ops alert with no channel
  // configured is exactly the case where staying silent is worst.
  async function dmOwner(embed) {
    const ownerId = process.env.OWNER_DISCORD_ID;
    if (!ownerId) return false;
    try {
      const user = await client.users.fetch(String(ownerId));
      await user.send({ embeds: [embed] });
      return true;
    } catch (err) {
      console.error('[Internal] Owner DM failed:', err.message);
      return false;
    }
  }

  // ─── new_order ─────────────────────────────────────────────────────────────
  //
  // Duplicate suppression. On 2026-07-30 a single order (id 4 — one row, one
  // debit) produced THREE identical embeds. The backend provably sent one
  // notify: botNotify.js has no retry, the two call sites in routes/orders.js
  // are mutually exclusive, and a retried checkout would have left cancelled
  // order rows behind — there were none. This route is registered exactly once
  // and ends the response itself, so Express cannot run it twice either.
  //
  // That leaves the discord.js REST layer retrying a slow or 5xx-ing Discord
  // API where the message actually landed each time — a known duplicate cause,
  // and consistent with the same checkout hanging the storefront on the notify
  // timeout. Rather than chase an unprovable retry (Railway's log window no
  // longer reaches that far), post at most once per order id and let the cause
  // be moot.
  const recentOrderPosts = new Map();   // order id → ms timestamp
  const ORDER_POST_TTL_MS = 10 * 60 * 1000;

  // Deliberately split from markPosted: an order is only recorded once the
  // send actually succeeded, so a failed post can still be retried rather than
  // being suppressed as a "duplicate" of a message that never landed.
  function alreadyPosted(orderId) {
    const now = Date.now();
    for (const [id, at] of recentOrderPosts) {
      if (now - at > ORDER_POST_TTL_MS) recentOrderPosts.delete(id);
    }
    return recentOrderPosts.has(String(orderId));
  }

  function markPosted(orderId) {
    recentOrderPosts.set(String(orderId), Date.now());
  }

  // The status used to be the hardcoded string '⏳ Pending Payment', so a
  // balance order that was already paid AND delivered before the embed was
  // even built still announced itself as awaiting payment.
  // Where the order came from. The vouch embed has said `Source: 🌐 Website`
  // since the web-review bridge was built, and an order embed said nothing —
  // so a storefront checkout and a key handed over by hand in a ticket arrived
  // in #order-log looking identical. They are not: one was paid for through
  // the site and one is a staff action that nobody else witnessed.
  const SOURCE_LABELS = {
    website: '🌐 Website',
    discord: '💬 Discord',
    manual:  '🖐️ Manual (staff)',
  };
  const sourceLabel = (s) => SOURCE_LABELS[String(s || 'website').toLowerCase()] || `❔ ${s}`;

  // The dedicated channel the operator created for hand-delivered orders. Kept
  // separate from #order-log on purpose: this is the short list a human is
  // accountable for, and it would be unreadable buried in the checkout feed.
  const manualChannel = async () => firstSendable(client, [
    process.env.MANUAL_DELIVERY_CHANNEL_ID,
    '1533927608360636629',
  ]);

  const STATUS_LABELS = {
    waiting:          '⏳ Pending Payment',
    paid:             '💰 Paid',
    delivered:        '✅ Delivered',
    cancelled:        '❌ Cancelled',
    expired:          '⌛ Expired',
    expired_paid:     '⚠️ Paid After Expiry',
    needs_attention:  '⚠️ Needs Attention',
  };

  app.post('/internal/new_order', requireSecret, async (req, res) => {
    const { order = {}, payment_info = {} } = req.body || {};
    try {
      if (order.id != null && alreadyPosted(order.id)) {
        console.warn(`[Internal] new_order for order ${order.id} suppressed — already posted within the last ${ORDER_POST_TTL_MS / 60000}m`);
        // No `posted:false` here — that is botNotify's signal for "the route
        // ran but there was no channel", and it would log a bogus
        // "check ORDER_LOG_CHANNEL_ID" error for what is a healthy suppression.
        return res.json({ ok: true, duplicate: true });
      }

      const ch = await ordersChannel(order.guild_id || process.env.GUILD_ID);
      if (!ch) {
        // 503, NOT 200. This used to answer `{ok:true, posted:false}`, and the
        // backend's notifyBot only inspected `handled` — so "there is nowhere
        // to send this" read as success on both sides and every order
        // notification vanished with no log line anywhere.
        console.error('[Internal] new_order DROPPED: no order log channel. Set ORDER_LOG_CHANNEL_ID on this service, or run /config set logchan.');
        return res.status(503).json({
          ok: false, posted: false, handled: false,
          error: 'no order log channel configured',
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle('🛒 New Order')
        .addFields(
          // The invoice number is what the buyer holds and what /claim-customer
          // takes; staff need to be able to match a customer's message to a row
          // here without asking them for an id they were never given.
          { name: 'Invoice', value: clip(order.invoice_no || `#${order.id ?? 'unknown'}`, LIMIT.value), inline: true },
          { name: 'Order ID', value: clip(order.id ?? 'unknown', LIMIT.value), inline: true },
          { name: 'Payment', value: clip(String(order.payment_method || 'unknown').toUpperCase(), LIMIT.value), inline: true },
          { name: 'Total', value: clip(formatAmount(order, payment_info), LIMIT.value), inline: true },
          { name: 'Email', value: clip(order.email || order.discord_id || 'unknown', LIMIT.value), inline: true },
          { name: 'Status', value: STATUS_LABELS[String(order.status || 'waiting')] || `❔ ${order.status}`, inline: true },
          { name: 'Source', value: sourceLabel(order.source), inline: true },
        )
        .setTimestamp();

      if (payment_info.address) {
        embed.addFields({ name: 'Pay to', value: clip(payment_info.address, LIMIT.value) });
      }

      await ch.send({ embeds: [embed] });
      if (order.id != null) markPosted(order.id);
      return res.json({ ok: true, posted: true });
    } catch (err) {
      console.error('[Internal] new_order failed:', err.message);
      return res.status(500).json({ error: 'failed to post order' });
    }
  });

  // ─── deliver_goods ─────────────────────────────────────────────────────────
  // The valuable one: this is how a Discord buyer actually receives what they
  // paid for. Delivered values go to the buyer by DM only — never to a channel.
  app.post('/internal/deliver_goods', requireSecret, async (req, res) => {
    const { order_id, invoice_no = null, email, discord_id, goods = [], guild_id,
            needs_attention = false, source = 'website' } = req.body || {};
    const out = { ok: true, dm: false, posted: false };

    try {
      // needs_attention means the backend already suppressed the customer email
      // because there was nothing real to hand over. DMing the buyer a wall of
      // OUT_OF_STOCK markers would be the same mistake in another channel.
      if (!needs_attention && discord_id) {
        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('✅ Your Order is Ready!')
          .setDescription('Thank you for your purchase. Here are your goods:')
          .setFooter({ text: (invoice_no ? `Invoice: ${invoice_no}` : `Order ID: ${order_id ?? ''}`).trim() })
          .setTimestamp();

        let fieldCount = 0;
        for (const g of goods) {
          if (fieldCount >= LIMIT.fields - 1) break;
          const items = (g.items || []).filter(v => !FAILURE_MARKERS.has(v));
          if (!items.length) continue;
          // -8 leaves room for the ``` fences. The bridge joined every key into
          // one unclipped field; past 1024 chars Discord rejects the whole
          // message, so a large order delivered the buyer nothing at all.
          const body = clip(items.join('\n'), LIMIT.value - 8);
          // "Punisher Phone External Bo7" told the buyer nothing about which
          // term they had just been given, or how many of it.
          embed.addFields({ name: clip(`📦 ${lineLabel(g)}`, LIMIT.name), value: '```' + body + '```' });
          fieldCount++;
        }

        if (fieldCount > 0) {
          try {
            const user = await client.users.fetch(String(discord_id));
            await user.send({ embeds: await localizeForBuyer(discord_id, guild_id, [embed]) });
            out.dm = true;
            console.log(`[Internal] Delivered goods to Discord user ${discord_id}`);
          } catch (err) {
            // 50007 = buyer has DMs closed. They still got the email, but staff
            // need to know a hand-off is pending.
            console.error(`[Internal] deliver_goods DM to ${discord_id} failed:`, err.message);
            out.dm_error = err.code === 50007 ? 'dms_closed' : err.message;
          }
        }
      }

      // Staff copy — product names and counts only. The delivered values are
      // live credentials; a channel is the wrong place for them.
      const ch = await ordersChannel(guild_id || process.env.GUILD_ID);
      if (ch) {
        const summary = goods.map((g) => {
          const items = g.items || [];
          const bad = items.filter(v => FAILURE_MARKERS.has(v));
          const good = items.length - bad.length;
          const parts = [];
          if (good) parts.push(`${good} delivered`);
          if (bad.length) parts.push(`⚠️ ${bad.join(', ')}`);
          return `• ${clip(lineLabel(g), 100)} — ${parts.join(', ') || 'nothing'}`;
        });

        const logEmbed = new EmbedBuilder()
          .setColor(needs_attention ? 0xED4245 : 0x00ff00)
          .setTitle(needs_attention ? '⚠️ Order Needs Attention' : '📦 Order Delivered')
          .setDescription(clip(summary.join('\n') || 'No items', LIMIT.desc))
          .addFields(
            { name: 'Invoice', value: clip(invoice_no || `#${order_id ?? 'unknown'}`, LIMIT.value), inline: true },
            { name: 'Order ID', value: clip(order_id ?? 'unknown', LIMIT.value), inline: true },
            { name: 'Discord', value: discord_id ? `<@${discord_id}>` : 'N/A', inline: true },
            { name: 'Email', value: clip(email || 'N/A', LIMIT.value), inline: true },
            { name: 'Buyer DM', value: out.dm ? 'sent' : (out.dm_error || (discord_id ? 'not sent' : 'no discord id')), inline: true },
            { name: 'Source', value: sourceLabel(source), inline: true },
          )
          .setTimestamp();

        await ch.send({ embeds: [logEmbed] });
        out.posted = true;

        // A hand-delivered order goes to BOTH channels. #order-log is the
        // complete feed and must stay complete; the manual channel is the
        // subset a human is answerable for, and duplicating the embed there is
        // cheaper than asking staff to filter the firehose.
        if (String(source).toLowerCase() === 'manual') {
          const mch = await manualChannel();
          if (mch && mch.id !== ch.id) {
            await mch.send({ embeds: [logEmbed] }).catch(e =>
              console.error('[Internal] manual delivery channel post failed:', e.message));
            out.manual_posted = true;
          }
        }
      } else {
        // The customer still got their keys (the DM above is what matters to
        // them), but staff have no record of it. Say so loudly rather than
        // reporting a clean success.
        console.error('[Internal] deliver_goods: order log channel MISSING — delivery happened but was not logged to Discord. Set ORDER_LOG_CHANNEL_ID.');
        out.log_channel_missing = true;
      }

      return res.json(out);
    } catch (err) {
      console.error('[Internal] deliver_goods failed:', err.message);
      return res.status(500).json({ error: 'failed to deliver goods notification' });
    }
  });

  // ─── web_review ────────────────────────────────────────────────────────────
  // Embed format preserved from paymentBridge so web and Discord vouches keep
  // looking identical, reactions included.
  app.post('/internal/web_review', requireSecret, async (req, res) => {
    const { guild_id, review } = req.body || {};
    try {
      if (!review) return res.json({ ok: true, posted: false, reason: 'no review' });

      const channelId = await getVouchesChannelId(guild_id || process.env.GUILD_ID);
      const ch = await firstSendable(client, [channelId]);
      if (!ch) {
        console.warn('[Internal] web_review: no vouches channel reachable');
        return res.json({ ok: true, posted: false, reason: 'no channel configured' });
      }

      const ratingNum = Math.min(5, Math.max(1, parseInt(review.rating, 10) || 5));
      const stars = '⭐'.repeat(ratingNum);
      const name = review.display_name || 'Anonymous';
      const feedback = (review.body && String(review.body).trim()) || '_No written feedback_';

      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('New Vouch Received 🎉')
        .addFields(
          { name: 'Vouch ID', value: review.id ? `Nº ${review.id}` : '—', inline: false },
          { name: 'Rating', value: stars, inline: false },
          { name: 'Feedback', value: clip(feedback, LIMIT.value), inline: false },
          { name: 'Vouched By', value: clip(review.discord_id ? `<@${review.discord_id}>` : name, LIMIT.value), inline: false },
          { name: 'Source', value: '🌐 Website', inline: false },
        )
        .setFooter({ text: 'Thanks for supporting the store' })
        .setTimestamp();

      // A website vouch can carry a screenshot too. The URL is served by the
      // backend, not Discord's CDN, so it does not expire out from under the
      // embed the way an attachment link would.
      if (review.image_url && /^https?:\/\//i.test(review.image_url)) embed.setImage(review.image_url);

      const msg = await ch.send({ embeds: [embed] });
      if (msg) { try { await msg.react('💯'); await msg.react('🔥'); } catch (_) {} }
      return res.json({ ok: true, posted: true });
    } catch (err) {
      console.error('[Internal] web_review failed:', err.message);
      return res.status(500).json({ error: 'failed to post review' });
    }
  });

  // ─── ops_alert ─────────────────────────────────────────────────────────────
  // The route that never existed. Every backend alert 404'd here.
  app.post('/internal/ops_alert', requireSecret, async (req, res) => {
    const { kind, severity = 'warn', message, context, order_id, guild_id } = req.body || {};
    try {
      const embed = new EmbedBuilder()
        .setColor(SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.warn)
        .setTitle(`🚨 ${clip(kind || 'alert', 200)}`)
        .setDescription(clip(message || '(no message)', LIMIT.desc))
        .setTimestamp();

      if (order_id != null) {
        embed.addFields({ name: 'Order', value: clip(order_id, LIMIT.value), inline: true });
      }
      embed.addFields({ name: 'Severity', value: clip(severity, LIMIT.value), inline: true });
      if (context) {
        let rendered;
        try { rendered = JSON.stringify(context, null, 2); } catch { rendered = String(context); }
        // -12 leaves room for the ```json fences.
        embed.addFields({ name: 'Context', value: '```json\n' + clip(rendered, LIMIT.value - 12) + '\n```' });
      }

      const ch = await alertsChannel(guild_id || process.env.GUILD_ID);
      if (ch) {
        await ch.send({ embeds: [embed] });
        return res.json({ ok: true, posted: true });
      }

      const dmed = await dmOwner(embed);
      if (!dmed) {
        console.error(`[Internal] ops_alert "${kind}" had nowhere to go — set ALERTS_CHANNEL_ID or OWNER_DISCORD_ID`);
      }
      return res.json({ ok: true, posted: false, dmed });
    } catch (err) {
      console.error('[Internal] ops_alert failed:', err.message);
      return res.status(500).json({ error: 'failed to post alert' });
    }
  });

  // ─── restock ───────────────────────────────────────────────────────────────
  // "Product Restocked!" announcements for #restocks.
  //
  // The backend batches these (utils/restockNotify.js) so one sync-all press
  // arrives as one request carrying many products, rather than one request per
  // tier. This route therefore has to render BOTH shapes: a handful of
  // products gets the full per-product embed a customer can act on, and a
  // catalogue-wide fill collapses into a single summary — 60 embeds in a row
  // is not an announcement, it is a wall.
  //
  // Unlike the order channel this one is safe to hardcode a fallback for: a
  // restock embed carries product names and prices, which are already public
  // on the storefront. There is no customer data to misdeliver.
  const RESTOCK_FALLBACK_CHANNEL = '1533187731381817534';
  // The vault sells from its own catalogue in its own part of the server, so a
  // vault restock announced in the storefront channel points customers at a
  // page that does not carry the product. This channel lives under the
  // 🔑 GEN-VAULT category and is named IDENTICALLY to the storefront one —
  // resolving either by name would pick whichever Discord returned first, so
  // both are pinned by id.
  const VAULT_RESTOCK_FALLBACK_CHANNEL = '1533912211834146916';
  const MAX_INDIVIDUAL_EMBEDS = 4;

  const restockChannel = async () => firstSendable(client, [
    process.env.RESTOCK_CHANNEL_ID,
    RESTOCK_FALLBACK_CHANNEL,
  ]);

  // Falls back to the storefront channel rather than dropping the message: a
  // vault restock in the wrong channel is a nuisance, a vault restock nobody
  // sees is a product that silently never came back.
  const vaultRestockChannel = async () => firstSendable(client, [
    process.env.VAULT_RESTOCK_CHANNEL_ID,
    VAULT_RESTOCK_FALLBACK_CHANNEL,
    process.env.RESTOCK_CHANNEL_ID,
    RESTOCK_FALLBACK_CHANNEL,
  ]);

  // "3 DAY'S ···· $14.99" — the dotted leader from the reference notification,
  // padded so the prices line up in Discord's proportional font as well as they
  // can. Bounded so a product with 30 tiers cannot blow the 1024-char field.
  function variantLines(variants) {
    const rows = (variants || []).slice(0, 12);
    const width = rows.reduce((m, v) => Math.max(m, String(v.label || '').length), 0);
    const out = rows.map(v => {
      const label = String(v.label || '—');
      const dots = '·'.repeat(Math.max(4, width - label.length + 6));
      return `\`${label}\` ${dots} **${v.price || 'TBD'}**`;
    });
    if ((variants || []).length > rows.length) {
      out.push(`_… and ${variants.length - rows.length} more variant(s)_`);
    }
    return out.join('\n') || '—';
  }

  function productEmbed(p, storeUrl) {
    const title = p.game_name && p.game_name !== p.product_name
      ? `${p.game_name} — ${p.product_name}`
      : p.product_name;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(clip(title, LIMIT.name))
      .setDescription(clip(
        '🔵 **Product Restocked!**\n' +
        'The following product has just been restocked and is now available.\n\n' +
        `🛒 **[Buy Now »](${storeUrl})**`,
        LIMIT.desc
      ))
      .addFields({ name: 'Variants & Pricing', value: clip(variantLines(p.variants), LIMIT.value) })
      .setFooter({ text: 'UHSERVICES.XYZ Restock Notifications' })
      .setTimestamp();

    if (storeUrl) embed.setURL(storeUrl);

    // Which tiers actually moved, and what is on the shelf now. The reference
    // embed does not carry this, but "restocked" with no number is the exact
    // ambiguity that had the operator asking why a product still read LOW.
    const moved = (p.restocked || [])
      .slice(0, 12)
      .map(r => `\`${r.label}\` +${r.added} → **${r.available} in stock**`)
      .join('\n');
    if (moved) embed.addFields({ name: 'Restocked', value: clip(moved, LIMIT.value) });

    if (p.image_url) embed.setImage(p.image_url);
    return embed;
  }

  // One catalogue's worth of restocks into one channel. Returns what it did so
  // the response can account for both groups separately — "posted: true" that
  // hides a silently-dropped half is the kind of answer this route exists to
  // stop giving.
  async function postRestockGroup(ch, list, storeUrl) {
    if (list.length <= MAX_INDIVIDUAL_EMBEDS) {
      for (const p of list) await ch.send({ embeds: [productEmbed(p, storeUrl)] });
      return { embeds: list.length, summarized: 0 };
    }

    // Summary. Every product is NAMED — a count alone ("47 products
    // restocked") tells a customer nothing about whether the one they want
    // is back. The list is capped at the field limit and says so when it is.
    const shown = list.slice(0, 40);
    const lines = shown.map(p => {
      const name = p.game_name && p.game_name !== p.product_name
        ? `${p.game_name} — ${p.product_name}` : p.product_name;
      return `• **${name}** (+${p.total_added})`;
    });
    if (list.length > shown.length) {
      lines.push(`_… and ${list.length - shown.length} more product(s)_`);
    }
    const added = list.reduce((s, p) => s + (Number(p.total_added) || 0), 0);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔵 Products Restocked!')
      .setURL(storeUrl)
      .setDescription(clip(
        `**${list.length}** product(s) have just been restocked` +
        (added > 0 ? ` with **${added}** new key(s)` : '') +
        '.\n\n' + `🛒 **[Buy Now »](${storeUrl})**`,
        LIMIT.desc
      ))
      .addFields({ name: 'Restocked', value: clip(lines.join('\n'), LIMIT.value) })
      .setFooter({ text: 'UHSERVICES.XYZ Restock Notifications' })
      .setTimestamp();

    await ch.send({ embeds: [embed] });
    return { embeds: 1, summarized: list.length };
  }

  app.post('/internal/restock', requireSecret, async (req, res) => {
    const { products = [] } = req.body || {};
    try {
      if (!Array.isArray(products) || !products.length) {
        return res.json({ ok: true, posted: false, reason: 'no products' });
      }

      // Split on the CATALOGUE, not the channel: a batch can carry both, since
      // "sync all stock" walks every tier the guild owns regardless of which
      // storefront sells it.
      const store = products.filter(p => !p.vault);
      const vault = products.filter(p => p.vault);

      const storeUrl = String(req.body.store_url || 'https://uhservices.xyz').replace(/\/+$/, '');
      const vaultUrl = String(req.body.vault_url || storeUrl).replace(/\/+$/, '');

      const out = { ok: true, posted: false, store: null, vault: null };

      if (store.length) {
        const ch = await restockChannel();
        if (!ch) {
          console.error('[Internal] restock DROPPED for storefront: no channel reachable. Set RESTOCK_CHANNEL_ID.');
          out.store = { posted: false, reason: 'no channel configured', products: store.length };
        } else {
          out.store = { posted: true, channel: ch.id, products: store.length, ...(await postRestockGroup(ch, store, storeUrl)) };
          out.posted = true;
        }
      }

      if (vault.length) {
        const ch = await vaultRestockChannel();
        if (!ch) {
          console.error('[Internal] restock DROPPED for vault: no channel reachable. Set VAULT_RESTOCK_CHANNEL_ID.');
          out.vault = { posted: false, reason: 'no channel configured', products: vault.length };
        } else {
          out.vault = { posted: true, channel: ch.id, products: vault.length, ...(await postRestockGroup(ch, vault, vaultUrl)) };
          out.posted = true;
        }
      }

      return res.json(out);
    } catch (err) {
      console.error('[Internal] restock failed:', err.message);
      return res.status(500).json({ error: 'failed to post restock' });
    }
  });

  // Website tickets live in their own module but must be registered HERE, and
  // specifically BEFORE the catch-all below. Express matches in registration
  // order, so '/internal/:event' would otherwise swallow '/internal/new_ticket'
  // and answer handled:false — which is exactly the bug the module fixes.
  registerWebTicketRoutes(app, client, requireSecret);

  // Anything else the backend learns to send. Answering 200 keeps an unknown
  // event from looking like an outage, but it is logged loudly rather than
  // dropped quietly — a silent accept is what let ops_alert 404 unnoticed.
  app.post('/internal/:event', requireSecret, (req, res) => {
    console.warn(`[Internal] No handler for event '${req.params.event}'`);
    return res.json({ ok: true, handled: false });
  });

  console.log('📨 Internal event routes registered (new_order, deliver_goods, web_review, ops_alert, restock)');
}

// requireSecret is exported so modules/webTickets.js can guard its own
// /internal/* routes with the SAME check rather than a second copy of it. Two
// copies is how one of them ends up without the "unset API_SECRET means refuse"
// rule that the original paymentBridge was missing.
module.exports = { registerInternalRoutes, requireSecret };
