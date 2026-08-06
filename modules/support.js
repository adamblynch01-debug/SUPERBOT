// ─── DM Support Ticket Module (ported from Python) ─────────────────────────
'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const db   = require('../db');
// The language dropdown, appended to the support panel so a member who does
// not read English can at least read the button labels' explanation.
const { languageRow } = require('./translate');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (DATA_DIR !== path.join(__dirname, '..') && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TICKETS_FILE     = path.join(DATA_DIR, 'tickets.json');
// There is deliberately no SUPPORT_CHANNEL here. /panel posts into the channel
// it was run in, so nothing ever read the id — and a panel field for it would
// have been a setting that saves, shows a green toast and does nothing, which is
// the exact state seven other fields were found in this round.
const TICKET_LOG_CHANNEL = process.env.TICKET_LOG_CHANNEL || null;
const STAFF_ROLE_ID    = process.env.STAFF_ROLE_ID || null;

// Who gets @-mentioned when a ticket opens. Deliberately SEPARATE from
// STAFF_ROLE_ID: that one is the permission gate in index.js hasAccess() and
// covers /web-balance, /addstock, /clearstock and /giveaway — i.e. it can move
// money. The guild has two roles both called "Ticket Staff" (a plain-ASCII
// leftover and the real styled one) and the env pointed at the leftover, so the
// ping went nowhere useful. Repointing STAFF_ROLE_ID would have fixed the ping
// AND silently handed the money commands to everyone on the ticket team.
// Falls back to STAFF_ROLE_ID so an unset var keeps the old behaviour exactly.
const TICKET_STAFF_ROLE_ID = process.env.TICKET_STAFF_ROLE_ID || STAFF_ROLE_ID;

// Rank boosting is handled by its own team in its own channel, so those
// tickets must not land in the general ticket log or ping general staff.
const RANK_BOOST_LOG_CHANNEL = process.env.RANK_BOOST_LOG_CHANNEL || '1532134443433721928'; // 𝐑𝐚𝐧𝐤-𝐁𝐨𝐨𝐬𝐭𝐞𝐫-𝐓𝐢𝐜𝐤𝐞𝐭-𝐋𝐨𝐠
const RANK_BOOST_ROLE_ID     = process.env.RANK_BOOST_ROLE_ID     || '1532108479454515341'; // ⚡ Rank Booster Staff

// Ticket type → where its log goes and who gets pinged. Anything absent here
// falls back to the general log channel and staff role, so adding a button
// without a route can never silently stop logging.
//
// Everything above is a single set of ids for the whole bot, and every lookup
// below used client.channels.cache — which is bot-wide, not guild-scoped. So a
// ticket opened on the second server was logged into the FIRST server's ticket
// channel and pinged the first server's staff role. Not "didn't work": worked,
// in the wrong building, with a customer's issue text in it.
//
// A ticket is now routed by the guild whose button was pressed. That guild is
// recorded on the ticket when it opens (the conversation continues in DMs,
// where there is no guild to ask), and settingsFor() is installed by index.js
// so the panel's Ticket-log channel and Ticket-staff role fields decide it
// per server. The env ids stay as the fallback for the original guild.
const ENV_ROUTES = {
  ticketLogChannel:  TICKET_LOG_CHANNEL,
  ticketStaffRoleId: TICKET_STAFF_ROLE_ID,
  rankBoostLogChannel: RANK_BOOST_LOG_CHANNEL,
  rankBoostRoleId:     RANK_BOOST_ROLE_ID,
};

let settingsFor = async () => null;
function setSupportSettingsProvider(fn) { if (typeof fn === 'function') settingsFor = fn; }

async function routeFor(ticketType, guildId) {
  let s = null;
  if (guildId) {
    try { s = await settingsFor(guildId); }
    catch (e) { console.error('[Tickets] could not read guild settings:', e.message); }
  }
  const pick = (k) => {
    const v = s && s[k];
    return (v === null || v === undefined || v === '') ? ENV_ROUTES[k] : v;
  };
  if (ticketType === 'Rank Boosting') {
    return { channel: pick('rankBoostLogChannel'), role: pick('rankBoostRoleId'), guildId };
  }
  return { channel: pick('ticketLogChannel'), role: pick('ticketStaffRoleId'), guildId };
}

// A channel id that belongs to another guild resolves fine through
// client.channels — that is exactly how the leak happened. Resolve inside the
// ticket's own guild when we know it, and say so when the id does not live
// there rather than posting into whichever server does own it.
async function resolveLogChannel(client, route) {
  if (!route.channel) return null;
  const id = String(route.channel);
  if (route.guildId) {
    const g = client.guilds.cache.get(String(route.guildId));
    if (g) {
      const ch = g.channels.cache.get(id);
      if (ch) return ch;
      console.error(`[Tickets] channel ${id} is not in guild ${route.guildId} (${g.name}) — set the ticket log channel for that server in the panel. Not posting it to whichever server does own it.`);
      return null;
    }
  }
  // No guild recorded (a ticket saved by an older build). Fall back to the old
  // bot-wide lookup so those still log somewhere.
  let ch = client.channels.cache.get(id);
  if (!ch) try { ch = await client.channels.fetch(id); } catch (e) { console.error('[Tickets] Failed to fetch log channel:', e.message); }
  return ch || null;
}

const GAMES = [
  'Arc Raiders','Rust','Escape from Tarkov','Fortnite',
  'Apex Legends','Valorant','Call of Duty: Warzone',
  'PUBG','GTA V','Counter-Strike 2',
];

// ─── Persistent tickets ────────────────────────────────────────────────────
function loadTickets() {
  try {
    if (fs.existsSync(TICKETS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
      const map = new Map();
      for (const [k, v] of Object.entries(raw)) map.set(k, v);
      return map;
    }
  } catch (_) {}
  return new Map();
}
function saveTickets(map) {
  const obj = {};
  map.forEach((v, k) => { obj[String(k)] = v; });
  try { fs.writeFileSync(TICKETS_FILE, JSON.stringify(obj, null, 2)); } catch (_) {}
}

const activeTickets = loadTickets();

// ─── Ticket history log (Postgres) ─────────────────────────────────────────
// This is SEPARATE from activeTickets above — activeTickets is the live,
// in-memory state the DM/modal flow actually runs on, and stays exactly as
// it was. These two functions just also write a row to Postgres so the web
// panel can show ticket history. Wrapped in try/catch and never awaited in
// a way that could block the real ticket flow — if the DB is briefly down,
// tickets still work, you just lose that one history entry.
async function logTicketOpened(guildId, userId, category) {
  try {
    await db.ensureGuild(guildId);
    await db.query(
      `INSERT INTO tickets (guild_id, user_id, category, status, created_at) VALUES ($1,$2,$3,'open', now())`,
      [guildId, userId, category]
    );
  } catch (e) { console.error('[tickets] failed to log ticket open:', e); }
}

async function logTicketClosed(guildId, userId) {
  try {
    await db.query(
      `UPDATE tickets SET status = 'closed', closed_at = now()
       WHERE id = (SELECT id FROM tickets WHERE guild_id = $1 AND user_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1)`,
      [guildId, userId]
    );
  } catch (e) { console.error('[tickets] failed to log ticket close:', e); }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function isStaff(member) {
  if (!STAFF_ROLE_ID) return member.permissions.has('ManageMessages');
  return member.roles.cache.has(String(STAFF_ROLE_ID));
}

// The Quick Reply / Close buttons live in the ticket's OWN channel, so whoever
// that channel belongs to has to be able to press them — a rank booster
// without the general staff role would otherwise get "No permission" on a
// ticket sitting in their own log. General staff keep access to everything so
// a ticket can't get stranded if the specialist team is away.
// Async because the route it checks is per-guild now. The role is looked up in
// the member's OWN guild (member.roles), so a staff role id from another server
// simply does not match — which is correct, and is why the general isStaff()
// fallback still matters.
async function isStaffFor(member, ticketType) {
  if (!member) return false;
  const route = await routeFor(ticketType, member.guild && member.guild.id);
  if (route.role && member.roles.cache.has(String(route.role))) return true;
  return isStaff(member);
}

async function sendStaffLog(client, user, ticketData) {
  const route = await routeFor(ticketData.type, ticketData.guild_id);
  if (!route.channel) { console.error('[Tickets] no log channel for type', ticketData.type); return; }
  const logCh = await resolveLogChannel(client, route);
  if (!logCh) { console.error('[Tickets] Log channel not found:', route.channel); return; }
  const embed = new EmbedBuilder()
    .setTitle(`🎫 New Ticket — ${ticketData.type}`)
    .setColor(0xFF8C00).setTimestamp()
    .addFields(
      { name: 'User',   value: `<@${user.id}>`,       inline: true },
      { name: 'User ID',value: `\`${user.id}\``,      inline: true },
      { name: 'Game',   value: ticketData.game,        inline: true },
      { name: 'Type',   value: ticketData.type,        inline: true },
      { name: 'Issue',  value: ticketData.issue,       inline: false },
    )
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: `Opened at ${ticketData.opened_at} • UH Support` });

  await logCh.send({
    content: route.role ? `<@&${route.role}> New ticket from **${user.username}**` : `New ticket from **${user.username}**`,
    embeds: [embed],
    components: [ticketActionRow(user.id)],
  });
}

function ticketActionRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_reply_${userId}`).setLabel('💬 Quick Reply').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_close_${userId}`).setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger),
  );
}

// ─── Slash command registration data ───────────────────────────────────────
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const supportCommands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the support panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('clearlogs')
    .setDescription('Clear all messages in the ticket logs channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('reply')
    .setDescription('Reply to a user\'s support ticket')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Your reply').setRequired(true)),
].map(c => c.toJSON());

// ─── Interaction handler ────────────────────────────────────────────────────
async function handleInteraction(interaction, client) {
  // ── /panel ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    await interaction.deferReply({ ephemeral: true });
    const msgs = await interaction.channel.messages.fetch({ limit: 100 });
    for (const [, m] of msgs) if (m.author.id === client.user.id) try { await m.delete(); } catch (_) {}
    const embed = new EmbedBuilder()
      .setTitle('UH Support').setColor(0x5865f2)
      .setDescription(
        'Click a button below to start a support ticket. Our assistant will help you with your request.\n\n' +
        '**READ FAQ BEFORE MAKING A SUPPORT TICKET**\n\n' +
        '**TYPE !close IF YOU HAVE MULTIPLE TICKETS**\n\n' +
        '**How it works**\n1. Click the appropriate button below\n2. I\'ll DM you to start a conversation\n3. Describe your issue and I\'ll help!\n\n' +
        '© 2026 UH. All rights reserved.'
      );
    // Exactly 5 buttons — Discord's limit for one action row. A sixth type
    // needs a second row, not another entry here.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('support_hwid').setLabel('HWID Reset').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_purchase').setLabel('Purchase').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_resell').setLabel('Resell').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_rankboost').setLabel('⚡ Rank Boosting').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_general').setLabel('🎮 Support').setStyle(ButtonStyle.Primary),
    );
    await interaction.channel.send({ embeds: [embed], components: [row, languageRow()] });
    await interaction.editReply({ content: '✅ Panel posted!' });
    return true;
  }

  // ── /clearlogs ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearlogs') {
    await interaction.deferReply({ ephemeral: true });
    // This server's log channel — /clearlogs run in one server must never wipe
    // another server's ticket history.
    const clearRoute = await routeFor(null, interaction.guild && interaction.guild.id);
    if (!clearRoute.channel) { await interaction.editReply({ content: '❌ No ticket log channel is set for this server — set it in the panel (Settings → Ticket log channel).' }); return true; }
    const logCh = await resolveLogChannel(client, clearRoute);
    if (!logCh) { await interaction.editReply({ content: `❌ \`${clearRoute.channel}\` is not a channel in this server. Set this server's ticket log channel in the panel.` }); return true; }
    const msgs = await logCh.messages.fetch({ limit: 200 });
    try { await logCh.bulkDelete(msgs); } catch (_) { for (const [, m] of msgs) try { await m.delete(); } catch (_) {} }
    await interaction.editReply({ content: `Cleared ${msgs.size} messages from ticket logs.` });
    return true;
  }

  // ── /reply ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'reply') {
    const uid = interaction.options.getString("user_id");
    const msg = interaction.options.getString('message');
    const target = activeTickets.get(uid);
    if (!await isStaffFor(interaction.member, target && target.type)) {
      await interaction.reply({ content: '❌ You don\'t have permission.', ephemeral: true }); return true;
    }
    if (!target) {
      await interaction.reply({ content: '❌ No active ticket for that user.', ephemeral: true }); return true;
    }
    const user = client.users.cache.get(String(uid)) || await client.users.fetch(String(uid)).catch(() => null);
    if (!user) { await interaction.reply({ content: '❌ User not found.', ephemeral: true }); return true; }
    try {
      const dm = await user.createDM();
      const embed = new EmbedBuilder()
        .setDescription(`**Staff: ${interaction.user.username}** — ${msg}`)
        .setColor(0x57F287).setTimestamp()
        .setAuthor({ name: 'UH Support Reply', iconURL: interaction.user.displayAvatarURL() });
      await dm.send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Reply sent to **${user.username}**.`, ephemeral: true });
    } catch (_) { await interaction.reply({ content: '❌ Could not DM that user.', ephemeral: true }); }
    return true;
  }

  // ── Support panel buttons ──
  // The type NAME (not the customId) is what TICKET_ROUTES keys on and what
  // gets encoded into the game-select and issue-modal customIds, so it must
  // stay free of underscores — the modal parser splits on the first one.
  const TICKET_TYPES = {
    support_hwid: 'HWID Reset', support_purchase: 'Purchase', support_resell: 'Resell',
    support_rankboost: 'Rank Boosting', support_general: 'Support',
  };
  if (interaction.isButton() && TICKET_TYPES[interaction.customId]) {
    if (activeTickets.has(interaction.user.id)) {
      await interaction.reply({ content: '⚠️ You already have an open ticket. Type `!close` in your DM to close it first.', ephemeral: true });
      return true;
    }
    const ticketType = TICKET_TYPES[interaction.customId];
    const gameSelect = new StringSelectMenuBuilder()
      .setCustomId(`game_select_${ticketType.replace(/\s/g, '_')}`)
      .setPlaceholder('Select your game...')
      .addOptions(GAMES.map(g => ({ label: g, value: g })));
    const embed = new EmbedBuilder()
      .setDescription('🎮 **Which game do you need support for?**\nSelect from the dropdown below:')
      .setColor(0x5865f2);
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(gameSelect)], ephemeral: true });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 30000);
    return true;
  }

  // ── Game select ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('game_select_')) {
    const ticketType = interaction.customId.replace('game_select_', '').replace(/_/g, ' ');
    const game = interaction.values[0];
    const modal = new ModalBuilder().setCustomId(`issue_modal_${ticketType}_${game}`).setTitle('Describe Your Issue');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('issue_text').setLabel('What issue are you experiencing?')
          .setPlaceholder('Please describe your problem in detail (min 50 chars)...')
          .setStyle(TextInputStyle.Paragraph).setMinLength(50).setMaxLength(1000)
      )
    );
    await interaction.showModal(modal);
    return true;
  }

  // ── Issue modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('issue_modal_')) {
    const rest = interaction.customId.replace('issue_modal_', '');
    const sepIdx = rest.indexOf('_');
    const ticketType = rest.slice(0, sepIdx).replace(/_/g, ' ');
    const game = rest.slice(sepIdx + 1);
    const issueText = interaction.fields.getTextInputValue('issue_text');
    const openedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    // The guild the button was pressed in, recorded on the ticket. The rest of
    // the conversation happens in DMs, where there is no guild to ask — so if it
    // is not captured here it is gone, and every later routing decision falls
    // back to whichever server the env vars happen to describe.
    activeTickets.set(interaction.user.id, {
      type: ticketType, game, issue: issueText, opened_at: openedAt,
      guild_id: interaction.guild && interaction.guild.id,
    });
    saveTickets(activeTickets);

    await interaction.deferReply({ ephemeral: true });
    try {
      const dm = await interaction.user.createDM();
      const embed = new EmbedBuilder()
        .setTitle('UH Support Assistant').setColor(0x5865f2)
        .setDescription(
          'Hi there! I\'m here to help you troubleshoot any issues.\n\n' +
          '**Just describe your problem** and a staff member will assist you!\n\n' +
          `🎮 **Game:** ${game}\n\n` +
          '💡 **Tips for best results**\n• Include any error codes you see\n• Describe what you were doing when the issue occurred\n• Mention what you\'ve already tried\n\n' +
          '❌ **To end the session**\nType `!close` to close this support ticket'
        )
        .setFooter({ text: 'UH Support System' });
      await dm.send({ embeds: [embed] });
    } catch (_) {
      await interaction.followUp({ content: '❌ I couldn\'t DM you. Please enable DMs from server members.', ephemeral: true });
      activeTickets.delete(interaction.user.id);
      saveTickets(activeTickets);
      return true;
    }

    // Log to history now that the ticket actually started (DM succeeded) —
    // doesn't affect the live flow below either way.
    logTicketOpened(interaction.guild.id, interaction.user.id, `${ticketType} — ${game}`);

    try { await sendStaffLog(client, interaction.user, { type: ticketType, game, issue: issueText, opened_at: openedAt, guild_id: interaction.guild && interaction.guild.id }); } catch (e) { console.error("[Tickets] log error:", e.message); }

    const reply = await interaction.followUp({ content: '✅ I\'ve sent you a DM! Check your messages to start the support conversation.', ephemeral: true, fetchReply: true });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    return true;
  }

  // ── Quick reply button from log ──
  if (interaction.isButton() && interaction.customId.startsWith('ticket_reply_')) {
    const uid = interaction.customId.replace("ticket_reply_", "");
    const openTicket = activeTickets.get(uid);
    if (!await isStaffFor(interaction.member, openTicket && openTicket.type)) {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true }); return true;
    }
    const modal = new ModalBuilder().setCustomId(`staff_reply_modal_${uid}`).setTitle('Reply to Ticket');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reply_text').setLabel('Your reply to the user')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(1000)
    ));
    await interaction.showModal(modal);
    return true;
  }

  // ── Staff reply modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('staff_reply_modal_')) {
    const uid = interaction.customId.replace("staff_reply_modal_", "");
    if (!activeTickets.has(uid)) {
      await interaction.reply({ content: '❌ Ticket no longer active.', ephemeral: true }); return true;
    }
    const user = client.users.cache.get(String(uid)) || await client.users.fetch(String(uid)).catch(() => null);
    if (!user) { await interaction.reply({ content: '❌ User not found.', ephemeral: true }); return true; }
    try {
      const dm = await user.createDM();
      const replyText = interaction.fields.getTextInputValue('reply_text');
      const embed = new EmbedBuilder()
        .setDescription(`**Staff: ${interaction.user.username}** — ${replyText}`)
        .setColor(0x57F287).setTimestamp()
        .setAuthor({ name: 'UH Support Reply', iconURL: interaction.user.displayAvatarURL() });
      await dm.send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Reply sent to **${user.username}**!`, ephemeral: true });
    } catch (_) { await interaction.reply({ content: '❌ Could not DM that user.', ephemeral: true }); }
    return true;
  }

  // ── Close ticket button from log ──
  if (interaction.isButton() && interaction.customId.startsWith('ticket_close_')) {
    const uid = interaction.customId.replace("ticket_close_", "");
    const closing = activeTickets.get(uid);
    if (!await isStaffFor(interaction.member, closing && closing.type)) {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true }); return true;
    }
    if (!closing) {
      await interaction.reply({ content: '❌ Ticket is already closed.', ephemeral: true }); return true;
    }
    activeTickets.delete(uid);
    saveTickets(activeTickets);
    // The row was opened against the ticket's own guild. Closing it against the
    // guild the staff member happened to press the button in would leave the
    // original row open forever and close nothing.
    logTicketClosed(closing.guild_id || interaction.guild.id, uid);
    try {
      const user = client.users.cache.get(String(uid)) || await client.users.fetch(String(uid)).catch(() => null);
      if (user) {
        const dm = await user.createDM();
        await dm.send({ embeds: [new EmbedBuilder().setTitle('✅ Support Session Closed')
          .setDescription('Thanks for using UH support! If you need help again, click a support button in the server.')
          .setColor(0x57F287)] });
      }
    } catch (_) {}
    await interaction.reply({ content: `🔒 Ticket closed by **${interaction.user.username}**.` });
    return true;
  }

  return false;
}

// ─── DM handler (for !close command) ───────────────────────────────────────
async function handleDM(message, client) {
  if (!message.content.startsWith('!close')) return false;
  const uid = message.author.id;
  if (!activeTickets.has(uid)) {
    await message.channel.send('❌ You don\'t have an active support ticket.');
    return true;
  }
  const ticket = activeTickets.get(uid);
  activeTickets.delete(uid);
  saveTickets(activeTickets);
  // DMs have no guild context, so the guild is the one recorded when the ticket
  // opened. GUILD_ID stays as the fallback for tickets saved by an older build,
  // which is the only way this can still close against the wrong server.
  logTicketClosed(ticket.guild_id || process.env.GUILD_ID, uid);

  await message.channel.send({ embeds: [new EmbedBuilder()
    .setTitle('✅ Support Session Closed')
    .setDescription('Thanks for using UH support! If you need help again, click a support button in the server.')
    .setColor(0x57F287)
    .addFields({ name: 'Today at', value: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) })] });

  // Close notice follows the ticket, not the general log — a rank-boost ticket
  // opened in the booster channel must not close in a channel that team
  // cannot see.
  // ...and not the general log of a server this ticket was never opened in:
  // resolveLogChannel refuses an id that does not live in the ticket's guild
  // rather than posting a customer's ticket into whichever server does own it.
  const closeRoute = await routeFor(ticket.type, ticket.guild_id);
  if (closeRoute.channel) {
    const logCh = await resolveLogChannel(client, closeRoute);
    if (logCh) await logCh.send({ embeds: [new EmbedBuilder()
      .setTitle('🔒 Ticket Closed')
      .setDescription(`Ticket for **${message.author.username}** (\`${message.author.id}\`) has been closed by the user.`)
      .setColor(0xFF0000).setTimestamp()
      .addFields({ name: 'Type', value: ticket.type, inline: true }, { name: 'Game', value: ticket.game, inline: true })] });
  }
  return true;
}

// routeFor / isStaffFor are exported for test_ticket_routing.js — the whole
// point of the rank-boost route is that it does NOT reach general staff, and
// that is only worth anything if it's asserted.
module.exports = {
  handleInteraction, handleDM, supportCommands, activeTickets,
  routeFor, isStaffFor, setSupportSettingsProvider, resolveLogChannel,
  RANK_BOOST_LOG_CHANNEL, RANK_BOOST_ROLE_ID,
};
