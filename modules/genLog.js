// ─── GEN LOG ──────────────────────────────────────────────────────────────────
// One channel that answers "who generated what, and when".
//
// Until now a generation left three separate traces and none of them was a
// record: the account itself went out by DM (visible to the member alone), the
// cooldown row in `stock_cooldowns` said only that SOMETHING was taken and when,
// and the SMS order embed landed in whatever channel resolveOrderChannel picked.
// Nothing tied a member to a specific item at a specific time in a place staff
// could read.
//
// What is logged and what is NOT:
//   • WHO, WHAT TYPE, WHEN, and how much stock was left afterwards — always.
//   • The credentials themselves — NEVER. A gen log is a staff-readable channel
//     and the delivered value is a live account; putting it here would turn an
//     audit trail into a second copy of everyone's password. `/order lookup`
//     already exists for the cases where a specific value has to be recovered.
//     The one exception is the SMS number, which is public in the order channel
//     anyway and is the only handle staff have on a provider order.
//
// Failure is deliberately silent-but-loud: an announcement that cannot post
// must never break the generation it is reporting on (the member has already
// been charged a cooldown, or real provider credit), so every path catches and
// logs to the console instead of throwing.
'use strict';

const { EmbedBuilder } = require('discord.js');

// The id the operator gave for this. Kept as a fallback rather than a
// requirement so the channel keeps working if the env var is never set, and
// stays overridable if the channel is ever recreated.
const GEN_LOG_FALLBACK = '1533934631294992555';

const KINDS = {
  account: { emoji: '🔐', label: 'Account Generated', color: 0x2ecc71 },
  sms:     { emoji: '📱', label: 'Number Generated',  color: 0x5865f2 },
  key:     { emoji: '🔑', label: 'Key(s) Generated',  color: 0xfaa61a },
};

function genLogChannelId() {
  return process.env.GEN_LOG_CHANNEL_ID || GEN_LOG_FALLBACK;
}

async function resolveGenLogChannel(client) {
  const id = genLogChannelId();
  if (!id) return null;
  try {
    const ch = await client.channels.fetch(String(id));
    // A channel the bot can see but cannot post in is the same as no channel
    // for our purposes, and saying so names the cause instead of the symptom.
    if (!ch || typeof ch.send !== 'function') return null;
    return ch;
  } catch (e) {
    console.error(`[GenLog] channel ${id} unreachable: ${e.message} — set GEN_LOG_CHANNEL_ID`);
    return null;
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {object} p
 * @param {'account'|'sms'|'key'} p.kind
 * @param {import('discord.js').User|{id:string,tag?:string}} p.user  who generated
 * @param {string} p.what            human label of the thing generated
 * @param {string} [p.detail]        extra line (number, role, duration…)
 * @param {number} [p.remaining]     stock left afterwards, if known
 * @param {boolean} [p.delivered]    did the DM/delivery succeed
 * @param {string} [p.source]        'command' | 'panel' | 'button'
 */
async function logGeneration(client, p = {}) {
  try {
    const meta = KINDS[p.kind] || KINDS.account;
    const ch = await resolveGenLogChannel(client);
    if (!ch) {
      console.warn(`[GenLog] ${meta.label} by ${p.user?.id} NOT logged — no reachable channel (${genLogChannelId()})`);
      return false;
    }

    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`${meta.emoji} ${meta.label}`)
      .addFields(
        // The mention AND the raw id: a mention is unreadable once the member
        // leaves the server, which is exactly when staff go looking.
        { name: 'Member', value: `<@${p.user?.id}> \`${p.user?.id ?? 'unknown'}\``, inline: false },
        { name: 'What',   value: String(p.what || '—').slice(0, 1024), inline: true },
      )
      .setTimestamp();

    if (p.detail)             embed.addFields({ name: 'Detail', value: String(p.detail).slice(0, 1024), inline: true });
    if (p.remaining != null)  embed.addFields({ name: 'Stock left', value: `${p.remaining}`, inline: true });
    if (p.delivered != null)  embed.addFields({ name: 'Delivered', value: p.delivered ? '✅ DM sent' : '⚠️ DM failed — shown in channel', inline: true });
    if (p.source)             embed.setFooter({ text: `via ${p.source}` });

    await ch.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.error('[GenLog] failed to post:', err.message);
    return false;
  }
}

module.exports = { logGeneration, genLogChannelId, resolveGenLogChannel, GEN_LOG_FALLBACK };
