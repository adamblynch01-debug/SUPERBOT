// ─── MANUAL ORDER DELIVERY ────────────────────────────────────────────────────
// Two things staff have always had to do by hand, and until now did completely
// outside the system:
//
//   1. HAND OVER A PRODUCT. A key sold in a ticket, an off-platform payment, a
//      replacement for a burned account. Staff DM'd the value and that was the
//      end of it — `/order lookup` could not find it, `/claim-customer` had no
//      invoice to verify against (so a buyer who had genuinely paid could not
//      get the customer role), #order-log showed a quiet day, and if the buyer
//      lost the DM there was no second copy anywhere.
//
//   2. APPROVE A WEBSITE ORDER THAT DID NOT SETTLE ITSELF. The email watcher
//      missed the payment, the crypto rate was unavailable, the customer sent
//      from a different address. `/order forceconfirm` has always been able to
//      settle one, but it needs an order id — and there was no way to SEE the
//      waiting orders. Staff had to ask the customer for a number the customer
//      often could not find either.
//
// Both now produce a real `orders` row, so everything downstream — lookup,
// claim, the site's ORDERS list, the receipt email, the order log — reads a
// hand-delivered order exactly the way it reads a checkout. The only difference
// is `orders.source`, which is what makes the embed say SOURCE: 🖐️ MANUAL
// instead of 🌐 WEBSITE.
//
// No server-side session state. Everything needed between the command, the
// duration picker and the modal rides in the component customId (100-char
// budget: two numeric ids and a snowflake fit with room to spare), so a deploy
// landing mid-flow does not strand a half-finished delivery.
'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const axios = require('axios');
const { query } = require('../db');
const { languageRow } = require('./translate');
// One renderer for the buyer's DM, shared with the website delivery path.
const { buildDeliveryEmbed } = require('./deliveryEmbed');

const BACKEND_URL = process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:3000';
const API_SECRET  = process.env.API_SECRET;
const GUILD_ID    = process.env.GUILD_ID;

// The channel the operator created for this. Env first so it can be moved
// without a deploy, id second so the feature works if the variable is never set.
const MANUAL_CHANNEL_FALLBACK = '1533927608360636629';

// Injected from index.js rather than redefined here — a second definition of
// "who is staff" is how a gate ends up open on one command and shut on another.
let gate = { hasAccess: () => false };
function setManualAccessGate(g) { gate = { ...gate, ...g }; }

const commands = [
  new SlashCommandBuilder()
    .setName('manual-order-delivery')
    .setDescription('Staff: hand-deliver an order, or approve a website order that never settled')
    .addSubcommand(s => s
      .setName('send')
      .setDescription('Deliver a product to a member by hand and record a real order')
      .addStringOption(o => o
        .setName('product').setDescription('Product — type a game or product name to search')
        .setRequired(true).setAutocomplete(true))
      .addUserOption(o => o
        .setName('user').setDescription('Who receives it').setRequired(true)))
    .addSubcommand(s => s
      .setName('pending')
      .setDescription('List website orders still awaiting payment, and approve one')),
];

// ─── helpers ──────────────────────────────────────────────────────────────────

function money(cents) { return `$${((Number(cents) || 0) / 100).toFixed(2)}`; }

// The panel's per-guild manual delivery channel, installed by index.js. The env
// var and the fallback below are one id for the whole bot, and
// client.channels.fetch resolves a channel in ANY guild the bot is in — so a
// hand-delivered order on the second server was logged into the first server's
// channel, complete with the buyer's email.
let settingsFor = async () => null;
function setManualSettingsProvider(fn) { if (typeof fn === 'function') settingsFor = fn; }

async function manualChannel(client, guildId) {
  let id = null;
  if (guildId) {
    try {
      const s = await settingsFor(guildId);
      id = (s && s.manualDeliveryChannelId) || null;
    } catch (e) {
      console.error('[ManualDelivery] could not read guild settings:', e.message);
    }
  }
  id = id || process.env.MANUAL_DELIVERY_CHANNEL_ID || MANUAL_CHANNEL_FALLBACK;
  try {
    const ch = await client.channels.fetch(String(id));
    return ch && typeof ch.send === 'function' ? ch : null;
  } catch (e) {
    console.error(`[ManualDelivery] channel ${id} unreachable: ${e.message} — set it in the panel for this server, or MANUAL_DELIVERY_CHANNEL_ID`);
    return null;
  }
}

// ─── autocomplete ─────────────────────────────────────────────────────────────
// Matched against "GAME — PRODUCT" rather than the product name alone: half
// this catalog is named things like "Ancient", "FULL" or "PREDATOR", which
// nobody can search by. The game is how staff actually think of it.
async function autocompleteProducts(interaction) {
  const focused = String(interaction.options.getFocused() || '').trim().toLowerCase();
  const like = `%${focused.replace(/[%_]/g, '')}%`;
  try {
    const { rows } = await query(
      `SELECT p.id, p.name, p.game_name, p.vault,
              (SELECT count(*) FROM product_tiers t WHERE t.product_id = p.id) AS tiers
         FROM products p
        WHERE p.guild_id = $1
          AND ($2 = '%%' OR lower(p.name) LIKE $2 OR lower(p.game_name) LIKE $2)
          AND EXISTS (SELECT 1 FROM product_tiers t WHERE t.product_id = p.id)
        ORDER BY p.game_name, p.name
        LIMIT 25`,
      [GUILD_ID, like]
    );
    return await interaction.respond(rows.map(r => ({
      name: `${r.vault ? '🔒 ' : ''}${r.game_name} — ${r.name}`.slice(0, 100),
      value: String(r.id),
    })));
  } catch (err) {
    // A 3-second deadline and a dead autocomplete are the same to the user, but
    // an unhandled rejection here used to take the process with it.
    console.error('[ManualDelivery] autocomplete failed:', err.message);
    try { await interaction.respond([]); } catch { /* interaction already expired */ }
  }
}

// ─── step 1: /manual-order-delivery send ──────────────────────────────────────
// Product in hand, ask which term. A product has at most a handful of tiers, so
// the 25-option select cap is never the binding constraint here — unlike the
// product list, which is why THAT one is an autocomplete.
async function startSend(interaction) {
  const productId = interaction.options.getString('product');
  const user = interaction.options.getUser('user');

  if (!/^\d+$/.test(String(productId))) {
    return interaction.reply({
      content: '❌ Pick a product from the suggestion list — typing a name freehand does not identify one.',
      flags: 64,
    });
  }

  const { rows } = await query(
    `SELECT t.id, t.label, t.price_cents, t.period, t.sort_order,
            p.name AS product_name, p.game_name,
            (SELECT count(*) FROM product_stock ps WHERE ps.tier_id = t.id AND ps.used = false) AS free
       FROM product_tiers t JOIN products p ON p.id = t.product_id
      WHERE t.product_id = $1 AND t.guild_id = $2
      ORDER BY t.sort_order NULLS LAST, t.price_cents`,
    [String(productId), GUILD_ID]
  );
  if (!rows.length) {
    return interaction.reply({ content: '❌ That product has no durations configured.', flags: 64 });
  }

  const head = rows[0];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`mdlv_tier::${productId}::${user.id}`)
    .setPlaceholder('Which duration / tier?')
    .addOptions(rows.slice(0, 25).map(t => ({
      label: `${t.label || 'Standard'} — ${money(t.price_cents)}`.slice(0, 100),
      // Free stock is shown because the next screen offers to pull from it, and
      // "pull from stock" against an empty tier is a dead end staff should see
      // coming rather than discover in an error.
      description: `${t.free} in stock`.slice(0, 100),
      value: String(t.id),
    })));

  return interaction.reply({
    content: `**${head.game_name} — ${head.product_name}** → for <@${user.id}>\nPick the duration, then fill in what you are handing over.`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: 64,
  });
}

// ─── step 2: duration chosen → the modal ──────────────────────────────────────
// Everything free-text lives here rather than as command options, so none of it
// has to survive in a customId: a 5-field modal is exactly the Discord maximum
// and exactly what this needs.
async function openKeyModal(interaction) {
  const [, productId, buyerId] = interaction.customId.split('::');
  const tierId = interaction.values[0];

  const { rows } = await query(
    `SELECT t.label, t.price_cents, p.name AS product_name, p.game_name
       FROM product_tiers t JOIN products p ON p.id = t.product_id
      WHERE t.id = $1 AND t.guild_id = $2`,
    [String(tierId), GUILD_ID]
  );
  const t = rows[0];
  if (!t) return interaction.reply({ content: '❌ That tier no longer exists.', flags: 64 });

  const modal = new ModalBuilder()
    .setCustomId(`mdlv_keys::${tierId}::${buyerId}`)
    .setTitle(`${t.game_name} — ${t.label || 'Standard'}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('keys')
        .setLabel('Key / account — one per line')
        .setPlaceholder('Leave BLANK to pull from stock instead')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(3000)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('qty')
        .setLabel('How many to pull from stock (if blank above)')
        .setPlaceholder('1')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(2)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('email')
        .setLabel('Buyer email (for /claim-customer + receipt)')
        .setPlaceholder('blank = use their linked website account')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('price')
        .setLabel('Price paid, USD')
        .setPlaceholder(`blank = list price (${money(t.price_cents)}) · 0 = free / replacement`)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(10)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('note')
        .setLabel('Staff note — why was this manual?')
        .setPlaceholder('paid in ticket via CashApp / replacement for burned key')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(300)),
  );

  return interaction.showModal(modal);
}

// ─── step 3: modal submitted → create + deliver ───────────────────────────────
async function submitKeys(interaction, client) {
  const [, tierId, buyerId] = interaction.customId.split('::');
  await interaction.deferReply({ flags: 64 });

  if (!API_SECRET) {
    return interaction.editReply('❌ This bot has no `API_SECRET`, so it cannot write an order to the backend. Nothing was delivered.');
  }

  const raw   = interaction.fields.getTextInputValue('keys') || '';
  const keys  = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const qtyIn = parseInt(String(interaction.fields.getTextInputValue('qty') || '').trim(), 10);
  const email = String(interaction.fields.getTextInputValue('email') || '').trim();
  const priceIn = String(interaction.fields.getTextInputValue('price') || '').trim();
  const note  = String(interaction.fields.getTextInputValue('note') || '').trim();

  const fromStock = keys.length === 0;
  const qty = fromStock ? Math.max(1, Math.min(25, Number.isFinite(qtyIn) ? qtyIn : 1)) : keys.length;

  // Blank means "list price" and must stay distinguishable from 0, which means
  // free. `Number('')` is 0, so an empty box would silently comp the order.
  let unitCents;
  if (priceIn !== '') {
    const n = Number(priceIn.replace(/[$,]/g, ''));
    if (!Number.isFinite(n) || n < 0) {
      return interaction.editReply(`❌ \`${priceIn}\` is not a price. Nothing was delivered — run the command again.`);
    }
    unitCents = Math.round(n * 100);
  }

  let data;
  try {
    const res = await axios.post(`${BACKEND_URL}/api/orders/manual`, {
      secret: API_SECRET,
      tier_id: tierId,
      qty,
      keys: fromStock ? [] : keys,
      from_stock: fromStock,
      discord_id: buyerId,
      email: email || undefined,
      unit_cents: unitCents,
      staff_id: interaction.user.id,
      note: note || undefined,
      // The bot owns the hand-off from here: it needs to know whether the DM
      // actually landed before it tells staff the delivery is done, and the
      // backend's fire-and-forget notify cannot answer that.
      notify: false,
    }, { timeout: 20000 });
    data = res.data;
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error) || err.message;
    console.error('[ManualDelivery] backend refused:', msg);
    // Deliberately explicit about the outcome. "Something went wrong" leaves
    // staff unsure whether stock was consumed and whether to try again.
    return interaction.editReply(`❌ **Nothing was delivered.** The backend refused: ${msg}`);
  }

  const values = data.values || [];
  // The buyer's DM is the one a website order produces — not by both files
  // agreeing to build the same thing, which is how the two drifted, but because
  // deliveryEmbed.js builds it and internalEvents.js calls the same function.
  const { embed: dm, lines: summaryLines, delivered } = buildDeliveryEmbed({
    items: [{ game: data.game_name, product: data.product_name, tier: data.tier_label, qty, values }],
    invoiceNo: data.invoice_no,
    orderId: data.order_id,
    email: data.email,
  });
  // Staff-facing strings still need a one-liner for the log below. It already
  // carries its own bold and its own ×qty, so neither is added again.
  const title = summaryLines[0] || `**${String(data.product_name || 'Item')}**`;

  let dmOk = false, dmErr = null;
  // The backend answered, but with nothing in hand. "Your Order is Ready!" over
  // an empty box is worse than no DM: it tells the buyer to go looking for a key
  // that was never issued. Staff see it below and hand it over themselves.
  if (!delivered) dmErr = 'the backend returned no values to deliver';
  else try {
    const buyer = await client.users.fetch(String(buyerId));
    // English, always — the same rule as the website delivery, for the same
    // reasons, written out in full at the top of modules/internalEvents.js.
    // Short version: a stored preference from another server was arriving on
    // receipts nobody had asked to have translated, and pre-translating made
    // the dropdown's own "English" option a no-op, because translate.js takes
    // its source to be English and returns it unchanged when English is asked
    // for. The dropdown below is how the buyer reads it in their language.
    //
    // A hand-delivered order is scoped to the guild the command ran in, not to
    // the module-level GUILD_ID, which is the store server and is simply the
    // wrong key on the second server.
    const langScope = (interaction && interaction.guildId) || GUILD_ID || 'dm';
    await buyer.send({ embeds: [dm], components: [languageRow(null, langScope)] });
    dmOk = true;
  } catch (err) {
    dmErr = err.code === 50007 ? 'their DMs are closed' : err.message;
    console.error(`[ManualDelivery] DM to ${buyerId} failed:`, err.message);
  }

  // Staff copy. Product, price, who and why — never the values themselves. This
  // channel is readable by every staff member and the delivered value is a live
  // credential; `/order lookup` exists for the cases where one must be
  // recovered.
  const logEmbed = new EmbedBuilder()
    .setColor(dmOk ? 0xfaa61a : 0xED4245)
    .setTitle('🖐️ Manual Order Delivered')
    .setDescription(title)
    .addFields(
      { name: 'Invoice',  value: `\`${data.invoice_no}\``, inline: true },
      { name: 'Order ID', value: `${data.order_id}`, inline: true },
      { name: 'Source',   value: '🖐️ Manual (staff)', inline: true },
      { name: 'Buyer',    value: `<@${buyerId}> \`${buyerId}\``, inline: true },
      { name: 'Email',    value: data.email || '— none (claimable by Discord)', inline: true },
      { name: 'Charged',  value: money(data.total_cents), inline: true },
      { name: 'Keys from', value: data.claimed_from_stock ? '📦 Stock (consumed)' : '⌨️ Typed by staff', inline: true },
      { name: 'Delivered by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Buyer DM', value: dmOk ? '✅ sent' : `⚠️ FAILED — ${dmErr}`, inline: true },
    )
    .setTimestamp();
  if (note) logEmbed.addFields({ name: 'Reason', value: note.slice(0, 1024), inline: false });

  const ch = await manualChannel(client, interaction.guild && interaction.guild.id);
  if (ch) await ch.send({ embeds: [logEmbed] }).catch(e => console.error('[ManualDelivery] log post failed:', e.message));

  const lines = [
    `✅ Order \`${data.invoice_no}\` created for <@${buyerId}> — ${title}`,
    dmOk ? '📬 The buyer has been DM\'d.'
         : `⚠️ **The DM did not send** (${dmErr}). The order is recorded — hand the value over yourself:\n\`\`\`${values.join('\n').slice(0, 800)}\`\`\``,
    data.claimed_from_stock ? `📦 ${qty} key(s) taken from stock.` : '⌨️ Values were typed, no stock consumed.',
  ];
  // No longer a dead end — the claim falls back to the Discord account this was
  // delivered to — but still worth saying, because it changes what the buyer has
  // to do and there is no receipt going out to anybody.
  if (!data.email) lines.push('ℹ️ No email on this order. The buyer claims it with `/claim-customer` leaving the email blank — it verifies against their Discord account and creates their site account if they have none. No receipt was emailed.');
  if (!ch) lines.push(`⚠️ Could not post to the manual delivery channel — set \`MANUAL_DELIVERY_CHANNEL_ID\`.`);

  return interaction.editReply(lines.join('\n'));
}

// ─── /manual-order-delivery pending ───────────────────────────────────────────
async function listPending(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!API_SECRET) return interaction.editReply('❌ This bot has no `API_SECRET`, so it cannot reach the order backend.');

  let orders;
  try {
    const res = await axios.get(`${BACKEND_URL}/api/orders/pending`, {
      params: { secret: API_SECRET, limit: 25 }, timeout: 15000,
    });
    orders = (res.data && res.data.orders) || [];
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error) || err.message;
    return interaction.editReply(`❌ Could not read the pending orders: ${msg}`);
  }

  if (!orders.length) return interaction.editReply('✅ Nothing is waiting on payment. Every order is settled.');

  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle(`⏳ ${orders.length} order(s) awaiting payment`)
    .setDescription(orders.map(o =>
      `\`${o.invoice_no || `#${o.order_id}`}\` · **${o.total.toFixed(2)}** ${String(o.payment_method || '').toUpperCase()}` +
      `\n└ ${o.summary} — ${o.discord_id ? `<@${o.discord_id}>` : (o.email || 'no contact')}` +
      (o.payment_note ? `  ·  note \`${o.payment_note}\`` : '')
    ).join('\n').slice(0, 4000))
    .setFooter({ text: 'Approving marks the order PAID and runs the normal delivery — keys are claimed and the buyer is DM\'d.' })
    .setTimestamp();

  const menu = new StringSelectMenuBuilder()
    .setCustomId('mdlv_approve')
    .setPlaceholder('Approve one — only if you have confirmed the money arrived')
    .addOptions(orders.slice(0, 25).map(o => ({
      label: `${o.invoice_no || `#${o.order_id}`} — $${o.total.toFixed(2)}`.slice(0, 100),
      description: o.summary.slice(0, 100),
      value: String(o.order_id),
    })));

  return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
}

async function approvePending(interaction) {
  await interaction.deferReply({ flags: 64 });
  const orderId = interaction.values[0];
  try {
    const res = await axios.post(`${BACKEND_URL}/api/orders/confirm`, {
      secret: API_SECRET, order_id: orderId, amount_received: 0, method: 'manual',
    }, { timeout: 30000 });
    const d = res.data || {};
    if (d.success) {
      console.log(`[ManualDelivery] order ${orderId} approved by ${interaction.user.tag} (${interaction.user.id})`);
      return interaction.editReply(
        `✅ Order **${orderId}** confirmed and delivery triggered by <@${interaction.user.id}>.\n` +
        'The buyer gets the same DM as any website order, and it is logged in the order channel.'
      );
    }
    // /confirm answers 200 with a message when the order was already settled or
    // is in a status it refuses to settle from. That is not a success.
    return interaction.editReply(`⚠️ Not confirmed: ${d.message || 'the backend did not say why'}`);
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error) || err.message;
    return interaction.editReply(`❌ Could not confirm order ${orderId}: ${msg}`);
  }
}

// ─── dispatch ─────────────────────────────────────────────────────────────────
// Returns true when it owned the interaction, so index.js can stop.
async function handleManualInteraction(interaction, client) {
  const id = interaction.customId || '';
  const isOurs = interaction.commandName === 'manual-order-delivery' || id.startsWith('mdlv_');
  if (!isOurs) return false;

  if (interaction.isAutocomplete()) { await autocompleteProducts(interaction); return true; }

  // One gate for every entry point, checked before anything reads the DB. The
  // slash command is already hidden from non-admins by default_member_permissions,
  // but a select menu customId is guessable and components do not inherit the
  // command's permissions.
  if (!gate.hasAccess(interaction)) {
    const reply = { content: '❌ Staff only.', flags: 64 };
    if (interaction.isModalSubmit() || interaction.isStringSelectMenu() || interaction.isChatInputCommand()) {
      await interaction.reply(reply).catch(() => {});
    }
    return true;
  }

  try {
    if (interaction.isChatInputCommand()) {
      const sub = interaction.options.getSubcommand();
      if (sub === 'send')    { await startSend(interaction); return true; }
      if (sub === 'pending') { await listPending(interaction); return true; }
      return true;
    }
    if (interaction.isStringSelectMenu()) {
      if (id.startsWith('mdlv_tier::')) { await openKeyModal(interaction); return true; }
      if (id === 'mdlv_approve')        { await approvePending(interaction); return true; }
    }
    if (interaction.isModalSubmit() && id.startsWith('mdlv_keys::')) {
      await submitKeys(interaction, client);
      return true;
    }
  } catch (err) {
    console.error('[ManualDelivery] handler error:', err && err.stack ? err.stack : err);
    const msg = { content: `❌ ${err.message}`, flags: 64 };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg.content).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
    return true;
  }
  return true;
}

module.exports = {
  commands, handleManualInteraction, setManualAccessGate, MANUAL_CHANNEL_FALLBACK,
  setManualSettingsProvider,
};
