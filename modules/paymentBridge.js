// ─── Shop Payment Backend Bridge ─────────────────────────────────────────────
// Ported from p-bot's standalone bot/index.js internal server. The payment
// backend (a separate Railway service) POSTs here to trigger Discord
// notifications/DMs for new orders and deliveries — same contract as the old
// /internal/new_order and /internal/deliver_goods routes, just registered on
// SUPERBOT's shared Express app instead of p-bot's own bot process (which is
// being retired). Point the backend's BOT_INTERNAL_URL at this service.
'use strict';

const { EmbedBuilder } = require('discord.js');
const { query } = require('../db');

// The log channel is whatever was last set via /config set logchan, which
// writes straight into the same Postgres `config` table the backend reads —
// looking it up here instead of trusting a possibly-stale env var keeps this
// in sync without needing to duplicate it across two Railway services.
async function getLogChannelId(guildId) {
  try {
    const { rows } = await query(
      `SELECT value FROM config WHERE guild_id = $1 AND key = 'ORDER_LOG_CHANNEL_ID'`,
      [guildId]
    );
    return rows[0]?.value || null;
  } catch (err) {
    console.error('[PaymentBridge] Could not read log channel from config:', err.message);
    return null;
  }
}

async function handleNewOrder(order, payment_info, discordClient) {
  try {
    const logChannelId = await getLogChannelId(order.guild_id);
    if (!logChannelId) return;
    const channel = await discordClient.channels.fetch(logChannelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('🛒 New Order')
      .addFields(
        { name: 'Order ID', value: `\`${order.id}\``, inline: true },
        { name: 'Payment', value: String(order.payment_method).toUpperCase(), inline: true },
        { name: 'Total', value: `$${(order.total_cents / 100).toFixed(2)}`, inline: true },
        { name: 'Email', value: order.email, inline: true },
        { name: 'Status', value: '⏳ Pending Payment', inline: true },
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[PaymentBridge] New order notification error:', err.message);
  }
}

async function handleDelivery(order_id, discord_id, email, goods, guildId, discordClient) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle('✅ Your Order is Ready!')
      .setDescription('Thank you for your purchase. Here are your goods:')
      .setTimestamp();

    for (const g of goods || []) {
      const value = (g.items || []).join('\n') || 'See below';
      embed.addFields({ name: `📦 ${g.product}`, value: `\`\`\`${value}\`\`\`` });
    }
    embed.setFooter({ text: `Order ID: ${order_id}` });

    if (discord_id) {
      const user = await discordClient.users.fetch(discord_id).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] });
        console.log(`[PaymentBridge] Delivered goods to Discord user ${discord_id}`);
      }
    }

    const logChannelId = await getLogChannelId(guildId);
    if (logChannelId) {
      const channel = await discordClient.channels.fetch(logChannelId).catch(() => null);
      if (channel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('📦 Order Delivered')
          .addFields(
            { name: 'Order ID', value: `\`${order_id}\``, inline: true },
            { name: 'Discord', value: discord_id ? `<@${discord_id}>` : 'N/A', inline: true },
            { name: 'Email', value: email || 'N/A', inline: true },
          )
          .setTimestamp();
        await channel.send({ embeds: [logEmbed] });
      }
    }
  } catch (err) {
    console.error('[PaymentBridge] Delivery error:', err.message);
  }
}

// Registers secret-gated internal routes onto SUPERBOT's shared Express app
// (called from modules/auth2fa.js's startAuthServer, same pattern as panel.js).
function registerPaymentRoutes(app, discordClient) {
  app.post('/internal/new_order', (req, res) => {
    if (req.body.secret !== process.env.API_SECRET) return res.status(401).end();
    const { order, payment_info } = req.body;
    handleNewOrder({ ...order, guild_id: order.guild_id || process.env.GUILD_ID }, payment_info, discordClient);
    res.json({ ok: true });
  });

  app.post('/internal/deliver_goods', (req, res) => {
    if (req.body.secret !== process.env.API_SECRET) return res.status(401).end();
    const { order_id, discord_id, email, goods, guild_id } = req.body;
    handleDelivery(order_id, discord_id, email, goods, guild_id || process.env.GUILD_ID, discordClient);
    res.json({ ok: true });
  });
}

module.exports = { registerPaymentRoutes };
