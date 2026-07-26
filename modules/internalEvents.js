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
// Events: new_order, deliver_goods, web_review, ops_alert.

const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { query } = require('../db');

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
// Preserved from paymentBridge: the order log channel is whatever was last set
// via /config set logchan, which writes into the same Postgres `config` table
// the backend reads. Looking it up beats trusting a possibly-stale env var
// duplicated across two Railway services.
async function getLogChannelId(guildId) {
  try {
    const { rows } = await query(
      `SELECT value FROM config WHERE guild_id = $1 AND key = 'ORDER_LOG_CHANNEL_ID'`,
      [guildId]
    );
    return rows[0]?.value || null;
  } catch (err) {
    console.error('[Internal] Could not read log channel from config:', err.message);
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
  const ordersChannel = async (guildId) => firstSendable(client, [
    await getLogChannelId(guildId),
    process.env.ORDERS_CHANNEL_ID,
    process.env.LOG_CHANNEL_ID,
  ]);

  const alertsChannel = async (guildId) => firstSendable(client, [
    process.env.ALERTS_CHANNEL_ID,
    await getLogChannelId(guildId),
    process.env.ORDERS_CHANNEL_ID,
    process.env.LOG_CHANNEL_ID,
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
  app.post('/internal/new_order', requireSecret, async (req, res) => {
    const { order = {}, payment_info = {} } = req.body || {};
    try {
      const ch = await ordersChannel(order.guild_id || process.env.GUILD_ID);
      if (!ch) {
        console.warn('[Internal] new_order: no order log channel (set one with /config set logchan)');
        return res.json({ ok: true, posted: false, reason: 'no channel configured' });
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle('🛒 New Order')
        .addFields(
          { name: 'Order ID', value: clip(order.id ?? 'unknown', LIMIT.value), inline: true },
          { name: 'Payment', value: clip(String(order.payment_method || 'unknown').toUpperCase(), LIMIT.value), inline: true },
          { name: 'Total', value: clip(formatAmount(order, payment_info), LIMIT.value), inline: true },
          { name: 'Email', value: clip(order.email || order.discord_id || 'unknown', LIMIT.value), inline: true },
          { name: 'Status', value: '⏳ Pending Payment', inline: true },
        )
        .setTimestamp();

      if (payment_info.address) {
        embed.addFields({ name: 'Pay to', value: clip(payment_info.address, LIMIT.value) });
      }

      await ch.send({ embeds: [embed] });
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
    const { order_id, email, discord_id, goods = [], guild_id, needs_attention = false } = req.body || {};
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
          .setFooter({ text: `Order ID: ${order_id ?? ''}`.trim() })
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
          embed.addFields({ name: clip(`📦 ${g.product || 'Item'}`, LIMIT.name), value: '```' + body + '```' });
          fieldCount++;
        }

        if (fieldCount > 0) {
          try {
            const user = await client.users.fetch(String(discord_id));
            await user.send({ embeds: [embed] });
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
          return `• ${clip(g.product || 'Item', 100)} — ${parts.join(', ') || 'nothing'}`;
        });

        const logEmbed = new EmbedBuilder()
          .setColor(needs_attention ? 0xED4245 : 0x00ff00)
          .setTitle(needs_attention ? '⚠️ Order Needs Attention' : '📦 Order Delivered')
          .setDescription(clip(summary.join('\n') || 'No items', LIMIT.desc))
          .addFields(
            { name: 'Order ID', value: clip(order_id ?? 'unknown', LIMIT.value), inline: true },
            { name: 'Discord', value: discord_id ? `<@${discord_id}>` : 'N/A', inline: true },
            { name: 'Email', value: clip(email || 'N/A', LIMIT.value), inline: true },
            { name: 'Buyer DM', value: out.dm ? 'sent' : (out.dm_error || (discord_id ? 'not sent' : 'no discord id')), inline: true },
          )
          .setTimestamp();

        await ch.send({ embeds: [logEmbed] });
        out.posted = true;
      } else {
        console.warn('[Internal] deliver_goods: no order log channel configured');
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

  // Anything else the backend learns to send. Answering 200 keeps an unknown
  // event from looking like an outage, but it is logged loudly rather than
  // dropped quietly — a silent accept is what let ops_alert 404 unnoticed.
  app.post('/internal/:event', requireSecret, (req, res) => {
    console.warn(`[Internal] No handler for event '${req.params.event}'`);
    return res.json({ ok: true, handled: false });
  });

  console.log('📨 Internal event routes registered (new_order, deliver_goods, web_review, ops_alert)');
}

module.exports = { registerInternalRoutes };
