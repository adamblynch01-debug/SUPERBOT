// ─── THE DELIVERY DM ──────────────────────────────────────────────────────────
// The one message a buyer actually keeps. It was built twice — once in
// manualDelivery.js for a hand-delivered order, once in internalEvents.js for a
// website one — and both files carried a comment promising the other that they
// were "byte-for-byte" the same. They were not, and could not stay so: the
// website one never showed the claim instructions, and the two drifted every
// time one was touched. So it is built once, here, and both call this.
//
// What was wrong with the old layout, from the buyer's side:
//
//   📦 Call of Duty: Warzone — H8ED Private External — Month
//
// Three different facts welded into one field name with em-dashes, long enough
// to wrap onto two lines on a phone, and reading like a sentence that has lost
// its verb. And the invoice was printed twice — once as a field, once again in
// the footer — which is the kind of thing that makes a receipt look automated
// rather than finished.
//
// Now each fact gets its own labelled field. Discord lays three inline fields
// out as one tidy row, so the common case (one product) renders as a header
// strip — GAME / PRODUCT / PLAN — with the keys beneath it and the invoice last.
// Nothing wraps, nothing repeats, and there is not a dash in it.
'use strict';

const { EmbedBuilder } = require('discord.js');

const LIMIT = { name: 256, value: 1024, desc: 4096, fields: 25 };
const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
};

// The key block is NOT clipped with the above, and the difference matters more
// than it looks. A 300-key order is ~6000 characters; clip() would cut it at
// 1016 and end on half a key, so the buyer receives a broken credential and no
// indication that 280 more ever existed. Discord rejects the whole message if
// the field is over cap, so "just send it all" delivers nothing at all.
//
// Whole lines only, then, and a count of what did not fit — a delivery that
// silently drops most of an order is the one failure in this file nobody would
// report as a bug, because it looks exactly like a successful delivery.
function clipKeys(values, max) {
  const kept = [];
  let len = 0;
  for (const v of values) {
    const add = (kept.length ? 1 : 0) + String(v).length;   // +1 for the newline
    if (len + add > max) break;
    kept.push(String(v));
    len += add;
  }
  // Nothing fits at all (one absurdly long value). Send the head of it rather
  // than an empty code block, still marked.
  if (!kept.length && values.length) kept.push(clip(values[0], Math.max(1, max)));
  return { text: kept.join('\n'), omitted: values.length - kept.length };
}

// Said outside the code fence, in words, with the number. "…" inside the block
// would read as part of a key.
const omittedNote = (n) =>
  `\n⚠️ **${n} more ${n === 1 ? 'key is' : 'keys are'} not shown here** — Discord caps how much fits in one message.`
  + ' All of them are on your uhservices.xyz account under **Orders**, and staff can re-send them from your invoice.';

// Discord's own green. 0x00ff00 is the green of a terminal, not of a receipt.
const COLOR = 0x57F287;

// A game whose name is already inside the product name would only repeat itself:
// an HWID spoofer's game is "HWID Spoofer", and showing both reads like a bug.
// Balance top-ups and donations have no game at all, by design.
function gameWorthShowing(game, product) {
  const g = String(game || '').trim();
  if (!g) return '';
  const re = new RegExp(`(^|\\s)${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
  return re.test(String(product || '')) ? '' : g;
}

// Used only where several products share one embed and each needs its context on
// one line. A bullet, not a dash — it separates without pretending to be
// punctuation in a sentence.
function contextLine(game, tier, qty) {
  const bits = [];
  if (game) bits.push(`**${game}**`);
  if (tier) bits.push(tier);
  if (Number(qty) > 1) bits.push(`×${Number(qty)}`);
  return bits.join(' • ');
}

/**
 * items: [{ game, product, tier, qty, values: [string] }]
 *   `values` is what the buyer receives — keys, accounts, credentials. Already
 *   filtered by the caller: a failure marker is not a delivery.
 *
 * Returns { embed, protect, lines } where
 *   protect — every catalogue string that ended up in the embed, collected as it
 *             was written rather than derived after. translate.js masks these so
 *             a Spanish-speaking buyer is not told they bought a product this
 *             shop does not sell.
 *   lines   — the same items rendered one-per-line, for the staff log.
 */
function buildDeliveryEmbed({ items = [], invoiceNo = null, orderId = null, email = null }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('✅ Your Order is Ready!')
    .setDescription('Thank you for your purchase — everything below is yours to keep.')
    .setTimestamp();

  const protect = [];
  const lines = [];
  const shown = [];

  for (const it of items) {
    const product = String(it.product || 'Item').trim();
    const values = (it.values || []).filter(Boolean);
    if (!values.length) continue;
    const game = gameWorthShowing(it.game, product);
    const tier = it.tier ? String(it.tier).trim() : '';
    const qty = Number(it.qty) > 1 ? Number(it.qty) : 1;
    shown.push({ product, values, game, tier, qty });
    protect.push(product, it.game, it.tier);
    // The staff log's one-liner. Same facts, same separator, so the two copies
    // of an order read alike when someone has both on screen.
    lines.push([`**${product}**`, game, tier, qty > 1 ? `×${qty}` : ''].filter(Boolean).join(' • '));
  }
  if (invoiceNo) protect.push(invoiceNo);

  if (shown.length === 1) {
    // The common case, and the one the screenshot was of. Three inline fields
    // become a single row: what game, what product, which term.
    const [it] = shown;
    if (it.game) embed.addFields({ name: '🎮 Game', value: clip(it.game, LIMIT.value), inline: true });
    embed.addFields({ name: '📦 Product', value: clip(it.product, LIMIT.value), inline: true });
    if (it.tier || it.qty > 1) {
      embed.addFields({
        name: '⏳ Plan',
        value: clip(it.tier ? (it.qty > 1 ? `${it.tier} • ×${it.qty}` : it.tier) : `×${it.qty}`, LIMIT.value),
        inline: true,
      });
    }
    // Room reserved for the ``` fences AND for the note that says what was left
    // out — budgeting only for the fences would push the field back over cap
    // precisely when there is something to say.
    const room = LIMIT.value - 8 - omittedNote(it.values.length).length;
    const cut = clipKeys(it.values, Math.max(64, room));
    embed.addFields({
      name: it.values.length > 1 ? `🔑 Your ${it.values.length} Keys` : '🔑 Your Key',
      value: clip('```' + cut.text + '```' + (cut.omitted ? omittedNote(cut.omitted) : ''), LIMIT.value),
    });
  } else {
    // Several products: each is its own field, product as the heading and the
    // rest as a context line above the keys. Still no name long enough to wrap.
    for (const it of shown.slice(0, LIMIT.fields - 2)) {
      const ctx = contextLine(it.game, it.tier, it.qty);
      const room = LIMIT.value - (ctx.length + 12) - omittedNote(it.values.length).length;
      const cut = clipKeys(it.values, Math.max(64, room));
      const body = '```' + cut.text + '```' + (cut.omitted ? omittedNote(cut.omitted) : '');
      embed.addFields({
        name: clip(`📦 ${it.product}`, LIMIT.name),
        value: clip(ctx ? `${ctx}\n${body}` : body, LIMIT.value),
      });
    }
  }

  // Once, at the bottom, where a receipt number belongs — and not again in the
  // footer. No email on the order is not a dead end: the claim accepts the
  // Discord account it was delivered to and creates a site account from it.
  if (invoiceNo || orderId) {
    embed.addFields({
      name: '🧾 Invoice',
      value: clip(
        `\`${invoiceNo || `#${orderId}`}\`\nKeep this. Use \`/claim-customer\` with it`
        + `${email ? ` and \`${email}\`` : ' (leave the email blank — this order was delivered to you on Discord)'}`
        + ' to get your customer role and put this order on your uhservices.xyz account, or quote it to staff.',
        LIMIT.value),
    });
  }

  embed.setFooter({ text: 'uhservices.xyz • thank you for your order' });

  return {
    embed,
    // Undefined entries are dropped here rather than at every call site.
    protect: [...new Set(protect.filter(s => s != null && String(s).trim()))].map(String),
    lines,
    delivered: shown.length,
  };
}

module.exports = { buildDeliveryEmbed, LIMIT, clip, clipKeys, omittedNote, gameWorthShowing, contextLine };
