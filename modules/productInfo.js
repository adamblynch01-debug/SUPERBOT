// ─── /product-info ────────────────────────────────────────────────────────────
// "Dropdown menu with option to choose any product and show its product info."
//
// The catalogue is 164 products across 44 categories, and a Discord select menu
// holds 25 options in a row and five rows in a message — 125. So a single flat
// dropdown of "any product" is not a layout choice that was passed over, it is
// one that does not fit, and it would have started dropping products silently
// the first time the catalogue grew. It is two steps instead: pick the game,
// then pick the product. The widest category holds 18 (Streaming), so step two
// is always one row, and step one is two.
//
// The other thing the shape has to survive is a PUBLIC panel. If the dropdown
// is posted into a channel for customers to browse, then handling a click with
// interaction.update() rewrites the panel for everyone looking at it — one
// customer opening ARC RAIDERS would change what the next person sees mid-scroll.
// So a click on a public panel opens a PRIVATE copy of the browser, and only a
// private copy is ever updated in place. isEphemeral() below is that fork.
//
// Nothing here is a second source of truth: every field comes from the same
// /api/products the website renders from, and the stock badge from the same
// /api/stock/bulk the storefront badges its cards with. A product info card
// that disagreed with the page it links to would be worse than none.
'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits,
} = require('discord.js');
const axios = require('axios');
const { languageRow } = require('./translate');

const BACKEND_URL = (process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SITE_URL    = (process.env.SITE_URL || 'https://uhservices.xyz').replace(/\/+$/, '');

const MAX_OPTIONS = 25;   // per select menu
const MAX_ROWS    = 5;    // per message — the language row takes one of them

// Same four the website's status page and /post-status use. A fifth status
// would show as ⚪ with its own name rather than being quietly called healthy.
const STATUS = {
  undetected: { emoji: '🟢', label: 'UNDETECTED' },
  testing:    { emoji: '🧪', label: 'TESTING' },
  updating:   { emoji: '🔵', label: 'UPDATING' },
  detected:   { emoji: '🔴', label: 'DETECTED' },
};

let gate = { hasAccess: () => false };
function setProductInfoGate(g) { gate = { ...gate, ...g }; }

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, Math.max(1, n - 1)) + '…';
};

// ─── the catalogue ────────────────────────────────────────────────────────────
// Both halves of it. The storefront and the vault are two endpoints and two
// different pages on the site, but "any product" means any, and a customer
// asking about SLING TV does not know which half of our schema it lives in.
// The half is kept on the record only so the card can say where to buy it.
let cache = { at: 0, catalog: null };
const CATALOG_TTL_MS = 60 * 1000;

async function fetchCatalog(force = false) {
  if (!force && cache.catalog && Date.now() - cache.at < CATALOG_TTL_MS) return cache.catalog;

  const halves = await Promise.all([
    axios.get(`${BACKEND_URL}/api/products`, { timeout: 10000 }).then(r => [r.data, 'main']).catch(e => {
      console.warn('[ProductInfo] /api/products unreachable:', e.message); return [null, 'main'];
    }),
    axios.get(`${BACKEND_URL}/api/products/vault`, { timeout: 10000 }).then(r => [r.data, 'vault']).catch(e => {
      console.warn('[ProductInfo] /api/products/vault unreachable:', e.message); return [null, 'vault'];
    }),
  ]);

  // One half down is not both halves down. Serving the half that answered is
  // better than an error page, and the last good catalogue is better than
  // either — a browse that works on stale prices still points at the right
  // product, and the card says when it was read.
  const rows = [];
  let anyOk = false;
  for (const [data, half] of halves) {
    if (!Array.isArray(data)) continue;
    anyOk = true;
    for (const r of data) rows.push({ ...r, half });
  }
  if (!anyOk) return cache.catalog;   // may be null; the caller says so

  const catalog = groupCatalog(rows);
  cache = { at: Date.now(), catalog };
  return catalog;
}

// Each API row is a priced TIER joined onto its parent product, so a product
// with five plans arrives five times. Rolled up by product_id, which is the id
// the two halves share and the one the site's own cards are keyed on.
//
// A product with no tiers at all still arrives — one row with a null tier id —
// and is deliberately kept. #18 Services / BLUEPRINTS is exactly that today,
// and "this has no plans set up yet" is the answer someone asking about it
// needs; leaving it out of the dropdown would answer "no such product", which
// is not true and is not actionable by the staff member who can fix it.
function groupCatalog(rows) {
  const products = new Map();
  for (const r of rows || []) {
    const id = r.product_id != null ? String(r.product_id) : null;
    if (!id) continue;
    const key = `${r.half || 'main'}::${id}`;
    let p = products.get(key);
    if (!p) {
      p = {
        key, id, half: r.half || 'main',
        name: r.product_name || r.name || 'Product',
        game: r.category || '',
        subtitle: r.subtitle || '',
        description: r.description || '',
        tag: r.tag || '',
        specs: r.specs || '',
        platforms: Array.isArray(r.platforms) ? r.platforms : (r.platforms ? [r.platforms] : []),
        spoofer: !!r.spoofer,
        sections: Array.isArray(r.sections) ? r.sections : [],
        media: r.media && typeof r.media === 'object' ? r.media : {},
        status: r.status || '',
        tiers: [],
      };
      products.set(key, p);
    }
    if (r.id != null) {
      p.tiers.push({
        id: String(r.id),
        label: r.tier_label || '',
        period: r.tier_period || '',
        price: typeof r.price === 'number' ? r.price : (r.price != null ? Number(r.price) : null),
        stock_type: r.stock_type || null,
        delivery_type: r.delivery_type || null,
      });
    }
  }

  // Categories are namespaced by half. "Accounts" exists on both sides and
  // means different things there; merging them on the display name would put
  // vault products under a storefront heading and send a buyer to the wrong
  // page. The label carries the half so the two read apart in the dropdown.
  const categories = new Map();
  for (const p of products.values()) {
    const catKey = `${p.half}::${p.game || 'Other'}`;
    const c = categories.get(catKey) || { key: catKey, half: p.half, name: p.game || 'Other', products: [] };
    c.products.push(p);
    categories.set(catKey, c);
  }
  for (const c of categories.values()) c.products.sort((a, b) => a.name.localeCompare(b.name));

  return {
    products,
    categories: [...categories.values()].sort((a, b) =>
      a.half === b.half ? a.name.localeCompare(b.name) : (a.half === 'main' ? -1 : 1)),
  };
}

// ─── the two dropdowns ────────────────────────────────────────────────────────
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// One row per 25 categories, and never more rows than a message can hold with
// the language row still on it. If the catalogue ever outgrows that, the
// overflow is SAID rather than dropped — see the caller.
function categoryRows(categories, selectedKey) {
  const pages = chunk(categories, MAX_OPTIONS).slice(0, MAX_ROWS - 2);
  return pages.map((page, i) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`pinfo_cat::${i}`)
      .setPlaceholder(clip(pages.length > 1
        ? `🎮 Category  (${page[0].name} – ${page[page.length - 1].name})`
        : '🎮 Pick a category', 150))
      .addOptions(page.map(c => ({
        label: clip(c.name, 100),
        value: clip(c.key, 100),
        description: clip(`${c.half === 'vault' ? 'Vault' : 'Store'} · ${c.products.length} product${c.products.length === 1 ? '' : 's'}`, 100),
        emoji: c.half === 'vault' ? '🔐' : '🛒',
        default: c.key === selectedKey,
      })))
  ));
}

function productRow(category, selectedKey) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('pinfo_prod')
      .setPlaceholder(clip(`📦 Pick a product in ${category.name}`, 150))
      .addOptions(category.products.slice(0, MAX_OPTIONS).map(p => ({
        label: clip(p.name, 100),
        value: clip(p.key, 100),
        // The cheapest plan, because that is the number someone browsing is
        // deciding on. "from" and not a bare price: a product whose Day plan
        // is $7.99 does not cost $7.99.
        description: clip(priceHint(p) || p.subtitle || p.game, 100),
        default: p.key === selectedKey,
      })))
  );
}

function priceHint(p) {
  const prices = p.tiers.map(t => t.price).filter(n => typeof n === 'number' && !Number.isNaN(n));
  if (!prices.length) return p.tiers.length ? '' : 'No plans yet';
  const lo = Math.min(...prices);
  return prices.length > 1 ? `from $${lo.toFixed(2)} · ${prices.length} plans` : `$${lo.toFixed(2)}`;
}

// ─── the card ─────────────────────────────────────────────────────────────────
async function tierStock(tiers) {
  const ids = tiers.map(t => t.id).filter(id => /^\d+$/.test(id));
  if (!ids.length) return {};
  try {
    const { data } = await axios.get(`${BACKEND_URL}/api/stock/bulk?ids=${ids.join(',')}`, { timeout: 8000 });
    return (data && data.stock) || {};
  } catch (e) {
    // Not the same as "sold out". A stock lookup that failed must not print a
    // red SOLD OUT badge next to a product we are still selling — the badge is
    // simply left off, and the price still shows.
    console.warn('[ProductInfo] stock lookup failed:', e.message);
    return null;
  }
}

function tierLines(product, stock) {
  const lines = [];
  for (const t of product.tiers) {
    const price = typeof t.price === 'number' && !Number.isNaN(t.price) ? `**$${t.price.toFixed(2)}**` : '**—**';
    const name = [t.label, t.period && t.period !== t.label ? `(${t.period})` : ''].filter(Boolean).join(' ') || 'Standard';
    let badge = '';
    if (stock) {
      const n = stock[t.id];
      const have = typeof n === 'number' ? n : 0;
      badge = have > 0 ? (have <= 5 ? ` · 🟢 ${have} left` : ' · 🟢 In stock') : ' · 🔴 Sold out';
    }
    lines.push(`${price} — ${name}${badge}`);
  }
  return lines;
}

// Discord's field value cap is 1024 and the whole embed's is 6000. Both are
// rejections, not truncations: over either one and the message does not send
// at all. So the card is built to a budget and says what it left out, in the
// same spirit as the delivery DM — a card that quietly showed three of a
// product's seven sections would look complete.
function packLines(lines, max = 1024, moreLabel = 'more') {
  const kept = [];
  let len = 0;
  for (const line of lines) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (len + add > max - 40) break;
    kept.push(line); len += add;
  }
  if (!kept.length && lines.length) kept.push(clip(lines[0], max - 40));
  const omitted = lines.length - kept.length;
  if (omitted) kept.push(`_…and ${omitted} ${moreLabel} — see the site_`);
  return kept.join('\n');
}

function buildProductEmbed(product, stock, { readAt = null } = {}) {
  const st = STATUS[product.status] || (product.status ? { emoji: '⚪', label: String(product.status).toUpperCase() } : null);

  const embed = new EmbedBuilder()
    .setColor(product.half === 'vault' ? 0x00ffe7 : 0x5865F2)
    .setTitle(clip(`${product.half === 'vault' ? '🔐' : '📦'} ${product.name}`, 256));

  // The subtitle is the one line the site puts under the name, and the
  // description on most rows is "<Game> — <Plan>", which the fields below
  // already say twice. Printed only when it adds something.
  const desc = [];
  if (product.subtitle) desc.push(`**${clip(product.subtitle, 300)}**`);
  const dedupe = new RegExp(`^${String(product.game || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—–-]`, 'i');
  if (product.description && !dedupe.test(product.description.trim())) desc.push(clip(product.description, 600));
  if (desc.length) embed.setDescription(desc.join('\n'));

  if (product.game) embed.addFields({ name: '🎮 Game', value: clip(product.game, 1024), inline: true });
  if (st) embed.addFields({ name: '📡 Status', value: `${st.emoji} ${st.label}`, inline: true });
  if (product.tag) embed.addFields({ name: '🏷️ Type', value: clip(product.tag, 1024), inline: true });

  // Pricing, and the reason a product can be looked at but not bought. A card
  // that showed a name, a status and nothing about price would be read as
  // "coming soon" for something that is simply misconfigured.
  const lines = tierLines(product, stock);
  embed.addFields({
    name: lines.length > 1 ? `💵 Plans (${lines.length})` : '💵 Price',
    value: lines.length
      ? packLines(lines, 1024, 'plans')
      : '⚠️ No plans are set up for this product yet, so it cannot be bought. Staff can add one in the panel.',
  });

  if (product.platforms && product.platforms.length) {
    embed.addFields({ name: '🕹️ Works with', value: clip(product.platforms.join(' · '), 1024), inline: false });
  }
  if (product.specs) {
    embed.addFields({ name: '🖥️ Requirements', value: clip(String(product.specs).replace(/\s*\|\s*/g, '\n• ').replace(/^/, '• '), 1024), inline: false });
  }

  // The feature sections, to a whole-embed budget rather than a field count —
  // 25 fields is the cap that gets talked about and 6000 characters is the one
  // that actually rejects this embed.
  let budget = 4200 - (embed.data.description || '').length;
  for (const s of product.sections) {
    if (embed.data.fields && embed.data.fields.length >= 23) break;
    const feats = (Array.isArray(s.features) ? s.features : []).map(f => `• ${f}`);
    if (!feats.length) continue;
    const value = packLines(feats, 1024, 'more');
    const cost = String(s.title || 'Features').length + value.length;
    if (cost > budget) break;
    budget -= cost;
    embed.addFields({ name: clip(`✅ ${s.title || 'Features'}`, 256), value, inline: false });
  }

  // A link is not a field — the media keys are all video hosts and belong
  // where they can be clicked, not read.
  const media = product.media || {};
  const clipUrl = media.video || media.youtube || media.vimeo || media.gif || null;
  if (clipUrl) embed.addFields({ name: '🎬 Preview', value: `[Watch the clip](${clipUrl})`, inline: false });
  if (media.screenshot && /^https?:\/\//i.test(String(media.screenshot))) embed.setImage(String(media.screenshot));

  embed.setFooter({
    text: `${SITE_URL.replace(/^https?:\/\//, '')} • prices in USD${readAt ? ` • read ${readAt}` : ''}`,
  }).setTimestamp();

  return embed;
}

// ─── the flow ─────────────────────────────────────────────────────────────────
// True only for the private copy. A click on a public panel must not edit it.
function isEphemeral(message) {
  const f = message && message.flags;
  if (!f) return false;
  if (typeof f.has === 'function') { try { return f.has(1 << 6); } catch (_) { return false; } }
  return (Number(f) & (1 << 6)) === (1 << 6);
}

function browserPayload(catalog, { category = null, product = null, embed = null } = {}) {
  const rows = categoryRows(catalog.categories, category ? category.key : null);
  if (category) rows.push(productRow(category, product ? product.key : null));

  const components = [...rows];
  if (product) {
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛒 Buy on the site')
        .setURL(product.half === 'vault' ? `${SITE_URL}/#vault` : `${SITE_URL}/#products`)
    );
    if (components.length < MAX_ROWS) components.push(buttons);
  }
  if (components.length < MAX_ROWS) components.push(languageRow());

  const content = product ? null
    : category ? `### 📦 ${category.name}\nPick a product to see its info.`
      : '### 📦 Product info\nPick a category, then a product.';

  return {
    ...(content ? { content } : { content: '' }),
    embeds: embed ? [embed] : [],
    components,
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName('product-info')
    .setDescription('Look up any product — price, plans, stock, status and features')
    .addChannelOption(o => o.setName('channel')
      .setDescription('Staff only: post a permanent browse panel into this channel instead')
      .setRequired(false)),
];

async function handleProductInfoCommand(interaction) {
  if (interaction.commandName !== 'product-info') return false;

  const target = interaction.options.getChannel('channel');
  // Posting a panel the whole server reads is a staff action; looking a
  // product up is not, and gating both behind hasAccess() would have made the
  // command useless to the people it is for.
  if (target && !gate.hasAccess(interaction)) {
    await interaction.reply({ content: '❌ Only staff can post the browse panel. Run `/product-info` with no channel to look a product up.', flags: 64 });
    return true;
  }

  await interaction.deferReply({ flags: 64 });
  const catalog = await fetchCatalog();
  if (!catalog || !catalog.categories.length) {
    await interaction.editReply({ content: '❌ The catalogue is not reachable right now, so there is nothing to browse. Try again in a minute.' });
    return true;
  }

  // The overflow the two-step layout was built to avoid, said out loud if it
  // ever happens anyway. 44 categories today, 50 fit.
  const shown = Math.min(catalog.categories.length, (MAX_ROWS - 2) * MAX_OPTIONS);
  const missing = catalog.categories.length - shown;

  if (target) {
    const panel = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📦  PRODUCT INFO')
      .setDescription('Pick a category below, then a product, and its **price, plans, stock, status and features** appear — privately, so nobody else sees what you are looking at.')
      .setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • live from the store catalogue` });
    await target.send({ embeds: [panel], components: browserPayload(catalog).components });
    await interaction.editReply({
      content: `✅ Browse panel posted in ${target} — ${catalog.products.size} products across ${shown} categories.`
        + (missing ? `\n⚠️ ${missing} categories did not fit in the panel's dropdowns.` : ''),
    });
    return true;
  }

  await interaction.editReply(browserPayload(catalog));
  return true;
}

async function handleProductInfoSelect(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('pinfo_cat') && id !== 'pinfo_prod') return false;

  const catalog = await fetchCatalog();
  if (!catalog) {
    await interaction.reply({ content: '❌ The catalogue is not reachable right now. Try again in a minute.', flags: 64 });
    return true;
  }

  const value = (interaction.values && interaction.values[0]) || '';

  if (id.startsWith('pinfo_cat')) {
    const category = catalog.categories.find(c => c.key === value);
    if (!category) {
      // The panel in the channel can be older than the catalogue behind it.
      await interaction.reply({ content: '❌ That category is not in the catalogue any more — pick another.', flags: 64 });
      return true;
    }
    const payload = browserPayload(catalog, { category });
    if (isEphemeral(interaction.message)) await interaction.update(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return true;
  }

  const product = catalog.products.get(value);
  if (!product) {
    await interaction.reply({ content: '❌ That product is not in the catalogue any more — pick another.', flags: 64 });
    return true;
  }
  const category = catalog.categories.find(c => c.key === `${product.half}::${product.game || 'Other'}`);

  // Deferred before the stock call: /api/stock/bulk is a second network hop,
  // and three seconds is the whole budget for answering a component click.
  const ephemeral = isEphemeral(interaction.message);
  if (ephemeral) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: 64 });

  const stock = await tierStock(product.tiers);
  const embed = buildProductEmbed(product, stock);
  // Same call either way — deferUpdate() edits the private browser in place,
  // deferReply() edits the private copy that a public panel just opened.
  await interaction.editReply(browserPayload(catalog, { category, product, embed }));
  return true;
}

module.exports = {
  commands, handleProductInfoCommand, handleProductInfoSelect, setProductInfoGate,
  // Exported for the tests, which build the whole flow with no Discord connection.
  groupCatalog, buildProductEmbed, browserPayload, categoryRows, productRow,
  tierLines, packLines, priceHint, isEphemeral, fetchCatalog, STATUS,
};
