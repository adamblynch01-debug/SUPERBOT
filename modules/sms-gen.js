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

// ─── Safe JSON fetch — handles plain-text error responses ─────────────────────
async function safeFetch(url, opts = {}) {
  const r = await fetch(url, opts);
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
    api_key: apiKey,
    service: serviceParam,
    country: countryShort,
  });
  const d = await safeFetch(`${SMSPOOL_BASE}/purchase/sms`, { method: 'POST', body: purchaseParams });
  console.log('[SMSPOOL PURCHASE RESPONSE] ' + JSON.stringify(d));
  if (d.success !== 1) throw new Error(d.message || 'No numbers available for this country/service — try a different country');
  return { orderId: String(d.order_id), number: d.phonenumber || d.number };
}

async function smspoolCheckSMS(apiKey, orderId) {
  const d = await safeFetch(`${SMSPOOL_BASE}/sms/check?api_key=${apiKey}&orderid=${orderId}`);
  // /sms/check: status = "pending" | "completed" | "expired" | "refunded"
  // sms field = the code, full_sms = full message text
  const code = d.sms && d.sms !== '0' && d.sms !== 0 ? String(d.sms) : null;
  return { status: d.status, code };
}

async function smspoolCancel(apiKey, orderId) {
  await safeFetch(`${SMSPOOL_BASE}/sms/cancel?api_key=${apiKey}&orderid=${orderId}`, { method: 'POST' }).catch(() => {});
}

async function smspoolResend(apiKey, orderId) {
  const d = await safeFetch(`${SMSPOOL_BASE}/sms/resend?api_key=${apiKey}&orderid=${orderId}`, { method: 'POST' }).catch(() => ({}));
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
  const code = d.sms && d.sms.length > 0 ? d.sms[d.sms.length - 1].code : null;
  return { status: d.status, code };
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

const PROVIDER_EMOJI = { smspool: '📱', '5sim': '🌐' };
const PROVIDER_COLOR = { smspool: 0x5865f2, '5sim': 0x57f287 };

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
    .setTitle(`${PROVIDER_EMOJI[provider] || '📲'} SMS Number Generated`)
    .addFields(
      { name: '🔧 Provider', value: provider === '5sim' ? '5sim.net' : 'SMSPool.net', inline: true },
      { name: '📋 Service',  value: serviceName,         inline: true },
      { name: '🌍 Country',  value: capitalize(country), inline: true },
      { name: '📞 Number',   value: `\`${number}\``,     inline: false },
      { name: '📡 Status',   value: s.label,             inline: false },
      ...(code ? [{ name: '🔑 Your Code', value: `# \`${code}\``, inline: false }] : []),
    )
    .setFooter({ text: "UH SERVICES • SMS Gen  |  Code didn't work? Hit 🔄 for a new one or 🚫 to cancel & refund" })
    .setTimestamp();
}

function buildOrderButtons(orderId, disabled = false, number = null) {
  const btns = [
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
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📲 SMS Number Generator')
    .setDescription(
      '**Get a temporary phone number for SMS verification on any platform.**\n\n' +
      '> Click **Get Number** below to choose your provider, service, and country.\n\n' +
      '**Supported Providers**\n' +
      '> 📱 **SMSPool.net** — Fast, wide country coverage\n' +
      '> 🌐 **5sim.net** — 135+ countries, operator selection\n\n' +
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
const POLL_INTERVAL = 7000;
const POLL_TIMEOUT  = 5 * 60 * 1000;

async function startPolling(client, orderId, orderData) {
  const cfg    = loadConfig();
  const { provider, serviceName, country, number, userId, channelId, messageId } = orderData;
  const apiKey = provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
  const start  = Date.now();

  const poll = async () => {
    if (Date.now() - start > POLL_TIMEOUT) {
      try {
        if (provider === '5sim') await fivesimCancel(apiKey, orderId);
        else await smspoolCancel(apiKey, orderId);
        const ch  = await client.channels.fetch(channelId);
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'failed')],
          components: [buildOrderButtons(orderId, true, number)],
        });
        await ch.send({ content: `<@${userId}> ⏰ No SMS after 5 minutes — number cancelled & balance refunded.` });
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

      if (result.code) {
        if (provider === '5sim') await fivesimFinish(apiKey, orderId);
        await msg.edit({
          embeds: [buildOrderEmbed(provider, serviceName, country, number, 'received', result.code)],
          components: [buildOrderButtons(orderId, true, number)],
        });
        await ch.send({
          content: `<@${userId}> ✅ Your SMS code: **\`${result.code}\`**\n> Code didn't work? Hit **🔄 Request New SMS** above.`,
        });
        activeOrders.delete(orderId);
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
        return;
      }
    } catch (e) {
      console.error('[SMS POLL ERROR]', e.message);
    }

    const timer = setTimeout(poll, POLL_INTERVAL);
    const existing = activeOrders.get(orderId);
    if (existing) existing.pollTimer = timer;
  };

  orderData.pollTimer = setTimeout(poll, POLL_INTERVAL);
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
  if (hasSmspool) options.push({ label: 'SMSPool.net', value: 'smspool', emoji: '📱', description: 'Fast, wide country coverage' });
  if (hasFivesim) options.push({ label: '5sim.net',    value: '5sim',    emoji: '🌐', description: '135+ countries, operator selection' });

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

  // ── Panel button → open provider picker ────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sms_open_panel') {
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
      return interaction.editReply({ content: `❌ Failed to fetch services: ${e.message}`, embeds: [], components: [] });
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
          .setTitle(`${PROVIDER_EMOJI[provider]} ${provider === '5sim' ? '5sim.net' : 'SMSPool.net'}`)
          .setDescription(`**Step 2 of 3** — Find the service you need\n${total} services available — type a name to search`)
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
            .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
            .setTitle(`${PROVIDER_EMOJI[provider]} ${provider === '5sim' ? '5sim.net' : 'SMSPool.net'}`)
            .setDescription(`**Step 2 of 3** — Page ${newPage + 1} of ${Math.ceil(total / PAGE_SIZE)}\n${total} services available`)
            .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
      return interaction.editReply({ content: `❌ Failed to fetch countries: ${e.message}`, embeds: [], components: [] });
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
          .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
            .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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
        return interaction.editReply({ content: `❌ ${e.message}`, embeds: [], components: [] });
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
            .setFooter({ text: 'UH SERVICES • SMS Gen' }),
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

    await interaction.deferUpdate();
    if (order.pollTimer) clearTimeout(order.pollTimer);
    activeOrders.delete(orderId);

    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;
    if (order.provider === '5sim') await fivesimCancel(apiKey, orderId);
    else await smspoolCancel(apiKey, orderId);

    const { provider, serviceName, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'cancelled')],
      components: [buildOrderButtons(orderId, true, number)],
    });
    return interaction.followUp({ content: '🚫 Number cancelled. Balance refunded to your provider account.', ephemeral: true });
  }

  // ── Button: Request New SMS ────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_resend_')) {
    const orderId = interaction.customId.replace('sms_resend_', '');
    const order   = activeOrders.get(orderId);
    if (!order) return interaction.reply({ content: '❌ Order not found or already resolved.', ephemeral: true });
    if (order.userId !== userId) return interaction.reply({ content: '❌ Only the person who ordered this can do this.', ephemeral: true });

    await interaction.deferUpdate();
    const apiKey = order.provider === '5sim' ? cfg.fivesim_key : cfg.smspool_key;

    if (order.provider === 'smspool') {
      const ok = await smspoolResend(apiKey, orderId);
      if (!ok) {
        return interaction.followUp({
          content: '❌ Resend not available for this number.\nHit **🚫 Cancel & Refund** to get your balance back, then try again.',
          ephemeral: true,
        });
      }
    }

    const { provider, serviceName, country, number } = order;
    await interaction.message.edit({
      embeds: [buildOrderEmbed(provider, serviceName, country, number, 'resent')],
      components: [buildOrderButtons(orderId, false, number)],
    });
    return interaction.followUp({ content: '🔄 Re-request sent — still watching for your code...', ephemeral: true });
  }

  // ── Button: Copy Number ────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sms_copy_')) {
    const orderId = interaction.customId.replace('sms_copy_', '');
    // Find number from active order or embed fields
    const order = activeOrders.get(orderId);
    const number = order?.number ||
      interaction.message?.embeds?.[0]?.fields?.find(f => f.name.includes('Number'))?.value?.replace(/`/g, '').trim();
    if (!number) return interaction.reply({ content: '❌ Could not retrieve number.', ephemeral: true });
    return interaction.reply({
      content: number,   // plain number — tap to select & copy

      ephemeral: true,
    });
  }

}

// ─── Purchase handler (shared by SMSPool + 5sim paths) ───────────────────────
async function purchaseNumber(interaction, client, provider, apiKey, session, country, operator) {
  const { serviceVal, serviceName } = session;

  let orderId, number;
  try {
    if (provider === '5sim') {
      ({ orderId, number } = await fivesimBuyNumber(apiKey, country, serviceVal, operator));
    } else {
      ({ orderId, number } = await smspoolBuyNumber(apiKey, serviceVal, country, serviceName));
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

  // Clean up session cache
  userSessionCache.delete(interaction.user.id);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x57f287).setDescription('✅ Number purchased! Your order is posted below.')],
    components: [],
  });

  const publicMsg = await interaction.channel.send({
    content: `<@${interaction.user.id}>`,
    embeds:  [buildOrderEmbed(provider, serviceName, country, number, 'waiting')],
    components: [buildOrderButtons(orderId, false, number)],
  });

  await startPolling(client, orderId, {
    provider, serviceName, country, number,
    userId:    interaction.user.id,
    channelId: interaction.channel.id,
    messageId: publicMsg.id,
    pollTimer: null,
  });
}

module.exports = { commands, handleSMSInteraction };
