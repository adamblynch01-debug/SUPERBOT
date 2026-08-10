// ─── #website AND #payment-methods ────────────────────────────────────────────
// Both channels had one message in them. #website had a bare embed containing
// the string "uhservices.xyz" and nothing else — no idea what the site is, what
// you can do there, or why you would tap it. #payment-methods had whatever
// prose a staff member last typed into /set-payment-method, which is a document,
// not a panel. "Looks dead" was the report and it was the right word.
//
// The thing that makes these panels different from a nicer-looking hardcode is
// that the numbers on them are FETCHED. A panel that says "+10% Cash App fee"
// and "pay within 3 hours" is making two promises the store has to keep, and
// both of those are env vars the operator can change on Railway without
// touching Discord. So the fees, the payment window, the cashtag and which
// methods exist at all come from the backend's /api/config at post time — and
// the panel says when it was read, so a stale one is visible as stale rather
// than merely wrong.
//
// Re-running the command EDITS the existing panel rather than posting a second
// one. There is no table for "which message is the panel": each embed carries a
// marker in its footer and the command looks for it in the channel's recent
// history. That survives a bot restart, which an in-memory map (the old
// /setwebsite) did not — restart it and the next /setwebsite posted a duplicate.
'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits,
} = require('discord.js');
const axios = require('axios');
const { languageRow } = require('./translate');

const BACKEND_URL = (process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SITE_URL    = (process.env.SITE_URL || 'https://zeropoint.wtf').replace(/\/+$/, '');

// The needle the panels are found by. In the footer because a footer is the one
// part of an embed nobody scans, and it has to survive being looked at.
const MARK_SITE = 'panel:website';
const MARK_PAY  = 'panel:payments';

let gate = { hasAccess: () => false };
function setStorefrontGate(g) { gate = { ...gate, ...g }; }

// ─── the numbers ──────────────────────────────────────────────────────────────
// Cached for a minute so posting both panels back to back is one request, and
// so a backend that is down does not make the command hang twice.
let cache = { at: 0, cfg: null };
// `fresh` bypasses the cache. Used by the refresher when it has just been told
// a switch moved: reading a minute-old config there would repaint the panel
// with the state the admin just changed away from, which looks exactly like
// the toggle not working.
async function storeConfig({ fresh = false } = {}) {
  if (!fresh && cache.cfg && Date.now() - cache.at < 60000) return cache.cfg;
  try {
    const { data } = await axios.get(`${BACKEND_URL}/api/config`, { timeout: 8000 });
    cache = { at: Date.now(), cfg: data };
    return data;
  } catch (e) {
    console.warn('[Panels] /api/config unreachable:', e.message);
    // Null, not a guess. Every caller below treats "no config" as "say less",
    // because a fee quoted from a default this file invented would be a number
    // the checkout has never heard of.
    return null;
  }
}

// "`+10%`", or an empty string if the payload did not carry that fee.
//
// Not a default, for the same reason the window is not one. The backend's own
// fallback is `CRYPTO_FEE_PERCENT || 5`, so copying 5 here looks safe right up
// until an operator sets CRYPTO_FEE_PERCENT=8 on a backend too old to serve the
// key — at which point the panel confidently quotes a fee the checkout does not
// charge. `0` must survive, though: parseFloat('0') is falsy and that is the
// exact shape that silently substitutes 10.
const feeChip = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `\`+${n}%\`` : '';
};

// "180" → "3 hours", "90" → "1h 30m". A window is read by a person deciding
// whether they have time to go and find their phone.
//
// NULL for anything unusable, and that is the important case. There are three
// states, not two: the backend is down (handled by the callers), the backend
// answers with expiry_minutes, and the backend answers WITHOUT it — which is
// every deploy older than the one that added the key. Rounding that third state
// up to a floor of 1 printed "pay within 1 minutes" on a live panel. A window
// this file cannot read is a window it must not state.
// A cashtag is $ followed by a handle. CASHAPP_CASHTAG on the live backend is
// the string " your $cashtag" — the placeholder from whatever setup doc it was
// copied out of, never replaced. /api/config reports `cashapp: true` from that
// (the check is only "is the env var non-empty"), so the method is advertised
// and the panel would have published the placeholder into a public channel as
// the address to send money to.
//
// The panel cannot fix the env var. What it can do is refuse to print a string
// that is not an address and tell the staff member who ran the command, which
// is the difference between a bug someone notices and a bug a buyer finds.
const cashtagOK = (s) => /^\$[A-Za-z0-9_]{1,20}$/.test(String(s || '').trim());
const emailOK   = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

// Which advertised methods are missing the address a buyer would send to. The
// command surfaces this; nothing about it reaches the channel.
function addressProblems(cfg) {
  if (!cfg) return [];
  const enabled = cfg.payment_methods || {};
  const out = [];
  if (enabled.cashapp && !cashtagOK(cfg.cashapp_cashtag)) {
    out.push(`**Cash App** is switched on but \`CASHAPP_CASHTAG\` is not a cashtag`
      + `${cfg.cashapp_cashtag ? ` (it is \`${String(cfg.cashapp_cashtag).trim()}\`)` : ' (it is empty)'}`
      + ' — the panel left the address off. Set it in Railway.');
  }
  if (enabled.paypal && !emailOK(cfg.paypal_email)) {
    out.push('**PayPal** is switched on but `PAYPAL_EMAIL` is not an email address'
      + ' — the panel left the address off. Set it in Railway.');
  }
  return out;
}

function humanMinutes(mins) {
  const m = Math.round(Number(mins));
  if (!Number.isFinite(m) || m < 1) return null;
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60), rest = m % 60;
  if (!rest) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h}h ${rest}m`;
}


// ─── the website panel ────────────────────────────────────────────────────────
function buildWebsitePanel(guild, cfg, url) {
  const site = (url || SITE_URL).replace(/\/+$/, '');
  const shown = site.replace(/^https?:\/\//, '');
  const store = (cfg && cfg.store_name) || guild.name;

  const methods = [];
  if (cfg && cfg.payment_methods) {
    if (cfg.payment_methods.btc) methods.push('Bitcoin');
    if (cfg.payment_methods.ltc) methods.push('Litecoin');
    if (cfg.payment_methods.cashapp) methods.push('Cash App');
    if (cfg.payment_methods.paypal) methods.push('PayPal');
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: store, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🌐  ${shown}`)
    .setURL(site)
    .setDescription(
      `**The store is open 24/7 and delivery is automatic.**\n`
      + `Pick what you want, pay, and your keys land in your DMs and in your account within seconds — `
      + `no waiting for a staff member to wake up.`
    )
    .addFields(
      { name: '🛒 Browse & buy', value: 'Every product, live stock and current pricing.', inline: true },
      { name: '⚡ Instant delivery', value: 'Keys are issued the moment payment confirms.', inline: true },
      { name: '📦 Your orders', value: 'Sign in with Discord — no password. Every key you have ever bought stays there.', inline: true },
    );

  if (methods.length) {
    embed.addFields({ name: '💳 Payments accepted', value: methods.join(' • '), inline: false });
  }
  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${shown} • ${MARK_SITE}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Visit the store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(site),
    new ButtonBuilder().setLabel('My orders').setEmoji('📦').setStyle(ButtonStyle.Link).setURL(`${site}/account`),
    new ButtonBuilder().setLabel('Support').setEmoji('🎫').setStyle(ButtonStyle.Link).setURL(`${site}/support`),
  );
  return { embeds: [embed], components: [row] };
}

// ─── the payment panel ────────────────────────────────────────────────────────
// One entry per method, and each says the three things a buyer actually needs:
// what it costs, how long they have, and who confirms it. The last one matters
// more than it looks — "auto-confirmed" and "a human reads the email" are very
// different waits, and not saying which is why people open tickets.
function paymentRows(cfg) {
  if (!cfg) return [];
  const enabled = cfg.payment_methods || {};
  const cryptoWindow = humanMinutes(cfg.expiry_minutes && cfg.expiry_minutes.crypto);
  const cashWindow   = humanMinutes(cfg.expiry_minutes && cfg.expiry_minutes.cash);
  const rows = [];

  // The cost/window strip, with whichever halves are actually knowable. Built
  // by joining rather than by interpolating so that a missing fee does not
  // leave a stray bullet and a missing everything does not leave a blank line
  // above the sentence.
  const strip = (fee, w) => {
    const head = [feeChip(fee), w ? `pay within **${w}**` : ''].filter(Boolean).join(' • ');
    return head ? head + '\n' : '';
  };

  if (enabled.btc) rows.push({
    name: '₿  Bitcoin',
    value: strip(cfg.crypto_fee, cryptoWindow)
      + 'Confirmed automatically on-chain. A fresh address is generated for your order.',
  });
  if (enabled.ltc) rows.push({
    name: 'Ł  Litecoin',
    value: strip(cfg.crypto_fee, cryptoWindow)
      + 'Cheaper and faster to confirm than Bitcoin. Same automatic confirmation.',
  });
  if (enabled.cashapp) rows.push({
    name: '💵  Cash App',
    value: strip(cfg.cashapp_fee, cashWindow)
      + `${cashtagOK(cfg.cashapp_cashtag) ? `Send to **${String(cfg.cashapp_cashtag).trim()}**\n` : ''}`
      // The one method that cannot hold the shop's currency. Said here because
      // a buyer who reads €19.99 on this panel and then sees a dollar figure at
      // checkout has every reason to think the price changed on them — and a
      // buyer who thinks the price changed closes the tab.
      + 'Cash App cannot send euro, so the pay screen shows your total converted to **USD** '
      + 'at the ECB rate and holds that figure for your order. The price is still in EUR.\n'
      + 'Confirmed automatically when the payment notification arrives.',
  });
  if (enabled.paypal) rows.push({
    name: '🅿️  PayPal',
    value: strip(cfg.paypal_fee, cashWindow)
      + `${emailOK(cfg.paypal_email) ? `Send to **${String(cfg.paypal_email).trim()}**\n` : ''}`
      + 'Confirmed automatically when the payment notification arrives.',
  });
  rows.push({
    name: '👛  Store balance',
    value: '`no fee` • **instant**\nTop your balance up once, then check out in one tap. Nothing to confirm, nothing to wait for.',
  });
  return rows;
}

function buildPaymentPanel(guild, cfg, url) {
  const site = (url || SITE_URL).replace(/\/+$/, '');
  const rows = paymentRows(cfg);

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setAuthor({ name: (cfg && cfg.store_name) || guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('💳  Payment Methods')
    .setDescription(
      cfg
        ? '**Every order is placed on the site — you choose the method at checkout.**\n'
          + 'The exact amount, the address and a countdown all appear on the pay screen. '
          + 'Pay it, and your keys arrive by DM automatically.'
        : '**Every order is placed on the site — you choose the method at checkout.**\n'
          + '_Live fees and payment windows could not be read just now; the pay screen always shows the exact amount and a countdown._'
    );

  if (rows.length) embed.addFields(rows);

  embed.addFields({
    name: '⚠️  Before you send anything',
    value: [
      '• Pay the **exact total** on the pay screen — the fee is already in it.',
      '• Orders expire. Once the countdown runs out that payment no longer settles itself.',
      '• Staff will **never** DM you first asking for payment. Nobody here needs your password.',
    ].join('\n'),
  });

  // Says what it actually read, not what it hoped to. "Fees and windows read
  // from the store" over a panel with no windows on it is the small kind of
  // lie that stops anyone trusting the big kind.
  const got = [
    rows.some(r => /`\+/.test(r.value)) ? 'fees' : '',
    rows.some(r => /pay within/.test(r.value)) ? 'payment windows' : '',
  ].filter(Boolean);
  embed.setFooter({
    text: cfg
      ? `${got.length ? `${got.join(' and ')} read from the store` : 'Read from the store'} • ${MARK_PAY}`
      : `Store unreachable when posted • ${MARK_PAY}`,
  }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Buy now').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(site),
    new ButtonBuilder().setCustomId('pay_howto').setLabel('How do I pay?').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('Top up balance').setEmoji('👛').setStyle(ButtonStyle.Link).setURL(`${site}/account`),
  );
  return { embeds: [embed], components: [row] };
}

// ─── posting ──────────────────────────────────────────────────────────────────
// Edit in place if the panel is already there. Scanning the last 50 messages is
// enough for a channel that holds one post, and the failure mode if it is not —
// a second panel — is visible and fixable, unlike a stored id pointing at a
// message somebody deleted.
async function upsertPanel(channel, marker, payload, me) {
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find(m =>
      m.author.id === me.id && m.embeds.some(e => (e.footer && e.footer.text || '').includes(marker)));
    if (existing) { await existing.edit(payload); return { edited: true, message: existing }; }
  } catch (e) {
    // Missing Read Message History is not a reason to post nothing.
    console.warn('[Panels] could not scan for an existing panel:', e.message);
  }
  const message = await channel.send(payload);
  return { edited: false, message };
}

// ─── keeping the payments panel true ──────────────────────────────────────────
// The panel lists methods straight out of `cfg.payment_methods`, so the moment
// somebody closes Cash App the posted message is a lie — and it is a lie in the
// worst possible direction, because "send your money here" is an instruction
// and buyers follow instructions. Telling an admin to re-run a command puts the
// correctness of a public payment notice on someone remembering to do it while
// dealing with whatever made them close the method in the first place.
//
// So the panel edits itself, the same way /post-status does. Two triggers,
// because there are two ways the state moves: a timer (the website's admin
// panel can toggle a method, and Discord hears nothing about it) and an
// immediate forced pass right after a /config methods press, so the person who
// just clicked sees the channel change.
//
// The message reference is kept on the backend under a free-form `kind` in the
// same app_state blob /post-status uses — no migration, no new route. It has to
// live there rather than in memory because a redeploy would otherwise orphan
// the panel and the next command would post a duplicate.
const PAY_PANEL_KIND = 'paypanel';
const payPanelKind = (guildId) => `${PAY_PANEL_KIND}:${guildId}`;

// Keyed by guild: "unchanged since I last wrote it" is a per-server question,
// and one shared variable would let the second server's first refresh see the
// first server's signature and skip its write.
const payPanelSignatures = new Map();
// Guilds already searched for a panel posted before this file could record one.
// Searched once per boot, so a server that has no panel does not pay for a
// history scan on every tick forever.
const payPanelAdopted = new Set();

async function loadPayPanelRefs() {
  if (!process.env.API_SECRET) return null;
  try {
    const r = await axios.get(`${BACKEND_URL}/api/status/panel`,
      { params: { secret: process.env.API_SECRET, kind: PAY_PANEL_KIND }, timeout: 10000 });
    return (r.data && r.data.panels) || {};
  } catch (err) {
    console.warn('[Panels] could not load the payments panel reference:', err.message);
    return null;
  }
}

async function savePayPanelRef(guildId, channelId, messageIds) {
  if (!process.env.API_SECRET) return;
  try {
    await axios.post(`${BACKEND_URL}/api/status/panel`, {
      secret: process.env.API_SECRET, kind: payPanelKind(guildId),
      channel_id: channelId || null, message_ids: messageIds || [],
    }, { timeout: 10000 });
  } catch (err) {
    console.warn('[Panels] could not save the payments panel reference:', err.message);
  }
}

// Deliberately built from the config the panel is rendered FROM, never from the
// rendered embed: the embed carries a .setTimestamp() that changes on every
// build, so a signature taken from it would report a change every tick and edit
// the panel forever.
function paymentPanelSignature(cfg) {
  if (!cfg) return null;
  return JSON.stringify({
    methods: cfg.payment_methods || {},
    fees: [cfg.crypto_fee, cfg.cashapp_fee, cfg.paypal_fee],
    windows: cfg.expiry_minutes || {},
    addresses: [cfg.cashapp_cashtag, cfg.paypal_email],
    name: cfg.store_name,
  });
}

function payPanelPayload(guild, cfg) {
  const built = buildPaymentPanel(guild, cfg, '');
  // The language dropdown has to be re-attached on every edit. An edit replaces
  // the components wholesale, so leaving it off would silently strip the
  // translate control off a panel that had one — a refresh that quietly removes
  // a feature is worse than no refresh.
  return built.components && built.components.length >= 5
    ? built
    : { ...built, components: [...(built.components || []), languageRow()] };
}

// A panel posted before any of this existed has no stored reference, so the
// refresher would ignore it until somebody re-ran the command — which is the
// exact chore this is meant to remove. Find it by the same footer marker the
// command uses and file it.
async function adoptPaymentPanel(guild, findChannel) {
  if (payPanelAdopted.has(guild.id)) return null;
  payPanelAdopted.add(guild.id);
  const channel = findChannel && findChannel(guild, 'payment-methods');
  if (!channel || !channel.isTextBased?.()) return null;
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const found = recent.find(m =>
      m.author.id === guild.client.user.id &&
      m.embeds.some(e => (e.footer && e.footer.text || '').includes(MARK_PAY)));
    if (!found) return null;
    await savePayPanelRef(guild.id, channel.id, [found.id]);
    console.log(`[Panels] adopted the payments panel already posted in guild ${guild.id}`);
    return { channel_id: channel.id, message_ids: [found.id] };
  } catch (e) {
    console.warn('[Panels] could not scan for an existing payments panel:', e.message);
    return null;
  }
}

/**
 * Repaint every payments panel this bot knows about.
 *
 * `force` skips the unchanged-check — used straight after a toggle, where
 * showing the change immediately is the entire point.
 */
async function refreshPaymentPanels(client, { force = false, findChannel = null } = {}) {
  if (!client || !process.env.API_SECRET) return;

  const refs = await loadPayPanelRefs();
  if (!refs) return;

  const targets = Object.keys(refs)
    .filter(k => k.startsWith(`${PAY_PANEL_KIND}:`))
    .map(k => ({ guildId: k.slice(PAY_PANEL_KIND.length + 1), ref: refs[k] }))
    .filter(t => t.ref && t.ref.channel_id && (t.ref.message_ids || []).length);

  // Nothing filed yet — look for a panel posted before this shipped.
  if (findChannel) {
    for (const guild of client.guilds.cache.values()) {
      if (targets.some(t => t.guildId === guild.id)) continue;
      const adopted = await adoptPaymentPanel(guild, findChannel);
      if (adopted) targets.push({ guildId: guild.id, ref: adopted });
    }
  }
  if (!targets.length) return;

  const cfg = await storeConfig({ fresh: true });
  // A failed read is not "no methods are accepted". Repainting a public channel
  // to an empty method list because /api/config blipped would invent an outage.
  if (!cfg) return;
  const signature = paymentPanelSignature(cfg);

  for (const { guildId, ref } of targets) {
    if (!force && signature === payPanelSignatures.get(guildId)) continue;
    try {
      const guild = await client.guilds.fetch(guildId);
      const channel = await client.channels.fetch(ref.channel_id);
      if (!channel || !channel.isTextBased?.()) continue;
      const msg = await channel.messages.fetch(ref.message_ids[0]);
      await msg.edit(payPanelPayload(guild, cfg));
      payPanelSignatures.set(guildId, signature);
    } catch (err) {
      // 10008 Unknown Message / 10003 Unknown Channel — somebody deleted it.
      // Forget the reference rather than failing on a timer forever; the next
      // /setup-payments files a new one.
      if (err.code === 10008 || err.code === 10003) {
        console.warn(`[Panels] the payments panel in guild ${guildId} is gone — forgetting it`);
        await savePayPanelRef(guildId, null, []);
        payPanelSignatures.delete(guildId);
        payPanelAdopted.delete(guildId);
        continue;
      }
      console.warn(`[Panels] payments panel refresh failed for guild ${guildId}:`, err.message);
    }
  }
}

const commands = [
  new SlashCommandBuilder().setName('setup-website')
    .setDescription('Admin: Post (or refresh) the website panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #website)').setRequired(false))
    .addStringOption(o => o.setName('url').setDescription('Store URL, if it is not the default').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-payments')
    .setDescription('Admin: Post (or refresh) the payment methods panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #payment-methods)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// Resolving the default channel is the caller's job: index.js owns
// findChannelByName, which is what makes these work on a server whose channels
// are named in mathematical bold.
async function handleStorefrontCommand(interaction, { findChannel }) {
  const cmd = interaction.commandName;
  if (cmd !== 'setup-website' && cmd !== 'setup-payments') return false;
  if (!gate.hasAccess(interaction)) {
    await interaction.reply({ content: '❌ No permission.', flags: 64 });
    return true;
  }
  await interaction.deferReply({ flags: 64 });

  const isSite = cmd === 'setup-website';
  const wanted = isSite ? 'website' : 'payment-methods';
  const channel = interaction.options.getChannel('channel')
    || findChannel(interaction.guild, wanted)
    || interaction.channel;

  const cfg = await storeConfig();
  const url = isSite ? (interaction.options.getString('url') || '').trim() : '';
  const site = url && !/^https?:\/\//.test(url) ? `https://${url}` : url;

  const built = isSite
    ? buildWebsitePanel(interaction.guild, cfg, site)
    : buildPaymentPanel(interaction.guild, cfg, site);

  // The language dropdown, same as /announce and the TOS posts carry. These two
  // were the panels a non-English customer is most likely to be standing in
  // front of — how to pay, and where the shop is — and they were the two with
  // no way to read them. Each builds one action row, so the second is free;
  // guarded anyway, because five is a hard cap and exceeding it rejects the
  // whole message rather than dropping the extra row.
  const payload = built.components && built.components.length >= 5
    ? built
    : { ...built, components: [...(built.components || []), languageRow()] };

  try {
    const { edited, message } = await upsertPanel(channel, isSite ? MARK_SITE : MARK_PAY, payload, interaction.client.user);
    // File the payments panel so the refresher can keep it true. The website
    // panel is not tracked: nothing on it moves on its own.
    if (!isSite && message) {
      payPanelSignatures.set(interaction.guildId, paymentPanelSignature(cfg));
      payPanelAdopted.add(interaction.guildId);
      await savePayPanelRef(interaction.guildId, channel.id, [message.id]);
    }
    await interaction.editReply(
      `${edited ? '♻️ Refreshed' : '📌 Posted'} the ${isSite ? 'website' : 'payment methods'} panel in <#${channel.id}>.`
      + (isSite ? '' : ' It updates itself from now on — you will not need to run this again when a method is switched on or off.')
      + (cfg ? '' : '\n⚠️ The store did not answer, so the panel went out without live fees or payment windows.'
             + ' Run this again once it is up — it will edit the same message.')
      + (interaction.options.getChannel('channel') || findChannel(interaction.guild, wanted)
          ? '' : `\nℹ️ No **#${wanted}** channel here, so it went in this one.`)
      // Ephemeral, so a misconfigured cashtag is told to the admin who ran the
      // command rather than to the channel.
      + (isSite ? '' : addressProblems(cfg).map(p => `\n⚠️ ${p}`).join(''))
    );
  } catch (e) {
    await interaction.editReply(`❌ Could not post there: ${e.message}`);
  }
  return true;
}

// The one button. Deliberately ephemeral: it is a walkthrough for the person
// who pressed it, not another wall in the channel.
async function handleStorefrontButton(interaction) {
  if (interaction.customId !== 'pay_howto') return false;
  const cfg = await storeConfig();
  const enabled = (cfg && cfg.payment_methods) || {};
  const cryptoWindow = humanMinutes(cfg && cfg.expiry_minutes && cfg.expiry_minutes.crypto);
  const cashWindow   = humanMinutes(cfg && cfg.expiry_minutes && cfg.expiry_minutes.cash);

  const steps = [
    `**1.** Open the store and add what you want to your cart.`,
    `**2.** Check out and pick a payment method. The fee for that method is added to the total there — that figure is what you send.`,
    `**3.** The pay screen shows the address (or cashtag), the exact amount, and a countdown.`,
    `**4.** Send it. Do not round the amount up or down.`,
    `**5.** When it confirms, the keys are DM'd to you and saved to your account.`,
  ];

  const notes = [];
  if (enabled.btc || enabled.ltc) {
    notes.push(`**Crypto** — a fresh address per order, confirmed on-chain`
      + `${cryptoWindow ? `, **${cryptoWindow}** to pay` : ''}.`
      + ` Send from a wallet you control; an exchange withdrawal that arrives late arrives on a dead order.`);
  }
  if (enabled.cashapp || enabled.paypal) {
    notes.push(`**Cash App / PayPal**${cashWindow ? ` — **${cashWindow}** to pay` : ''}.`
      + ` Confirmation is automatic once the payment notification arrives.`);
  }
  notes.push('**Store balance** — no fee and instant. Top up once, then every later order is one tap.');

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('❓ How to pay')
    .setDescription(steps.join('\n'))
    .addFields({ name: 'By method', value: notes.join('\n\n') })
    .addFields({
      name: 'If something goes wrong',
      value: 'Paid but nothing arrived, or the countdown ran out mid-payment? Open a ticket with your **invoice number**'
        + ' — a late payment is recorded, not lost, and staff can settle it by hand.',
    })
    .setFooter({ text: SITE_URL.replace(/^https?:\/\//, '') });

  await interaction.reply({ embeds: [embed], flags: 64 });
  return true;
}

module.exports = {
  commands, handleStorefrontCommand, handleStorefrontButton, setStorefrontGate,
  // index.js's own /setwebsite renders through these, so the older command name
  // people already know produces the same panel instead of the bare link it used
  // to post. Two commands writing two different posts into one channel is how
  // that channel ended up looking dead in the first place.
  storeConfig, upsertPanel,
  // The panel keeps itself true; index.js drives it on a timer and /config
  // methods forces a pass right after a toggle.
  refreshPaymentPanels, savePayPanelRef,
  // Exported for the tests, which render the panels without a Discord connection.
  buildWebsitePanel, buildPaymentPanel, humanMinutes, paymentRows, addressProblems,
  paymentPanelSignature, payPanelKind, PAY_PANEL_KIND,
  MARK_SITE, MARK_PAY,
};
