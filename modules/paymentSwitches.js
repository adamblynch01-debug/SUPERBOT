// ─── /config methods — turning a payment method off from Discord ─────────────
//
// Until this existed there was no way to stop accepting a payment method at
// all. Availability was inferred purely from whether the address parsed, so
// "deliberately closed" and "misconfigured" were the same state, and the only
// lever anyone had was to delete the cashtag or the PayPal address out of the
// config and type it back in afterwards — destructive, and it needed a redeploy
// when the value lived in Railway.
//
// The switch itself lives in the backend (`PAYMENT_METHODS_OFF`, honoured
// inside payableMethods()), which is why this file is short: everything that
// reads /api/config already picks it up. That includes the #payment-methods
// panel, which lists methods straight out of `cfg.payment_methods`.
//
// That panel used to go stale on a toggle, and the footer here told the admin
// to go and re-run the command that posts it. Two things were wrong with that.
// The command it named — /post-payment-method — posts the free-text document
// from /set-payment-method and has nothing to do with the live panel, so
// following the instruction would not have fixed anything. And leaving a public
// "send your money here" notice correct only for as long as somebody remembers
// a chore is not a design, it is a pending incident: the moment you close a
// method is the moment you are least likely to remember.
//
// The panel now edits itself. This file forces a pass immediately after a
// successful toggle so the channel changes while the admin is still looking at
// it; the timer in index.js covers the other direction, where the website's
// admin panel moves a switch and Discord is never told.
'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');

// Set by index.js, which owns the client and the channel resolver. Left as a
// no-op so this module stays renderable by the tests with no Discord at all.
let refreshPanels = async () => {};
function setPanelRefresher(fn) { if (typeof fn === 'function') refreshPanels = fn; }

const METHODS = ['cashapp', 'paypal', 'btc', 'ltc'];
const META = {
  cashapp: { label: 'Cash App', emoji: '💵' },
  paypal:  { label: 'PayPal',   emoji: '🅿️' },
  btc:     { label: 'Bitcoin',  emoji: '₿' },
  ltc:     { label: 'Litecoin', emoji: 'Ł' },
};

const BACKEND_URL = () => process.env.BACKEND_URL || 'http://localhost:3000';

async function fetchStates() {
  const res = await axios.get(`${BACKEND_URL()}/api/config`, { timeout: 10000 });
  const cfg = res.data || {};
  // `payment_method_states` is the richer field added alongside the switch. An
  // older backend does not send it, and falling back to the plain booleans
  // means this command degrades to "on/off with no reason" rather than
  // throwing — which matters because the moment you most want this command is
  // the moment something is already wrong.
  if (cfg.payment_method_states) return cfg.payment_method_states;
  const avail = cfg.payment_methods || {};
  const out = {};
  for (const m of METHODS) {
    out[m] = avail[m]
      ? { available: true, state: 'on', reason: null }
      : { available: false, state: 'unconfigured', reason: 'Not available' };
  }
  return out;
}

/**
 * Writes the new off-list. Recomputed from what the backend just reported
 * rather than from anything cached here, so two admins toggling at once cannot
 * have one silently undo the other's other switch.
 */
async function setMethod(method, enabled) {
  const states = await fetchStates();
  const off = new Set(METHODS.filter(m => states[m] && states[m].state === 'off'));
  if (enabled) off.delete(method); else off.add(method);
  const value = METHODS.filter(m => off.has(m)).join(',');

  await axios.post(`${BACKEND_URL()}/api/config/update`, {
    secret: process.env.API_SECRET,
    key: 'PAYMENT_METHODS_OFF',
    value,
  }, { timeout: 10000 });

  return fetchStates();
}

function buildEmbed(states) {
  const line = (m) => {
    const st = states[m] || { available: false, state: 'unconfigured', reason: 'Unknown' };
    // Three states, not two. "Switched off" is a decision somebody made and
    // can undo here; "needs setup" is a fault that this command cannot fix,
    // and showing both as a red cross is how you end up clicking TURN ON four
    // times wondering why nothing happens.
    // A method that cannot hold the shop's currency is still accepting — the
    // order stays priced in euro and the buyer is quoted the converted figure,
    // locked at checkout (backend utils/fx.js). Worth saying on the line rather
    // than leaving it to be discovered from a receipt: the money that lands in
    // that account is in another currency, and whoever reconciles it needs to
    // know that before they compare a total to a bank statement.
    if (st.available) {
      return `${META[m].emoji} **${META[m].label}** — 🟢 accepting`
        + (st.settle_currency ? ` · collects ${st.settle_currency}, priced in EUR` : '');
    }
    if (st.state === 'off') return `${META[m].emoji} **${META[m].label}** — 🔴 switched off`;
    return `${META[m].emoji} **${META[m].label}** — 🟠 needs setup · ${st.reason || 'not configured'}`;
  };

  const anyOn = METHODS.some(m => states[m] && states[m].available);

  return new EmbedBuilder()
    .setColor(anyOn ? 0x5865F2 : 0xED4245)
    .setTitle('💳 Accepted Payment Methods')
    .setDescription(METHODS.map(line).join('\n'))
    .addFields({
      name: 'What switching off does',
      value: 'The method disappears from checkout straight away and the server refuses it, so an '
           + "open browser tab can't slip an order through. Your cashtag, PayPal address and xPub keys "
           + 'are kept — turning it back on needs nothing retyped.',
    })
    .setFooter({
      text: anyOn
        ? 'The #payment-methods panel updates itself — nothing to re-run'
        : 'NOTHING IS BEING ACCEPTED — the store cannot take money right now',
    })
    .setTimestamp();
}

function buildRows(states) {
  const rows = [];
  for (let i = 0; i < METHODS.length; i += 2) {
    const row = new ActionRowBuilder();
    for (const m of METHODS.slice(i, i + 2)) {
      const st = states[m] || {};
      // The button reflects the SWITCH, not availability. A method that is
      // switched on but has a broken address still shows "Turn off", because
      // that is what the switch would do — but it is styled grey rather than
      // red, so "you are about to close a live payment method" and "this one
      // was never working anyway" do not look like the same click.
      const on = st.state !== 'off';
      const live = !!st.available;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`paysw::${m}::${on ? 'off' : 'on'}`)
          .setLabel(`${on ? 'Turn off' : 'Turn on'} ${META[m].label}`)
          .setEmoji(META[m].emoji)
          .setStyle(on ? (live ? ButtonStyle.Danger : ButtonStyle.Secondary) : ButtonStyle.Success)
      );
    }
    rows.push(row);
  }
  return rows;
}

/** `/config methods` — show the switches. Caller has already deferred. */
async function handleMethodsCommand(interaction) {
  try {
    const states = await fetchStates();
    return interaction.editReply({ embeds: [buildEmbed(states)], components: buildRows(states) });
  } catch (err) {
    return interaction.editReply({
      content: `❌ Could not reach the shop backend: ${err.message}\n`
             + 'The switches are stored there, so nothing has been changed.',
    });
  }
}

/**
 * Button press. Returns true when it handled the interaction, so index.js's
 * dispatcher can fall through for everything else.
 *
 * Re-checks permission rather than trusting that only an admin can see the
 * message. The reply is ephemeral, but a customId is a string — anyone who can
 * read it can send it, and this one closes the store's tills.
 */
async function handleMethodButton(interaction, isOwnerAdmin) {
  if (!interaction.customId || !interaction.customId.startsWith('paysw::')) return false;

  if (!isOwnerAdmin) {
    await interaction.reply({ content: '❌ Only the server owner/admin can change payment configuration.', flags: 64 });
    return true;
  }

  const [, method, want] = interaction.customId.split('::');
  if (!METHODS.includes(method)) {
    await interaction.reply({ content: '❌ Unknown payment method.', flags: 64 });
    return true;
  }

  await interaction.deferUpdate();
  try {
    const states = await setMethod(method, want === 'on');
    const label = META[method].label;
    await interaction.editReply({
      content: want === 'on'
        ? `✅ **${label}** is being accepted again.`
        : `🔴 **${label}** is switched off. Checkout no longer offers it, and the server will refuse it. `
          + 'Your address is kept.',
      embeds: [buildEmbed(states)],
      components: buildRows(states),
    });
    // Deliberately after the reply and deliberately not awaited into it: the
    // switch is already saved, and a channel the bot cannot edit must not turn
    // a successful toggle into an error message.
    refreshPanels().catch(e => console.warn('[PaySwitch] panel refresh failed:', e.message));
  } catch (err) {
    await interaction.followUp({
      content: `❌ Could not change that: ${err.response && err.response.data && err.response.data.error || err.message}`,
      flags: 64,
    });
  }
  return true;
}

module.exports = {
  handleMethodsCommand, handleMethodButton, setPanelRefresher,
  // Exported for the tests, which render without a Discord connection.
  buildEmbed, buildRows, METHODS, META,
};
