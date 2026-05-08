// ─── Anti-Scam Module (ported from Python) ────────────────────────────────────
'use strict';

const { EmbedBuilder } = require('discord.js');

// ─── Config (overrideable via env) ─────────────────────────────────────────
const WARNINGS_BEFORE_BAN   = parseInt(process.env.WARNINGS_BEFORE_BAN   || '3');
const MUTE_DURATION_MINUTES = parseInt(process.env.MUTE_DURATION_MINUTES || '30');
const SPAM_MESSAGE_LIMIT    = parseInt(process.env.SPAM_MESSAGE_LIMIT    || '3');
const SPAM_TIME_WINDOW      = parseInt(process.env.SPAM_TIME_WINDOW      || '10'); // seconds

let LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID ? parseInt(process.env.LOG_CHANNEL_ID) : null;

// ─── Mutable lists (can be changed via commands) ───────────────────────────
let BANNED_LINKS = [
  'stake.com','bc.game','rollbit.com','duelbits.com','prizepicks.com',
  'bovada.lv','pokerbros.net','pulsecasino.com','pedanex.com','pedanet.com',
  'bit.ly','tinyurl.com',
];

let BANNED_WORDS = [
  'nigger','nigga','faggot','retard','chink','spic','kike',
  'fuck','fucking','fucked','fucker','fuck you','shit','bitch',
  'pussy','asshole','bastard','cunt','dick','cock','whore','slut',
];

const SCAM_KEYWORD_PATTERNS = [
  /\bpromo\s*code\b/i,/\bactivate\s*code\b/i,/\bbonus\s*code\b/i,
  /\bcasino\b/i,/\bgambling\b/i,/\bsports?bet\b/i,/\bpokerbros\b/i,
  /\bpulse\s*casino\b/i,/\bstake\.com\b/i,/\bbc\.game\b/i,
  /\brollbit\b/i,/\bduelbits\b/i,/\bprizepicks\b/i,/\bbovada\b/i,
  /\bgiving away\s*\$[\d,]+\b/i,/\bclaim\s*(your\s*)?(reward|bonus|prize)\b/i,
  /\bwithdrawal\s*success\b/i,/\bwithdraw\s*(instantly|now)\b/i,
  /\bfree\s*(crypto|bitcoin|btc|eth|usdt)\b/i,/\bsend\s*\d+\s*(btc|eth|usdt|crypto)\b/i,
  /\bdouble\s*your\s*(crypto|bitcoin|money)\b/i,/\bkai\s*cenat\b/i,
  /\b@kaicenat\b/i,/\bcenat\b/i,/\bany\s*means\s*possible\b/i,
  /bit\.ly\//i,/tinyurl\.com\//i,/t\.co\/[a-z0-9]+/i,
  /\bclick\s*here\s*to\s*claim\b/i,/\b(pedanex|pedanet|pedanes)\.com\b/i,
  /\b\w+(casino|bet|stake|gambling)\w*\.com\b/i,
];
const KEYWORD_THRESHOLD = 2;

const INSTANT_DELETE_PHRASES = [
  'withdrawal success','activate code for bonus','enter the promo code',
  'giving away $2,500','giving away $2500','promo code: cenat','promo code cenat',
  'launch of my very own crypto casino',
];

// ─── State ─────────────────────────────────────────────────────────────────
const userWarnings   = new Map(); // userId -> count
const userScamTimes  = new Map(); // userId -> [timestamps]

// ─── Detection helpers ─────────────────────────────────────────────────────
function isScam(content) {
  const text = content.toLowerCase();
  for (const phrase of INSTANT_DELETE_PHRASES) {
    if (text.includes(phrase)) return { scam: true, reason: `Instant-delete phrase: "${phrase}"` };
  }
  const matched = SCAM_KEYWORD_PATTERNS.filter(p => p.test(content));
  if (matched.length >= KEYWORD_THRESHOLD)
    return { scam: true, reason: `${matched.length} scam patterns matched` };
  return { scam: false, reason: '' };
}

function hasBannedLink(content) {
  const text = content.toLowerCase();
  for (const domain of BANNED_LINKS)
    if (text.includes(domain)) return { found: true, reason: `Banned link: ${domain}` };
  return { found: false, reason: '' };
}

function hasProfanity(content) {
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(content)) return { found: true };
  }
  return { found: false };
}

function isSpamFlood(userId) {
  const now  = Date.now();
  const cutoff = now - SPAM_TIME_WINDOW * 1000;
  const times = (userScamTimes.get(userId) || []).filter(t => t > cutoff);
  times.push(now);
  userScamTimes.set(userId, times);
  return times.length >= SPAM_MESSAGE_LIMIT;
}

// ─── Embed builders ────────────────────────────────────────────────────────
function banEmbed(user, reason, warnCount, channel) {
  const e = new EmbedBuilder()
    .setTitle('🔨 User Banned').setColor(0xFF0000).setTimestamp()
    .setAuthor({ name: `${user.tag} was banned`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',     value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',  value: `\`${user.id}\``,           inline: true },
      { name: '⚠️ Warnings', value: `\`${warnCount}/${WARNINGS_BEFORE_BAN}\``, inline: true },
      { name: '📋 Reason',   value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Ban Log' });
  if (channel) e.addFields({ name: '📍 Channel', value: channel.toString(), inline: true });
  return e;
}

function timeoutEmbed(user, reason, durMins, channel) {
  const e = new EmbedBuilder()
    .setTitle('🔇 User Timed Out').setColor(0xFF8C00).setTimestamp()
    .setAuthor({ name: `${user.tag} was timed out`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',      value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',   value: `\`${user.id}\``,           inline: true },
      { name: '⏱️ Duration',  value: `\`${durMins} minutes\``,   inline: true },
      { name: '📋 Reason',    value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Timeout Log' });
  if (channel) e.addFields({ name: '📍 Channel', value: channel.toString(), inline: true });
  return e;
}

function scamDeleteEmbed(user, reason, content, warnCount, channel) {
  const e = new EmbedBuilder()
    .setTitle('🚨 Scam Message Deleted').setColor(0xFFA500).setTimestamp()
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',     value: `${user}\n\`${user.tag}\``, inline: true },
      { name: '🪪 User ID',  value: `\`${user.id}\``,           inline: true },
      { name: '⚠️ Warnings', value: `\`${warnCount}/${WARNINGS_BEFORE_BAN}\``, inline: true },
      { name: '📍 Channel',  value: channel.toString(),         inline: true },
      { name: '📋 Reason',   value: reason.slice(0, 500),       inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Scam Log' });
  if (content) e.addFields({ name: '💬 Message', value: `\`\`\`${content.slice(0, 400)}\`\`\``, inline: false });
  return e;
}

function spamBanEmbed(user, reason, deletedCount) {
  return new EmbedBuilder()
    .setTitle('🚫 Spammer Banned').setColor(0x8B0000).setTimestamp()
    .setAuthor({ name: `${user.tag} was banned for spam flooding`, iconURL: user.displayAvatarURL() })
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: '👤 User',                value: `\`${user.tag}\``,     inline: true },
      { name: '🪪 User ID',             value: `\`${user.id}\``,      inline: true },
      { name: '🗑️ Messages Deleted',   value: `\`${deletedCount}\``, inline: true },
      { name: '📋 Reason',              value: `Spam flood — ${reason.slice(0, 400)}`, inline: false },
    )
    .setFooter({ text: 'Anti-Scam Bot • Spam Ban Log' });
}

// ─── Handlers ──────────────────────────────────────────────────────────────
async function sendLog(guild, client, embed) {
  if (!LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(String(LOG_CHANNEL_ID));
  if (ch) try { await ch.send({ embeds: [embed] }); } catch (_) {}
}

async function handleSpamFlood(message, reason, client) {
  const { guild, author } = message;
  let deletedCount = 0;
  for (const [, ch] of guild.channels.cache) {
    if (ch.type !== 0) continue; // GuildText only
    try {
      const msgs = [];
      const fetched = await ch.messages.fetch({ limit: 100 });
      fetched.forEach(m => { if (m.author.id === author.id) msgs.push(m); });
      if (msgs.length === 1) { await msgs[0].delete(); deletedCount++; }
      else if (msgs.length > 1) { await ch.bulkDelete(msgs); deletedCount += msgs.length; }
    } catch (_) {}
  }
  try {
    await guild.ban(author, { reason: `Spam flood: ${reason}`, deleteMessageSeconds: 86400 });
    await sendLog(guild, client, spamBanEmbed(author, reason, deletedCount));
    userScamTimes.delete(author.id);
    userWarnings.delete(author.id);
  } catch (_) {}
}

async function handleViolation(message, reason, client) {
  const { guild, author, channel } = message;
  try { await message.delete(); } catch (_) { return; }

  const count = (userWarnings.get(author.id) || 0) + 1;
  userWarnings.set(author.id, count);
  await sendLog(guild, client, scamDeleteEmbed(author, reason, message.content, count, channel));

  if (WARNINGS_BEFORE_BAN > 0 && count >= WARNINGS_BEFORE_BAN) {
    try { await author.send(`🔨 **You have been banned from ${guild.name}.**\nReason: ${count} violations — ${reason}`); } catch (_) {}
    try {
      await guild.ban(author, { reason: `${count} warnings: ${reason}`, deleteMessageSeconds: 86400 });
      await sendLog(guild, client, banEmbed(author, reason, count, channel));
      userWarnings.delete(author.id);
      userScamTimes.delete(author.id);
    } catch (_) {}
    return;
  }

  try {
    await author.send(
      `⚠️ **Your message in ${guild.name} was removed.**\nReason: ${reason}\nWarning **${count}/${WARNINGS_BEFORE_BAN}** — continued violations will result in a ban.`
    );
  } catch (_) {}

  if (count === 1 && MUTE_DURATION_MINUTES > 0) {
    try {
      const until = new Date(Date.now() + MUTE_DURATION_MINUTES * 60 * 1000);
      await message.member.timeout(until.getTime() - Date.now(), reason);
      await sendLog(guild, client, timeoutEmbed(author, reason, MUTE_DURATION_MINUTES, channel));
    } catch (_) {}
  }
}

// ─── Main message handler (call from index.js on_message) ─────────────────
async function onMessage(message, client) {
  if (message.author.bot || !message.guild) return;
  if (message.member?.permissions.has('Administrator')) return;
  const content = message.content || '';

  const { found: profane } = hasProfanity(content);
  if (profane) { await handleViolation(message, 'Profanity — keep it clean', client); return; }

  const { found: hasLink, reason: linkReason } = hasBannedLink(content);
  if (hasLink) { await handleViolation(message, linkReason, client); return; }

  if (message.attachments.size > 0 && !content.trim()) return;

  const { scam, reason: scamReason } = isScam(content);
  if (scam) {
    if (isSpamFlood(message.author.id)) await handleSpamFlood(message, scamReason, client);
    else await handleViolation(message, scamReason, client);
  }
}

// ─── Prefix commands (called from index.js command handler) ────────────────
async function handlePrefixCommand(message, client) {
  if (!message.content.startsWith('!')) return false;
  const args   = message.content.slice(1).trim().split(/\s+/);
  const cmd    = args.shift().toLowerCase();
  const member = message.member;
  const hasManage = member?.permissions.has('ManageMessages');
  const hasKick   = member?.permissions.has('KickMembers');
  const hasManageCh = member?.permissions.has('ManageChannels');

  if (cmd === 'bothelp') {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Anti-Scam — Command List').setColor(0x5865f2).setTimestamp()
      .addFields(
        { name: '⚙️ General',        value: '`!bothelp` — Show this menu\n`!manage` — Bot management panel\n`!scamcheck <text>` — Test if text gets flagged', inline: false },
        { name: '🔨 Moderation',     value: '`!nuke` — Wipe all messages in channel\n`!warnings @user` — Check warning count\n`!clearwarnings @user` — Reset warnings', inline: false },
        { name: '🔗 Banned Links',   value: '`!addlink example.com` — Ban a domain\n`!removelink example.com` — Unban a domain\n`!listlinks` — Show all banned domains', inline: false },
        { name: '🤬 Profanity Filter',value: '`!addword badword` — Add to filter\n`!removeword badword` — Remove from filter', inline: false },
      )
      .setFooter({ text: 'Requires Manage Messages permission for most commands.' });
    await message.channel.send({ embeds: [embed] });
    return true;
  }

  if (cmd === 'manage' && hasManage) {
    const embed = new EmbedBuilder()
      .setTitle('⚙️ Anti-Scam Bot — Management Panel').setColor(0x00008B).setTimestamp()
      .addFields(
        { name: '🔧 Current Settings', value:
          `**Warnings before ban:** \`${WARNINGS_BEFORE_BAN}\`\n**Timeout duration:** \`${MUTE_DURATION_MINUTES} minutes\`\n**Spam limit:** \`${SPAM_MESSAGE_LIMIT} messages in ${SPAM_TIME_WINDOW}s\`\n**Log channel:** ${LOG_CHANNEL_ID ? `<#${LOG_CHANNEL_ID}>` : '`Not set`'}`,
          inline: false },
        { name: `🔗 Banned Links (${BANNED_LINKS.length})`,
          value: BANNED_LINKS.slice(0, 10).map(d => `\`${d}\``).join('\n') + (BANNED_LINKS.length > 10 ? `\n_...and ${BANNED_LINKS.length-10} more_` : '') || '`None`',
          inline: false },
        { name: `🤬 Profanity Filter (${BANNED_WORDS.length} words)`, value: '`[hidden for privacy]`', inline: false },
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({ text: `Requested by ${message.author.tag} • Anti-Scam Bot` });
    await message.channel.send({ embeds: [embed] });
    return true;
  }

  if (cmd === 'scamcheck' && hasManage) {
    const text = args.join(' ');
    const { scam, reason } = isScam(text);
    const { found: link, reason: lr } = hasBannedLink(text);
    const { found: prof } = hasProfanity(text);
    if (scam) await message.channel.send(`✅ **Scam flagged.** ${reason}`);
    else if (link) await message.channel.send(`✅ **Banned link flagged.** ${lr}`);
    else if (prof) await message.channel.send(`✅ **Profanity flagged.**`);
    else await message.channel.send(`❌ **Would NOT be flagged.**`);
    return true;
  }

  if (cmd === 'clearwarnings' && hasKick) {
    const user = message.mentions.users.first();
    if (user) { userWarnings.delete(user.id); await message.channel.send(`✅ Cleared warnings for ${user}`); }
    return true;
  }

  if (cmd === 'warnings' && hasManage) {
    const user = message.mentions.users.first();
    if (user) await message.channel.send(`⚠️ ${user} has **${userWarnings.get(user.id) || 0}** warning(s).`);
    return true;
  }

  if (cmd === 'addlink' && hasManage && args[0]) {
    const domain = args[0].toLowerCase();
    if (!BANNED_LINKS.includes(domain)) { BANNED_LINKS.push(domain); await message.channel.send(`✅ Added \`${domain}\` to banned links.`); }
    else await message.channel.send(`\`${domain}\` is already banned.`);
    return true;
  }

  if (cmd === 'removelink' && hasManage && args[0]) {
    const domain = args[0].toLowerCase();
    const idx = BANNED_LINKS.indexOf(domain);
    if (idx !== -1) { BANNED_LINKS.splice(idx, 1); await message.channel.send(`✅ Removed \`${domain}\` from banned links.`); }
    else await message.channel.send(`\`${domain}\` was not in the list.`);
    return true;
  }

  if (cmd === 'listlinks' && hasManage) {
    if (BANNED_LINKS.length) await message.channel.send(`🔗 **Banned links:**\n${BANNED_LINKS.map(d => `• \`${d}\``).join('\n')}`);
    else await message.channel.send('No banned links configured.');
    return true;
  }

  if (cmd === 'addword' && hasManage && args[0]) {
    const word = args[0].toLowerCase();
    if (!BANNED_WORDS.includes(word)) { BANNED_WORDS.push(word); await message.channel.send(`✅ Added to profanity filter.`); }
    else await message.channel.send('Already in filter.');
    return true;
  }

  if (cmd === 'removeword' && hasManage && args[0]) {
    const word = args[0].toLowerCase();
    const idx = BANNED_WORDS.indexOf(word);
    if (idx !== -1) { BANNED_WORDS.splice(idx, 1); await message.channel.send(`✅ Removed from profanity filter.`); }
    else await message.channel.send('Not found in filter.');
    return true;
  }

  if (cmd === 'nuke' && hasManageCh) {
    const ch = message.channel;
    const newCh = await ch.clone({ reason: `Nuked by ${message.author.tag}` });
    await newCh.setPosition(ch.position);
    await ch.delete({ reason: `Nuked by ${message.author.tag}` });
    const embed = new EmbedBuilder()
      .setTitle('💥 Channel Nuked')
      .setDescription(`This channel was nuked by ${message.author}.\nAll previous messages have been wiped.`)
      .setColor(0xFF8C00).setTimestamp();
    const msg = await newCh.send({ embeds: [embed] });
    setTimeout(() => msg.delete().catch(() => {}), 5000);
    return true;
  }

  return false;
}

module.exports = { onMessage, handlePrefixCommand, BANNED_LINKS, BANNED_WORDS, userWarnings };
