// ============================================================
// SMS NUMBER GENERATOR — SUPERBOT MODULE  v2.0
// Commands: /gennumber, /post-smsgen, /set-5sim-api, /set-smspool-api
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

const fs   = require('fs');
const path = require('path');

// ─── Persistent config ────────────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR || './data';
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
// orderId → { provider, service, serviceName, country, number, userId, channelId, messageId, pollTimer }
const activeOrders = new Map();

// ─── SMSPOOL API ──────────────────────────────────────────────────────────────
const SMSPOOL_BASE = 'https://api.smspool.net';

async function smspoolGetServices(apiKey) {
  const r = await fetch(`${SMSPOOL_BASE}/service/retrieve_all_services?key=${apiKey}`);
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch services');
  return d.slice(0, 25).map(s => ({ label: s.name, value: String(s.ID) }));
}
async function smspoolGetCountries(apiKey, serviceId) {
  const r = await fetch(`${SMSPOOL_BASE}/country/retrieve_all_countries?key=${apiKey}&service=${serviceId}`);
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(d.message || 'Failed to fetch countries');
  return d.slice(0, 25).map(c => ({ label: c.name, value: String(c.ID) }));
}
async function smspoolBuyNumber(apiKey, serviceId, countryId) {
  const r = await fetch(`${SMSPOOL_BASE}/sms/purchase?key=${apiKey}&service=${serviceId}&country=${countryId}`);
  const d = await r.json();
  if (d.success !== 1) throw new Error(d.message || 'Purchase failed');
  return { orderId: String(d.order_id), number: d.phonenumber };
}
async function smspoolCheckSMS(apiKey, orderId) {
  const r = await fetch(`${SMSPOOL_BASE}/sms/check?key=${apiKey}&orderid=${orderId}`);
  const d = await r.json();
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

// ─── 5SIM API ─────────────────────────────────────────────────────────────────
const FIVESIM_BASE = 'https://5sim.net/v1';

async function fivesimGetProducts(apiKey, country = 'any') {
  const r = await fetch(`${FIVESIM_BASE}/guest/products/${country}/any`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  return Object.keys(d).slice(0, 25).map(s => ({ label: capitalize(s), value: s }));
}
async function fivesimGetCountries(apiKey) {
  const r = await fetch(`${FIVESIM_BASE}/guest/countries`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const d = await r.json();
  if (d.message) throw new Error(d.message);
  return Object.keys(d).slice(0, 25).map(c => ({ label: capitalize(c), value: c }));
}
async function fivesimBuyNumber(apiKey, country, service) {
  const r = await fetch(`${FIVESIM_BASE}/user/buy/activation/${country}/any/${service}`, {
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
  const code = d.sms && d.sms.length > 0 ? d.sms[d.sms.length - 1].code : null;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
const PROVIDER_EMOJI = { smspool: '📱', '5sim': '🌐' };
const PROVIDER_COLOR = { smspool: 0x5865f2, '5sim': 0x57f287 };

function buildOrderEmbed(provider, serviceName, country, number, status, code) {
  const statusMap = {
    waiting:   { label: '⏳ Waiting for SMS...', color: 0xfee75c },
    received:  { label: '✅ Code received!',      color: 0x57f287 },
    failed:    { label: '❌ No SMS / Failed',      color: 0xed4245 },
    cancelled: { label: '🚫 Cancelled & Refunded', color: 0x99aab5 },
    resent:    { label: '🔄 Re-request sent...',   color: 0x5865f2 },
  };
  const s = statusMap[status] || statusMap.waiting;

  return new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`${PROVIDER_EMOJI[provider] || '📲'} SMS Number Generated`)
    .addFields(
      { name: '🔧 Provider', value: provider === '5sim' ? '5sim.net' : 'SMSPool.net', inline: true },
      { name: '📋 Service',  value: serviceName,              inline: true },
      { name: '🌍 Country',  value: capitalize(country),      inline: true },
      { name: '📞 Number',   value: `\`\`${number}\`\``,      inline: false },
      { name: '📡 Status',   value: s.label,                  inline: false },
      ...(code ? [{ name: '🔑 Your Code', value: `# \`${code}\``, inline: false }] : []),
    )
    .setFooter({ text: 'UH SERVICES • SMS Gen  |  Code didn\'t work? Hit 🔄 to request a new one, or 🚫 to cancel & refund' })
    .setTimestamp();
}

function buildOrderButtons(orderId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sms_resend_${orderId}`)
      .setLabel('Request New SMS')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`sms_cancel_${orderId}`)
      .setLabel('Cancel & Refund')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

// ─── Panel embed (posted by /post-smsgen) ────────────────────────────────────
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📲 SMS Number Generator')
    .setDescription(
      '**Get a temporary phone number for SMS verification on any platform.**\n\n' +
      '> Click **Get Number** below to choose your provider, service, and country.\n\n' +
      '**Supported Providers**\n' +
      '> 📱 **SMSPool.net** — Fast, wide country coverage\n' +
      '> 🌐 **5sim.net** — Large service catalog\n\n' +
      '**How it works**\n' +
      '> `1.` Choose provider → service → country\n' +
      '> `2.` Bot purchases & displays your number\n' +
      '> `3.` Enter it on the site you\'re verifying\n' +
      '> `4.` Code arrives here automatically\n\n' +
      '**Code didn\'t work?**\n' +
      '> Hit **🔄 Request New SMS** to try again on the same number\n' +
      '> Hit **🚫 Cancel & Refund** to get your balance back and try a different number\n' +
      '> Numbers auto-cancel after **5 minutes** if no SMS arrives'
    )
    .setFooter({ text: 'UH SERVICES • SMS Gen' })
    .setTimestamp();
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
const POLL_INTERVAL = 7000;       // 7s between checks
const POLL_TIMEOUT  = 5 * 60 * 1000; // 5 min max

async function startPolling(client, orderId, orderData) {
  const cfg = loadConfig();
  const { provider, serviceName, country, number, userId, channelId, messageId } = orderData;
  const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
  const start  = Date.now();

  const poll = async () => {
    // ── Timeout → auto-cancel ──────────────────────────────────────────────
    if (Date.now() - start > POLL_TIMEOUT) {
      try {
        if (provider === '5sim') await fivesimCancel(apiKey, orderId);
        else await smspoolCancel(apiKey, orderId);
        const ch  = await client.channels.fetch(channelId);
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send({ content: `<@${userId}> ⏰ No SMS received after 5 minutes — number cancelled & balance refunded.` });
      } catch {}
      activeOrders.delete(orderId);
      return;
    }

    try {
      const result = provider === '5sim'
        ? await fivesimCheckSMS(apiKey, orderId)
        : await smspoolCheckSMS(apiKey, orderId);

      const ch  = await client.channels.fetch(channelId);
      const msg = await ch.messages.fetch(messageId);

      // ── Code arrived ───────────────────────────────────────────────────
      if (result.code) {
        if (provider === '5sim') await fivesimFinish(apiKey, orderId).catch(() => {});
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'received', result.code)],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send({ content: `<@${userId}> ✅ Your SMS code: **\`${result.code}\`**\n> If this code doesn't work, hit **🔄 Request New SMS** on the message above.` });
        activeOrders.delete(orderId);
        return;
      }

      // ── Terminal failure states ────────────────────────────────────────
      const dead = ['CANCELED', 'TIMEOUT', 'BANNED', 'expired'].includes(result.status);
      if (dead) {
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true)],
        });
        await ch.send({ content: `<@${userId}> ❌ Number expired or banned by provider — no charge applied.` });
        activeOrders.delete(orderId);
        return;
      }
    } catch (e) {
      console.error('[SMS POLL ERROR]', e.message);
    }

    // Still pending — schedule next poll
    const timer = setTimeout(poll, POLL_INTERVAL);
    const existing = activeOrders.get(orderId);
    if (existing) existing.pollTimer = timer;
  };

  orderData.pollTimer = setTimeout(poll, POLL_INTERVAL);
  activeOrders.set(orderId, orderData);
}

// ─── Shared flow: show provider picker ───────────────────────────────────────
// Used by both /gennumber and the panel button (sms_open_panel)
async function showProviderPicker(interaction) {
  const cfg       = loadConfig();
  const hasFivesim = !!cfg.fivesim_key;
  const hasSmspool = !!cfg.smspool_key;

  if (!hasFivesim && !hasSmspool) {
    const msg = '❌ No SMS provider API keys configured. An admin must run `/set-5sim-api` or `/set-smspool-api` first.';
    if (interaction.replied || interaction.deferred) {
      return interaction.editReply({ content: msg, embeds: [], components: [] });
    }
    return interaction.reply({ content: msg, ephemeral: true });
  }

  const options = [];
  if (hasSmspool) options.push({ label: 'SMSPool.net', value: 'smspool', emoji: '📱', description: 'Fast, wide country coverage' });
  if (hasFivesim) options.push({ label: '5sim.net',    value: '5sim',    emoji: '🌐', description: 'Large service catalog' });

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('sms_pick_provider')
      .setPlaceholder('1️⃣  Choose a provider...')
      .addOptions(options)
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📲 SMS Number Generator')
    .setDescription('**Step 1 of 3** — Select a provider')
    .setFooter({ text: 'UH SERVICES • SMS Gen' });

  if (interaction.replied || interaction.deferred) {
    return interaction.editReply({ embeds: [embed], components: [row] });
  }
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('gennumber')
    .setDescription('📲 Generate a phone number for SMS verification'),

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
    .setName('set-smspool-api')
    .setDescription('🔑 Set or rotate the SMSPool.net API key')
    .addStringOption(o => o.setName('key').setDescription('Your SMSPool API key').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ─── Interaction handler ──────────────────────────────────────────────────────
async function handleSMSInteraction(interaction, client) {
  const cfg = loadConfig();

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

  // ── /post-smsgen ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'post-smsgen') {
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getChannel('channel') || interaction.channel;
    await target.send({ embeds: [buildPanelEmbed()], components: [buildPanelButton()] });
    return interaction.editReply({ content: `✅ SMS Gen panel posted in <#${target.id}>` });
  }

  // ── /gennumber ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'gennumber') {
    return showProviderPicker(interaction);
  }

  // ── Panel button → open provider picker (ephemeral) ────────────────────────
  if (interaction.isButton() && interaction.customId === 'sms_open_panel') {
    await interaction.deferReply({ ephemeral: true });
    return showProviderPicker(interaction);
  }

  // ── Step 2: Provider chosen → fetch & show services ────────────────────────
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
      return interaction.editReply({ content: `❌ Failed to fetch services: ${e.message}`, embeds: [], components: [] });
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sms_pick_service__${provider}`)
        .setPlaceholder('2️⃣  Choose a service...')
        .addOptions(services)
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} ${provider === '5sim' ? '5sim.net' : 'SMSPool.net'}`)
          .setDescription('**Step 2 of 3** — Select the service you need a number for')
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
      ],
      components: [row],
    });
  }

  // ── Step 3: Service chosen → fetch & show countries ────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_service__')) {
    await interaction.deferUpdate();
    const provider    = interaction.customId.split('__')[1];
    const serviceVal  = interaction.values[0];
    const serviceName = provider === '5sim' ? capitalize(serviceVal) : serviceVal; // SMSPool returns display name as value via label; 5sim is raw key
    const apiKey      = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    let countries;
    try {
      countries = provider === '5sim'
        ? await fivesimGetCountries(apiKey)
        : await smspoolGetCountries(apiKey, serviceVal);
    } catch (e) {
      return interaction.editReply({ content: `❌ Failed to fetch countries: ${e.message}`, embeds: [], components: [] });
    }

    if (provider === '5sim') countries.unshift({ label: '🌍 Any Country (cheapest)', value: 'any' });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sms_pick_country__${provider}__${serviceVal}`)
        .setPlaceholder('3️⃣  Choose a country...')
        .addOptions(countries.slice(0, 25))
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(PROVIDER_COLOR[provider] || 0x5865f2)
          .setTitle(`${PROVIDER_EMOJI[provider]} Select Country`)
          .setDescription(`**Step 3 of 3** — Service: **${serviceName}**\nPick a country/region for your number`)
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
      ],
      components: [row],
    });
  }

  // ── Step 4: Country chosen → purchase number ───────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sms_pick_country__')) {
    await interaction.deferUpdate();
    const parts      = interaction.customId.split('__');
    const provider   = parts[1];
    const serviceVal = parts[2];
    const country    = interaction.values[0];
    const apiKey     = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    // Resolve a clean display name for the service
    const serviceName = capitalize(serviceVal);

    let orderId, number;
    try {
      if (provider === '5sim') {
        ({ orderId, number } = await fivesimBuyNumber(apiKey, country, serviceVal));
      } else {
        ({ orderId, number } = await smspoolBuyNumber(apiKey, serviceVal, country));
      }
    } catch (e) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('❌ Failed to Purchase Number')
            .setDescription(`**${e.message}**\n\nNo charge was applied. Try a different country or provider.`)
            .setFooter({ text: 'UH SERVICES • SMS Gen' }),
        ],
        components: [],
      });
    }

    // Dismiss the ephemeral dropdown UI
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription('✅ Number purchased! Your order is posted below.'),
      ],
      components: [],
    });

    // Post publicly in the channel
    const publicMsg = await interaction.channel.send({
      content: `<@${interaction.user.id}>`,
      embeds:  [buildOrderEmbed(provider, serviceName, country, number, 'waiting')],
      components: [buildOrderButtons(orderId)],
    });

    // Begin polling for the SMS code
    await startPolling(client, orderId, {
      provider, serviceName, country, number,
      userId:    interaction.user.id,
      channelId: interaction.channel.id,
      messageId: publicMsg.id,
      pollTimer: null,
    });
    return;
  }

  // ── Button: Cancel & Refund ────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_cancel_')) {
    const orderId = interaction.customId.replace('sms_cancel_', '');
    const order   = activeOrders.get(orderId);

    if (!order) return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    if (order.userId !== interaction.user.id) return interaction.reply({ content: '❌ Only the person who ordered this can cancel it.', ephemeral: true });

    await interaction.deferUpdate();
    if (order.pollTimer) clearTimeout(order.pollTimer);
    activeOrders.delete(orderId);

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
    try {
      if (order.provider === '5sim') await fivesimCancel(apiKey, orderId);
      else await smspoolCancel(apiKey, orderId);
    } catch {}

    const { provider, serviceName, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'cancelled')],
      components: [buildOrderButtons(orderId, true)],
    });
    await interaction.followUp({ content: '🚫 Number cancelled. Balance refunded to your provider account.', ephemeral: true });
    return;
  }

  // ── Button: Request New SMS (Resend) ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_resend_')) {
    const orderId = interaction.customId.replace('sms_resend_', '');
    const order   = activeOrders.get(orderId);

    if (!order) return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    if (order.userId !== interaction.user.id) return interaction.reply({ content: '❌ Only the person who ordered this can do this.', ephemeral: true });

    await interaction.deferUpdate();

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    if (order.provider === 'smspool') {
      const ok = await smspoolResend(apiKey, orderId).catch(() => false);
      if (!ok) {
        await interaction.followUp({
          content: '❌ Resend not available for this number.\nHit **🚫 Cancel & Refund** to get your balance back, then run `/gennumber` again.',
          ephemeral: true,
        });
        return;
      }
    }
    // 5sim: no resend endpoint — polling is already running, just update the embed

    const { provider, serviceName, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'resent')],
      components: [buildOrderButtons(orderId)],
    });
    await interaction.followUp({ content: '🔄 Re-request sent — still watching for your code...', ephemeral: true });
    return;
  }
}

module.exports = { commands, handleSMSInteraction };
