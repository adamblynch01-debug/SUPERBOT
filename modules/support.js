// ─── DM Support Ticket Module (ported from Python) ─────────────────────────
'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const TICKETS_FILE     = path.join(__dirname, '..', 'tickets.json');
const SUPPORT_CHANNEL  = process.env.SUPPORT_CHANNEL  ? parseInt(process.env.SUPPORT_CHANNEL)  : null;
const TICKET_LOG_CHANNEL = process.env.TICKET_LOG_CHANNEL ? parseInt(process.env.TICKET_LOG_CHANNEL) : null;
const STAFF_ROLE_ID    = process.env.STAFF_ROLE_ID    ? parseInt(process.env.STAFF_ROLE_ID)    : null;

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
      for (const [k, v] of Object.entries(raw)) map.set(parseInt(k), v);
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

// ─── Helpers ───────────────────────────────────────────────────────────────
function isStaff(member) {
  if (!STAFF_ROLE_ID) return member.permissions.has('ManageMessages');
  return member.roles.cache.has(String(STAFF_ROLE_ID));
}

async function sendStaffLog(client, user, ticketData) {
  console.log('[TICKET LOG] TICKET_LOG_CHANNEL:', TICKET_LOG_CHANNEL);
  if (!TICKET_LOG_CHANNEL) { console.log('[TICKET LOG] No channel ID set'); return; }
  const logCh = client.channels.cache.get(String(TICKET_LOG_CHANNEL));
  console.log('[TICKET LOG] Channel found:', logCh ? logCh.name : 'NOT FOUND');
  if (!logCh) { 
    // Try fetching directly
    try { const fetched = await client.channels.fetch(String(TICKET_LOG_CHANNEL)); if (fetched) { console.log('[TICKET LOG] Fetched channel:', fetched.name); } } catch(e) { console.log('[TICKET LOG] Fetch error:', e.message); }
    return; 
  }
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
    content: STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}> New ticket from **${user.username}**` : `New ticket from **${user.username}**`,
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
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('support_hwid').setLabel('HWID Reset').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_purchase').setLabel('Purchase').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_resell').setLabel('Resell').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('support_general').setLabel('🎮 Support').setStyle(ButtonStyle.Primary),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.editReply({ content: '✅ Panel posted!' });
    return true;
  }

  // ── /clearlogs ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearlogs') {
    await interaction.deferReply({ ephemeral: true });
    if (!TICKET_LOG_CHANNEL) { await interaction.editReply({ content: '❌ TICKET_LOG_CHANNEL not configured.' }); return true; }
    const logCh = client.channels.cache.get(String(TICKET_LOG_CHANNEL));
    if (!logCh) { await interaction.editReply({ content: '❌ Could not find ticket logs channel.' }); return true; }
    const msgs = await logCh.messages.fetch({ limit: 200 });
    try { await logCh.bulkDelete(msgs); } catch (_) { for (const [, m] of msgs) try { await m.delete(); } catch (_) {} }
    await interaction.editReply({ content: `Cleared ${msgs.size} messages from ticket logs.` });
    return true;
  }

  // ── /reply ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'reply') {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: '❌ You don\'t have permission.', ephemeral: true }); return true;
    }
    const uid = parseInt(interaction.options.getString('user_id'));
    const msg = interaction.options.getString('message');
    if (!activeTickets.has(uid)) {
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
  const TICKET_TYPES = { support_hwid: 'HWID Reset', support_purchase: 'Purchase', support_resell: 'Resell', support_general: 'Support' };
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

    activeTickets.set(interaction.user.id, { type: ticketType, game, issue: issueText, opened_at: openedAt });
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

    await sendStaffLog(client, interaction.user, { type: ticketType, game, issue: issueText, opened_at: openedAt });

    const reply = await interaction.followUp({ content: '✅ I\'ve sent you a DM! Check your messages to start the support conversation.', ephemeral: true, fetchReply: true });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    return true;
  }

  // ── Quick reply button from log ──
  if (interaction.isButton() && interaction.customId.startsWith('ticket_reply_')) {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true }); return true;
    }
    const uid = parseInt(interaction.customId.replace('ticket_reply_', ''));
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
    const uid = parseInt(interaction.customId.replace('staff_reply_modal_', ''));
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
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true }); return true;
    }
    const uid = parseInt(interaction.customId.replace('ticket_close_', ''));
    if (!activeTickets.has(uid)) {
      await interaction.reply({ content: '❌ Ticket is already closed.', ephemeral: true }); return true;
    }
    activeTickets.delete(uid);
    saveTickets(activeTickets);
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

  await message.channel.send({ embeds: [new EmbedBuilder()
    .setTitle('✅ Support Session Closed')
    .setDescription('Thanks for using UH support! If you need help again, click a support button in the server.')
    .setColor(0x57F287)
    .addFields({ name: 'Today at', value: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) })] });

  if (TICKET_LOG_CHANNEL) {
    const logCh = client.channels.cache.get(String(TICKET_LOG_CHANNEL));
    if (logCh) await logCh.send({ embeds: [new EmbedBuilder()
      .setTitle('🔒 Ticket Closed')
      .setDescription(`Ticket for **${message.author.username}** (\`${message.author.id}\`) has been closed by the user.`)
      .setColor(0xFF0000).setTimestamp()
      .addFields({ name: 'Type', value: ticket.type, inline: true }, { name: 'Game', value: ticket.game, inline: true })] });
  }
  return true;
}

module.exports = { handleInteraction, handleDM, supportCommands, activeTickets };
