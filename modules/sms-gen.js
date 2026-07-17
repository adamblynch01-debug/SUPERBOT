// ============================================================
// SMS NUMBER GENERATOR — SUPERBOT MODULE
// Supports: 5sim.net + smspool.net
// Commands: /gennumber, /set-5sim-api, /set-smspool-api
// ============================================================

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const fs = require('fs');
const path = require('path');

// ─── Persistent config (stored in DATA_DIR like your other data) ───────────
const DATA_DIR = process.env.DATA_DIR || './data';
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

// ─── Active order tracker (in-memory, per bot session) ────────────────────
// orderId → { provider, service, country, number, userId, channelId, messageId, pollTimer }
const activeOrders = new Map();

// ─── Provider API wrappers ─────────────────────────────────────────────────

// ── SMSPOOL ────────────────────────────────────────────────────────────────
const SMSPOOL_BASE = 'https://api.smspool.net';

async function smspoolGetServices(apiKey) {
  const r = await fetch(`${SMSPOOL_BASE}/service/retrieve_all_services?key=${apiKey}`);
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch services');
  // Returns: [{ name, ID }, ...]
  return d.slice(0, 25).map(s => ({ label: s.name, value: String(s.ID) }));
}

async function smspoolGetCountries(apiKey, serviceId) {
  const r = await fetch(
    `${SMSPOOL_BASE}/country/retrieve_all_countries?key=${apiKey}&service=${serviceId}`
  );
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch countries');
  return d.slice(0, 25).map(c => ({ label: c.name, value: String(c.ID) }));
}

async function smspoolBuyNumber(apiKey, serviceId, countryId) {
  const r = await fetch(
    `${SMSPOOL_BASE}/sms/purchase?key=${apiKey}&service=${serviceId}&country=${countryId}`
  );
  const d = await r.json();
  if (d.success !== 1) throw new Error(d.message || 'Purchase failed');
  return { orderId: String(d.order_id), number: d.phonenumber };
}

async function smspoolCheckSMS(apiKey, orderId) {
  const r = await fetch(`${SMSPOOL_BASE}/sms/check?key=${apiKey}&orderid=${orderId}`);
  const d = await r.json();
  // status: "completed", "pending", "expired"
  return { status: d.status, code: d.sms || null };
}

async function smspoolCancel(apiKey, orderId) {
  await fetch(`${SMSPOOL_BASE}/sms/cancel?key=${apiKey}&orderid=${orderId}`);
}

async function smspoolResend(apiKey, orderId) {
  const r = await fetch(`${SMSPOOL_BASE}/sms/resend?key=${apiKey}&orderid=${orderId}`);
  const d = await r.json();
  return d.success === 1;
}

// ── 5SIM ───────────────────────────────────────────────────────────────────
const FIVESIM_BASE = 'https://5sim.net/v1';

async function fivesimGetProducts(apiKey, country = 'any') {
  const r = await fetch(`${FIVESIM_BASE}/guest/products/${country}/any`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  // Returns object keyed by service name
  const services = Object.keys(d).slice(0, 25);
  return services.map(s => ({ label: capitalize(s), value: s }));
}

async function fivesimGetCountries(apiKey) {
  const r = await fetch(`${FIVESIM_BASE}/guest/countries`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  return Object.keys(d)
    .slice(0, 25)
    .map(c => ({ label: capitalize(c), value: c }));
}

async function fivesimBuyNumber(apiKey, country, service) {
  const r = await fetch(`${FIVESIM_BASE}/user/buy/activation/${country}/any/${service}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  return { orderId: String(d.id), number: d.phone };
}

async function fivesimCheckSMS(apiKey, orderId) {
  const r = await fetch(`${FIVESIM_BASE}/user/check/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  // status: "PENDING", "RECEIVED", "CANCELED", "TIMEOUT", "BANNED", "FINISHED"
  const code =
    d.sms && d.sms.length > 0 ? d.sms[d.sms.length - 1].code : null;
  return { status: d.status, code };
}

async function fivesimCancel(apiKey, orderId) {
  await fetch(`${FIVESIM_BASE}/user/cancel/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
}

async function fivesimFinish(apiKey, orderId) {
  await fetch(`${FIVESIM_BASE}/user/finish/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const PROVIDER_EMOJI = { smspool: '📱', '5sim': '🌐' };
const PROVIDER_COLOR = { smspool: 0x5865f2, '5sim': 0x57f287 };

function buildOrderEmbed(provider, service, country, number, status, code) {
  const statusMap = {
    waiting:   { label: '⏳ Waiting for SMS...', color: 0xfee75c },
    received:  { label: '✅ Code received!',      color: 0x57f287 },
    failed:    { label: '❌ No SMS / Failed',      color: 0xed4245 },
    cancelled: { label: '🚫 Cancelled',            color: 0x99aab5 },
    resent:    { label: '🔄 Re-request sent...',   color: 0x5865f2 },
  };
  const s = statusMap[status] || statusMap.waiting;

  return new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`${PROVIDER_EMOJI[provider] || '📲'} SMS Number Generated`)
    .addFields(
      { name: 'Provider',  value: provider === '5sim' ? '5sim.net' : 'SMSPool.net', inline: true },
      { name: 'Service',   value: capitalize(service),  inline: true },
      { name: 'Country',   value: capitalize(country),  inline: true },
      { name: '📞 Number', value: `\`${number}\``,      inline: false },
      { name: 'Status',    value: s.label,              inline: false },
      ...(code ? [{ name: '🔑 Code', value: `**\`${code}\`**`, inline: false }] : [])
    )
    .setFooter({ text: 'UH SERVICES • SMS Gen' })
    .setTimestamp();
}

function buildOrderButtons(orderId, expired = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sms_resend_${orderId}`)
      .setLabel('Request New SMS')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(expired),
    new ButtonBuilder()
      .setCustomId(`sms_cancel_${orderId}`)
      .setLabel('Cancel & Refund')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(expired),
  );
}

// ─── Polling loop ────────────────────────────────────────────────────────────
const POLL_INTERVAL = 7000;  // 7s
const POLL_TIMEOUT  = 5 * 60 * 1000; // 5 min

async function startPolling(client, orderId, orderData) {
  const cfg = loadConfig();
  const { provider, service, country, number, userId, channelId, messageId } = orderData;
  const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

  const start = Date.now();

  const poll = async () => {
    // Timed out
    if (Date.now() - start > POLL_TIMEOUT) {
      try {
        if (provider === '5sim') await fivesimCancel(apiKey, orderId);
        else await smspoolCancel(apiKey, orderId);

        const ch = await client.channels.fetch(channelId);
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          embeds: [buildOrderEmbed(provider, service, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send(`<@${userId}> ⚠️ No SMS received after 5 minutes. Number cancelled & refunded.`);
      } catch {}
      activeOrders.delete(orderId);
      return;
    }

    try {
      let result;
      if (provider === '5sim') result = await fivesimCheckSMS(apiKey, orderId);
      else result = await smspoolCheckSMS(apiKey, orderId);

      const ch = await client.channels.fetch(channelId);
      const msg = await ch.messages.fetch(messageId);

      if (result.code) {
        // Success
        if (provider === '5sim') await fivesimFinish(apiKey, orderId).catch(() => {});

        await msg.edit({
          embeds: [buildOrderEmbed(provider, service, country, number, 'received', result.code)],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send(`<@${userId}> ✅ Your SMS code: **\`${result.code}\`**`);
        activeOrders.delete(orderId);
        return;
      }

      // Check for terminal fail states
      const dead = ['CANCELED', 'TIMEOUT', 'BANNED', 'expired'].includes(result.status);
      if (dead) {
        await msg.edit({
          embeds: [buildOrderEmbed(provider, service, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send(`<@${userId}> ❌ Number expired or banned. No charge applied.`);
        activeOrders.delete(orderId);
        return;
      }
    } catch (e) {
      console.error('[SMS POLL ERROR]', e.message);
    }

    // Still pending — poll again
    activeOrders.get(orderId).pollTimer = setTimeout(poll, POLL_INTERVAL);
  };

  orderData.pollTimer = setTimeout(poll, POLL_INTERVAL);
  activeOrders.set(orderId, orderData);
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

const commands = [
  // /gennumber
  new SlashCommandBuilder()
    .setName('gennumber')
    .setDescription('📲 Generate a phone number for SMS verification'),

  // /set-5sim-api
  new SlashCommandBuilder()
    .setName('set-5sim-api')
    .setDescription('🔑 Set or rotate the 5sim.net API key')
    .addStringOption(o =>
      o.setName('key').setDescription('Your 5sim API key').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // /set-smspool-api
  new SlashCommandBuilder()
    .setName('set-smspool-api')
    .setDescription('🔑 Set or rotate the SMSPool.net API key')
    .addStringOption(o =>
      o.setName('key').setDescription('Your SMSPool API key').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── INTERACTION HANDLER ─────────────────────────────────────────────────────

async function handleSMSInteraction(interaction, client) {
  const cfg = loadConfig();

  // ── /set-5sim-api ──────────────────────────────────────────────────────────
  if (interaction.commandName === 'set-5sim-api') {
    const key = interaction.options.getString('key');
    const updated = { ...cfg, fivesim_key: key };
    saveConfig(updated);
    return interaction.reply({ content: '✅ 5sim API key saved.', ephemeral: true });
  }

  // ── /set-smspool-api ───────────────────────────────────────────────────────
  if (interaction.commandName === 'set-smspool-api') {
    const key = interaction.options.getString('key');
    const updated = { ...cfg, smspool_key: key };
    saveConfig(updated);
    return interaction.reply({ content: '✅ SMSPool API key saved.', ephemeral: true });
  }

  // ── /gennumber — Step 1: Pick provider ────────────────────────────────────
  if (interaction.commandName === 'gennumber') {
    const hasFivesim  = !!cfg.fivesim_key;
    const hasSmspool  = !!cfg.smspool_key;

    if (!hasFivesim && !hasSmspool) {
      return interaction.reply({
        content: '❌ No SMS provider API keys configured. An admin must run `/set-5sim-api` or `/set-smspool-api` first.',
        ephemeral: true,
      });
    }

    const options = [];
    if (hasSmspool) options.push({ label: 'SMSPool.net', value: 'smspool', emoji: '📱', description: 'Fast, wide country coverage' });
    if (hasFivesim) options.push({ label: '5sim.net',    value: '5sim',    emoji: '🌐', description: 'Large service catalog' });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sms_pick_provider')
        .setPlaceholder('Choose a provider...')
        .addOptions(options)
    );

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📲 SMS Number Generator')
          .setDescription('Select a provider to get started.')
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
      ],
      components: [row],
      ephemeral: true,
    });
  }

  // ── Step 2: Provider selected → show services ──────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'sms_pick_provider') {
    await interaction.deferUpdate();
    const provider = interaction.values[0];
    const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let services;
    try {
      if (provider === '5sim') services = await fivesimGetProducts(apiKey);
      else services = await smspoolGetServices(apiKey);
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to fetch services: ${e.message}`, components: [] });
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sms_pick_service__${provider}`)
        .setPlaceholder('Choose a service...')
        .addOptions(services)
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} ${provider === '5sim' ? '5sim.net' : 'SMSPool.net'}`)
          .setDescription('Select the service you need a number for.')
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
      ],
      components: [row],
    });
  }

  // ── Step 3: Service selected → show countries ──────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_service__')) {
    await interaction.deferUpdate();
    const provider  = interaction.customId.split('__')[1];
    const service   = interaction.values[0];
    const apiKey    = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let countries;
    try {
      if (provider === '5sim') countries = await fivesimGetCountries(apiKey);
      else countries = await smspoolGetCountries(apiKey, service);
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to fetch countries: ${e.message}`, components: [] });
    }

    // Prepend "Any" option for 5sim
    if (provider === '5sim') {
      countries.unshift({ label: '🌍 Any Country', value: 'any' });
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sms_pick_country__${provider}__${service}`)
        .setPlaceholder('Choose a country/region...')
        .addOptions(countries.slice(0, 25))
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} Select Region`)
          .setDescription(`**Service:** ${capitalize(service)}\nNow pick a country.`)
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
      ],
      components: [row],
    });
  }

  // ── Step 4: Country selected → purchase number ─────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_country__')) {
    await interaction.deferUpdate();
    const [, provider, service] = interaction.customId.split('__');
    const country = interaction.values[0];
    const apiKey  = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let orderId, number;
    try {
      if (provider === '5sim') {
        ({ orderId, number } = await fivesimBuyNumber(apiKey, country, service));
      } else {
        ({ orderId, number } = await smspoolBuyNumber(apiKey, service, country));
      }
    } catch (e) {
      return interaction.editReply({
        content: `❌ Failed to get a number: **${e.message}**\nNo charge applied. Try a different country.`,
        components: [],
      });
    }

    const embed   = buildOrderEmbed(provider, service, country, number, 'waiting');
    const buttons = buildOrderButtons(orderId);

    // Edit ephemeral reply first (so user sees it), then post public message to channel
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x57f287).setDescription('✅ Number purchased! See below.')],
      components: [],
    });

    // Post publicly in channel with the number + buttons
    const publicMsg = await interaction.channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      components: [buttons],
    });

    // Start polling
    await startPolling(client, orderId, {
      provider, service, country, number,
      userId:    interaction.user.id,
      channelId: interaction.channel.id,
      messageId: publicMsg.id,
      pollTimer: null,
    });
  }

  // ── Button: Cancel & Refund ────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_cancel_')) {
    const orderId = interaction.customId.replace('sms_cancel_', '');
    const order   = activeOrders.get(orderId);

    if (!order) {
      return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    }

    // Check it's the owner
    if (order.userId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Only the person who ordered this can cancel it.', ephemeral: true });
    }

    await interaction.deferUpdate();

    // Stop polling
    if (order.pollTimer) clearTimeout(order.pollTimer);
    activeOrders.delete(orderId);

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
    try {
      if (order.provider === '5sim') await fivesimCancel(apiKey, orderId);
      else await smspoolCancel(apiKey, orderId);
    } catch {}

    const { provider, service, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, service, country, number, 'cancelled')],
      components: [buildOrderButtons(orderId, true)],
    });

    await interaction.followUp({ content: `🚫 Number cancelled. Refund issued to your balance.`, ephemeral: true });
  }

  // ── Button: Request New SMS (Resend) ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_resend_')) {
    const orderId = interaction.customId.replace('sms_resend_', '');
    const order   = activeOrders.get(orderId);

    if (!order) {
      return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    }

    if (order.userId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Only the person who ordered this can do this.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    if (order.provider === 'smspool') {
      const ok = await smspoolResend(apiKey, orderId).catch(() => false);
      if (!ok) {
        return interaction.followUp({ content: '❌ Resend not supported for this number. Try cancelling and getting a new one.', ephemeral: true });
      }
    }
    // 5sim doesn't have a resend, just keep polling

    const { provider, service, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, service, country, number, 'resent')],
      components: [buildOrderButtons(orderId)],
    });

    await interaction.followUp({ content: '🔄 Re-request sent. Still polling for your code...', ephemeral: true });
  }
}

module.exports = { commands, handleSMSInteraction };
