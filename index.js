/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          UH SERVICES — SUPER BOT  v2.0.0            ║
 * ║  Combines: Verify/Welcome • Updates • Anti-Scam     ║
 * ║            DM Support • 2FA Auth Server             ║
 * ╚══════════════════════════════════════════════════════╝
 */
'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  PermissionFlagsBits, ChannelType, AttachmentBuilder,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const { createCanvas, loadImage } = require('canvas');

// ─── Modules ─────────────────────────────────────────────────────────────────
const antiscam   = require('./modules/antiscam');
const support    = require('./modules/support');
const { startAuthServer, handle2FAInteraction } = require('./modules/auth2fa');
const { getAllProducts, getProduct, setProductUrl, getProductChunks, getProductByName } = require('./modules/downloads');

// ─── ENV Config ───────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const GUILD_ID       = process.env.GUILD_ID || null;

// Verify/Welcome module
const VERIFIED_ROLE  = process.env.VERIFIED_ROLE_NAME  || 'Verified';
const VERIFY_CHANNEL = process.env.VERIFY_CHANNEL_NAME || 'get-verify';
const WELCOME_CHANNEL= process.env.WELCOME_CHANNEL_NAME|| 'welcome';
const WELCOME_CHANNEL_ID = '1400773021274341396';
const INVITES_CHANNEL= process.env.INVITES_CHANNEL_NAME|| 'invites';
const INVITES_NEEDED = parseInt(process.env.INVITES_NEEDED || '10');

// Updates module
const BOT_NAME  = process.env.BOT_NAME  || 'UH Services';
const SITE_URL  = process.env.SITE_URL  || '';

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in environment variables!');
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Invite Tracking (Verify module) ────────────────────────────────────────
const inviteCache = new Map(); // guildId → Map<code, {inviterId, uses}>
const inviteData  = new Map(); // guildId → Map<userId, {total,real,left,fake,usedKeys}>

function getGuildData(gid) {
  if (!inviteData.has(gid)) inviteData.set(gid, new Map());
  return inviteData.get(gid);
}
function getUserInviteData(gid, uid) {
  const g = getGuildData(gid);
  if (!g.has(uid)) g.set(uid, { total: 0, real: 0, left: 0, fake: 0, usedKeys: 0 });
  return g.get(uid);
}

// ─── Updates module state ────────────────────────────────────────────────────
const PRODUCT_COLORS = [
  0x5865F2,0xEB459E,0x57F287,0xFEE75C,0xED4245,
  0x9B59B6,0x1ABC9C,0xE67E22,0x3498DB,0xE74C3C,
  0x2ECC71,0xF39C12,0x1F8B4C,0x206694,0x71368A,
  0xAD1457,0x11806A,0xC27C0E,0xA84300,0x979C9F,
];
const productColorMap    = {};
let colorIndex           = 0;
const productLastStatus  = {};
const websiteMessages    = {};
const resellerMessages   = {};
const pendingUpdates     = {};
const resellerLinks      = { apply: 'https://uhservicess.netlify.app/', panel: 'https://uhservicess.netlify.app/' };

const UPDATE_TYPES = {
  status_change:  { label: 'Status Change',  emoji: '🔄' },
  maintenance:    { label: 'Maintenance',     emoji: '🛠️' },
  update:         { label: 'Update',          emoji: '⬆️' },
  patch:          { label: 'Patch',           emoji: '🩹' },
  undetected:     { label: 'Undetected',      emoji: '✅' },
  detected:       { label: 'Detected',        emoji: '🚨' },
  disabled:       { label: 'Disabled',        emoji: '⛔' },
  enabled:        { label: 'Enabled',         emoji: '🟢' },
  new_product:    { label: 'New Product',     emoji: '🆕' },
  sale:           { label: 'Sale',            emoji: '💸' },
  bug_fix:        { label: 'Bug Fix',         emoji: '🔧' },
  announcement:   { label: 'Announcement',    emoji: '📣' },
  time_extension: { label: 'Time Extension',  emoji: '🕐' },
  new_feature:    { label: 'New Feature',     emoji: '✨' },
};
const STATUS_TYPES = {
  updating: { emoji: '🔵', label: 'Updating', color: 0x9B59B6 },
  testing:  { emoji: '🟡', label: 'Testing',  color: 0xF1C40F },
  updated:  { emoji: '🟢', label: 'Updated',  color: 0x57F287 },
};

function getProductColor(name) {
  const k = name.toLowerCase().trim();
  if (!(k in productColorMap)) productColorMap[k] = PRODUCT_COLORS[colorIndex++ % PRODUCT_COLORS.length];
  return productColorMap[k];
}

function hasAccess(interaction) {
  const member = interaction.member;
  if (member.permissions.has('Administrator')) return true;
  if (member.roles.cache.some(r => r.name === 'MODERATOR')) return true;
  return false;
}

function autoDelete(interaction, ms) {
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

function parseStatusTransition(raw) {
  const parts = raw.split(/→|->|>|\bto\b|\//).map(p => p.trim());
  if (parts.length === 2) return { old: STATUS_TYPES[parts[0]] || null, new: STATUS_TYPES[parts[1]] || null };
  if (parts.length === 1) return { old: null, new: STATUS_TYPES[parts[0]] || null };
  return { old: null, new: null };
}

// ─── Welcome Card ────────────────────────────────────────────────────────────
async function createWelcomeCard(member) {
  const W = 600, H = 400;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);
  const teal = '#00e5ff', arm = 55, pad = 18;
  ctx.strokeStyle = teal; ctx.lineWidth = 6; ctx.lineCap = 'square';
  ctx.beginPath(); ctx.moveTo(pad,pad+arm); ctx.lineTo(pad,pad); ctx.lineTo(pad+arm,pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,pad); ctx.lineTo(W-pad,pad); ctx.lineTo(W-pad,pad+arm); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad,H-pad-arm); ctx.lineTo(pad,H-pad); ctx.lineTo(pad+arm,H-pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W-pad-arm,H-pad); ctx.lineTo(W-pad,H-pad); ctx.lineTo(W-pad,H-pad-arm); ctx.stroke();
  const pillText = `Member #${member.guild.memberCount}`;
  ctx.font = 'bold 16px Arial';
  const tw = ctx.measureText(pillText).width;
  const pillW = tw+36, pillH = 30, pillX = (W-pillW)/2, pillY = 22;
  ctx.fillStyle = '#2c2c4a'; ctx.beginPath(); ctx.roundRect(pillX,pillY,pillW,pillH,15); ctx.fill();
  ctx.fillStyle = '#cccccc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(pillText, W/2, pillY+pillH/2);
  const cx = W/2, cy = 195, r = 70;
  try {
    const avatar = await loadImage(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
    ctx.beginPath(); ctx.arc(cx,cy,r+4,0,Math.PI*2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
    ctx.drawImage(avatar,cx-r,cy-r,r*2,r*2); ctx.restore();
  } catch (_) { ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle='#5865f2'; ctx.fill(); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px Arial'; ctx.fillText(`Welcome ${member.user.username}`, W/2, 300);
  ctx.fillStyle = '#aaaaaa'; ctx.font = '20px Arial'; ctx.fillText('to', W/2, 328);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 24px Arial'; ctx.fillText(member.guild.name, W/2, 360);
  return canvas.toBuffer('image/png');
}

// ─── Slash Commands ───────────────────────────────────────────────────────────
const ownCommands = [
  // Verify module
  new SlashCommandBuilder().setName('setup-verify').setDescription('Sets up the verification channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('post-video').setDescription('Post a video embed in this channel')
    .addStringOption(o => o.setName('url').setDescription('Streamable or YouTube URL').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Optional title').setRequired(false)),
  new SlashCommandBuilder().setName('setup-invites').setDescription('Sets up the invite reward channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // Updates module
  new SlashCommandBuilder().setName('postupdate').setDescription('Open the product update form'),
  new SlashCommandBuilder().setName('announce').setDescription('Send a custom announcement to any channel'),
  new SlashCommandBuilder().setName('downloads').setDescription('Browse and download products'),
  new SlashCommandBuilder().setName('setdownload').setDescription('Admin: Set or update a download link for a product')
    .addStringOption(o => o.setName('product').setDescription('Product name').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('url').setDescription('Download URL').setRequired(true)),
  new SlashCommandBuilder().setName('setupdownloads').setDescription('Admin: Post the download panel to #downloads'),
  new SlashCommandBuilder().setName('setwebsite').setDescription('Admin: Set or update the website URL')
    .addStringOption(o => o.setName('url').setDescription('Full website URL').setRequired(true)),
  new SlashCommandBuilder().setName('statusupdate').setDescription('Post a status update to #status-updates'),
  new SlashCommandBuilder().setName('setupreseller').setDescription('Admin: Post the reseller program panel'),
  new SlashCommandBuilder().setName('postimage').setDescription('Admin: Post an image with an optional message')
    .addAttachmentOption(o => o.setName('image').setDescription('Image to post').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Optional message').setRequired(false))
    .addStringOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(false)),
  new SlashCommandBuilder().setName('setresellerlinks').setDescription('Admin: Update Apply and Preview Panel button links'),
  new SlashCommandBuilder().setName('commands').setDescription('Show all available bot commands'),
].map(c => c.toJSON());

// Merge with support module commands
const allCommands = [...ownCommands, ...support.supportCommands];

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  ✅ UH SUPER BOT online            ║`);
  console.log(`║  Logged in as: ${client.user.tag.padEnd(19)}║`);
  console.log(`╚════════════════════════════════════╝\n`);

  // Cache guild invites
  for (const [, guild] of client.guilds.cache) {
    try {
      const inv = await guild.invites.fetch();
      const cache = new Map();
      inv.forEach(i => cache.set(i.code, { inviterId: i.inviter?.id, uses: i.uses }));
      inviteCache.set(guild.id, cache);
    } catch (_) {}
  }

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('📋 Registering slash commands...');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommands });
      console.log(`✅ Guild commands registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: allCommands });
      console.log('✅ Global slash commands registered');
    }
  } catch (err) { console.error('Failed to register commands:', err); }

  // Start 2FA auth server
  startAuthServer(client);

  await client.user.setActivity('for scams 🛡️', { type: 3 }); // Watching
});

// ─── Invite tracking ─────────────────────────────────────────────────────────
client.on('inviteCreate', inv => {
  const cache = inviteCache.get(inv.guild.id) || new Map();
  cache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses });
  inviteCache.set(inv.guild.id, cache);
});
client.on('inviteDelete', inv => {
  const cache = inviteCache.get(inv.guild.id);
  if (cache) cache.delete(inv.code);
});

// ─── Member Join ─────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  // Track invite
  try {
    const newInvites = await member.guild.invites.fetch();
    const oldCache   = inviteCache.get(member.guild.id) || new Map();
    let inviterId = null;
    newInvites.forEach(inv => {
      const old = oldCache.get(inv.code);
      if (old && inv.uses > old.uses) inviterId = old.inviterId;
    });
    const newCache = new Map();
    newInvites.forEach(inv => newCache.set(inv.code, { inviterId: inv.inviter?.id, uses: inv.uses }));
    inviteCache.set(member.guild.id, newCache);
    if (inviterId) {
      const d = getUserInviteData(member.guild.id, inviterId);
      d.total++; d.real++;
    }
  } catch (_) {}

  // DM new member
  try {
    await member.send(
      `👋 Welcome to **${member.guild.name}**!\n\nPlease head to **#${VERIFY_CHANNEL}** and click **Verify Me** to access the server.`
    );
  } catch (_) {}

  // Welcome card
  try {
    const welcomeCh = member.guild.channels.cache.get(WELCOME_CHANNEL_ID) || member.guild.channels.cache.find(c => c.name === WELCOME_CHANNEL && c.type === ChannelType.GuildText);
    if (!welcomeCh) return;
    const buf = await createWelcomeCard(member);
    await welcomeCh.send({
      content: `Welcome <@${member.user.id}> to **${member.guild.name}**! 🎉`,
      files: [new AttachmentBuilder(buf, { name: 'welcome.png' })],
    });
  } catch (err) { console.error('Welcome card error:', err); }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  // DM support (support module handles !close in DMs)
  if (message.channel.type === ChannelType.DM) {
    await support.handleDM(message, client);
    return;
  }
  // Anti-scam prefix commands
  if (message.content.startsWith('!')) {
    const handled = await antiscam.handlePrefixCommand(message, client);
    if (handled) return;
  }
  // Anti-scam scanning (runs on all non-admin messages)
  await antiscam.onMessage(message, client);
});

// ─── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    // 2FA button
    if (await handle2FAInteraction(interaction)) return;
    // Support module interactions
    if (await support.handleInteraction(interaction, client)) return;
    // Autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'setdownload') {
      const focused = interaction.options.getFocused().toLowerCase();
      return interaction.respond(
        getAllProducts().filter(p => p.name.toLowerCase().includes(focused)).slice(0, 25).map(p => ({ name: p.name, value: p.id }))
      );
    }

    // ── Slash commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // ── /commands ──────────────────────────────────────────────────────────
      if (cmd === 'commands') {
        const embed = new EmbedBuilder()
          .setTitle('🤖 UH Super Bot — All Commands').setColor(0x5865F2)
          .addFields(
            { name: '🔐 Verification & Invites', value: '`/setup-verify` — Set up verification channel\n`/setup-invites` — Set up invite reward channel', inline: false },
            { name: '📦 Products & Downloads', value: '`/downloads` — Browse & download products\n`/setupdownloads` — Post download panel to #downloads\n`/setdownload` — Set a product download link', inline: false },
            { name: '📣 Updates & Status', value: '`/postupdate` — Post a product update\n`/statusupdate` — Post a status update\n`/announce` — Send a custom announcement', inline: false },
            { name: '🌐 Server Setup', value: '`/setwebsite` — Pin website URL\n`/setupreseller` — Post reseller panel\n`/setresellerlinks` — Update reseller button links\n`/postimage` — Post an image', inline: false },
            { name: '🎫 Support Tickets', value: '`/panel` — Post the support panel\n`/clearlogs` — Clear ticket log channel\n`/reply` — Reply to a user\'s ticket', inline: false },
            { name: '🛡️ Anti-Scam (Prefix)', value: '`!bothelp` — Anti-scam command list\n`!manage` — Management panel\n`!scamcheck <text>` — Test message\n`!warnings / !clearwarnings` — Warning system\n`!nuke` — Wipe channel\n`!addlink / !removelink / !listlinks` — Manage banned links\n`!addword / !removeword` — Manage profanity filter', inline: false },
            { name: '💬 DM Commands', value: '`!close` — Close your support ticket (type in DM)', inline: false },
          )
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // ── /post-video ────────────────────────────────────────────────────────
      if (cmd === 'post-video') {
        const url = interaction.options.getString('url');
        const title = interaction.options.getString('title') || '▶ Video';
        let embed;
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
          const videoId = url.includes('youtu.be')
            ? url.split('youtu.be/')[1]?.split('?')[0]
            : url.split('v=')[1]?.split('&')[0];
          embed = new EmbedBuilder()
            .setTitle(title).setURL(url)
            .setImage(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`)
            .setColor(0xFF0000).setFooter({ text: '▶ Click to watch on YouTube' });
        } else {
          embed = new EmbedBuilder()
            .setTitle(title).setURL(url)
            .setColor(0x00ADEF);
        }
        await interaction.reply({ content: '✅ Posted!', flags: 64 });
        await interaction.channel.send({ embeds: [embed] });
        return;
      }

      // ── /setup-verify ──────────────────────────────────────────────────────
      if (cmd === 'setup-verify') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        let verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE);
        if (!verifiedRole) verifiedRole = await guild.roles.create({ name: VERIFIED_ROLE, color: 0x5865f2 });
        const everyoneRole = guild.roles.everyone;
        const botRole = guild.members.me.roles.highest;
        await guild.channels.fetch();
        // Channel IDs that Verified role is allowed to see (besides get-verify)
        const VERIFIED_ALLOWED_IDS = [
          '1481172050801463367', // support channel
          '1242139449320804393', // Support 1 voice
        ];
        for (const [, ch] of guild.channels.cache) {
          if (ch.name === VERIFY_CHANNEL) continue;
          try {
            await ch.permissionOverwrites.edit(everyoneRole, { ViewChannel: false, SendMessages: false });
            await ch.permissionOverwrites.edit(botRole, { ViewChannel: true, SendMessages: true });
            if (VERIFIED_ALLOWED_IDS.includes(ch.id)) {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: true });
            } else {
              await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: false });
            }
          } catch (_) {}
        }
        let verifyCh = guild.channels.cache.find(c => c.name === VERIFY_CHANNEL && c.type === ChannelType.GuildText);
        if (!verifyCh) verifyCh = await guild.channels.create({ name: VERIFY_CHANNEL, type: ChannelType.GuildText });
        await verifyCh.permissionOverwrites.edit(everyoneRole, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true });
        await verifyCh.permissionOverwrites.edit(verifiedRole, { ViewChannel: true, SendMessages: false });
        try { const msgs = await verifyCh.messages.fetch({ limit: 10 }); await verifyCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🔐 Verify to Access the Server')
          .setDescription('Welcome! To gain access to all channels, click the **Verify** button below.\n\nBy verifying, you agree to follow our server rules.')
          .setColor(0x5865f2).setFooter({ text: 'Click once — verification is instant!' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Primary)
        );
        await verifyCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Done!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /setup-invites ────────────────────────────────────────────────────
      if (cmd === 'setup-invites') {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        let invCh = guild.channels.cache.find(c => c.name === INVITES_CHANNEL && c.type === ChannelType.GuildText);
        if (!invCh) invCh = await guild.channels.create({ name: INVITES_CHANNEL, type: ChannelType.GuildText });
        await invCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        try { const msgs = await invCh.messages.fetch({ limit: 10 }); await invCh.bulkDelete(msgs); } catch (_) {}
        const embed = new EmbedBuilder()
          .setTitle('🎉 Invite Your Friends & Earn Rewards!')
          .setDescription(`Invite your friends and earn **free keys**!\n\n**How it works:**\n1️⃣ Click **Your Invite Link** to get your link\n2️⃣ Share it with friends\n3️⃣ Once you have **${INVITES_NEEDED} real invites**, click **Redeem Your Key**!\n\nRedeem **unlimited times** — every ${INVITES_NEEDED} invites = 1 free key 🔑\n\n⚠️ *Fake invites & users who leave don't count!*`)
          .setColor(0x5865f2).setTimestamp().setFooter({ text: 'Invite Reward System' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('get_invite_link').setLabel('🔗 Your Invite Link').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('check_invites').setLabel('📊 Check Your Invites').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('redeem_key').setLabel('🎁 Redeem Your Key').setStyle(ButtonStyle.Success),
        );
        await invCh.send({ embeds: [embed], components: [row] });
        await interaction.editReply('✅ Invite system set up!'); autoDelete(interaction, 5000);
        return;
      }

      // ── /postupdate ────────────────────────────────────────────────────────
      if (cmd === 'postupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const select = new StringSelectMenuBuilder()
          .setCustomId('select_update_type').setPlaceholder('Select update type...')
          .addOptions(Object.entries(UPDATE_TYPES).map(([val, { label, emoji }]) =>
            new StringSelectMenuOptionBuilder().setLabel(label).setValue(val).setEmoji(emoji)
          ));
        await interaction.reply({ content: '### 📋 New Product Update\nSelect the **update type** to continue:', components: [new ActionRowBuilder().addComponents(select)], flags: 64 });
        autoDelete(interaction, 60000);
        return;
      }

      // ── /announce ──────────────────────────────────────────────────────────
      if (cmd === 'announce') {
        const modal = new ModalBuilder().setCustomId('announce_modal').setTitle('📣 New Announcement');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_title').setLabel('TITLE').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_message').setLabel('MESSAGE').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_media').setLabel('IMAGE / VIDEO URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setPlaceholder('https://streamable.com/... or https://i.imgur.com/...')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_channel').setLabel('POST TO CHANNEL (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce_ping').setLabel('PING (everyone / here / role name)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }

      // ── /downloads ────────────────────────────────────────────────────────
      if (cmd === 'downloads') {
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        await interaction.reply({
          content: '### Product Downloads\nSelect your product below:',
          components: [
            new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
            new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
          ],
          flags: 64,
        });
        autoDelete(interaction, 120000);
        return;
      }

      // ── /setupdownloads ───────────────────────────────────────────────────
      if (cmd === 'setupdownloads') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const dlCh = interaction.guild.channels.cache.find(c => c.name === 'downloads' && c.type === ChannelType.GuildText) || interaction.channel;
        const chunks = getProductChunks();
        const makeMenu = (id, placeholder, chunk) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
          .addOptions(chunk.map(p => ({ label: p.name.length > 100 ? p.name.slice(0,97)+'...' : p.name, value: p.id, description: p.url ? 'Download available' : 'Coming soon' })));
        const embed = new EmbedBuilder().setTitle('📦  PRODUCT DOWNLOADS').setColor(0x5865F2)
          .setDescription('> Select your product from the dropdown below and click **DOWNLOAD** to get your file.')
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        await dlCh.send({ embeds: [embed], components: [
          new ActionRowBuilder().addComponents(makeMenu('dl_page_1', 'Products A-F  (Page 1 of 3)', chunks[0] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_2', 'Products G-R  (Page 2 of 3)', chunks[1] || [])),
          new ActionRowBuilder().addComponents(makeMenu('dl_page_3', 'Products S-Z + HWID  (Page 3 of 3)', chunks[2] || [])),
        ]});
        await interaction.reply({ content: `✅ Download panel posted in <#${dlCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setdownload ──────────────────────────────────────────────────────
      if (cmd === 'setdownload') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const productId = interaction.options.getString('product');
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const product = getProduct(productId);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        setProductUrl(productId, url);
        await interaction.reply({ content: `✅ Download link updated for **${product.name}**\n🔗 ${url}`, flags: 64 });
        autoDelete(interaction, 8000);
        return;
      }

      // ── /setwebsite ───────────────────────────────────────────────────────
      if (cmd === 'setwebsite') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        let url = interaction.options.getString('url').trim();
        if (url && !url.startsWith('http')) url = 'https://' + url;
        const wsCh = interaction.guild.channels.cache.find(c => c.name.toLowerCase().includes('website') && c.type === ChannelType.GuildText) || interaction.channel;
        const displayUrl = url.replace(/^https?:\/\//, '');
        const embed = new EmbedBuilder().setDescription(`### [${displayUrl}](${url})`).setColor(0x5865F2).setTimestamp();
        const gKey = interaction.guild.id;
        const existing = websiteMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ content: '', embeds: [embed] });
            await interaction.reply({ content: `✅ Website updated to **${url}** in <#${existing.channelId}>`, flags: 64 }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await wsCh.send({ content: '', embeds: [embed] });
        websiteMessages[gKey] = { channelId: wsCh.id, messageId: msg.id };
        await interaction.reply({ content: `📌 Website posted in <#${wsCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /postimage ────────────────────────────────────────────────────────
      if (cmd === 'postimage') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const attachment = interaction.options.getAttachment('image');
        const message    = interaction.options.getString('message') || null;
        const chanName   = interaction.options.getString('channel') || null;
        let targetCh = interaction.channel;
        if (chanName) {
          const found = interaction.guild.channels.cache.find(c => c.name.toLowerCase() === chanName.toLowerCase().replace('#','') && c.type === ChannelType.GuildText);
          if (found) targetCh = found;
        }
        await targetCh.send({ content: message, files: [attachment.url] });
        await interaction.reply({ content: `✅ Image posted to <#${targetCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setupreseller ────────────────────────────────────────────────────
      if (cmd === 'setupreseller') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const resCh = interaction.guild.channels.cache.find(c => c.name.toLowerCase().includes('reseller') && c.type === ChannelType.GuildText) || interaction.channel;
        const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(
          '# UH SERVICES IS LOOKING FOR RESELLERS\n\n**Did you know you can make up to $5000+ monthly reselling our products?**\n\n## Why Start Reselling?\n- All keys are bought through our **centralized panel**, where you can **generate, manage, reset, and freeze keys**\n- We provide **10+** of the **markets leading products**\n- We offer all of our resellers a **minimum discount of 50% off keys** right away\n- We take care of the hard part. **Development, testing, updates, and more are all handled by us**\n- We offer **priority support** in your personal ticket\n- We provide **tips on how to grow and expand** your brand\n- We offer **dynamic delivery** so you can link your site to our panel for seamless product delivery\n- **Pressure free environment**, we don\'t force you to deposit\n- Access to a community of over **100+ successful resellers**'
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(resellerLinks.apply),
          new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(resellerLinks.panel),
        );
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            await msg.edit({ embeds: [embed], components: [row] });
            await interaction.editReply({ content: `✅ Reseller panel updated in <#${existing.channelId}>` }); autoDelete(interaction, 5000); return;
          } catch (_) {}
        }
        const msg = await resCh.send({ embeds: [embed], components: [row] });
        resellerMessages[gKey] = { channelId: resCh.id, messageId: msg.id };
        await interaction.editReply({ content: `✅ Reseller panel posted in <#${resCh.id}>` }); autoDelete(interaction, 5000);
        return;
      }

      // ── /setresellerlinks ─────────────────────────────────────────────────
      if (cmd === 'setresellerlinks') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('reseller_links_modal').setTitle('Update Reseller Button Links');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_apply_url').setLabel('APPLY HERE! — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.apply).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reseller_panel_url').setLabel('Preview Panel — Button URL').setStyle(TextInputStyle.Short).setValue(resellerLinks.panel).setRequired(true)),
        );
        return interaction.showModal(modal);
      }

      // ── /statusupdate ─────────────────────────────────────────────────────
      if (cmd === 'statusupdate') {
        if (!hasAccess(interaction)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
        const modal = new ModalBuilder().setCustomId('setstatus_modal').setTitle('Status Update');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_product').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_status').setLabel('STATUS (e.g. updated -> updating)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_notes').setLabel('NOTES (optional, separate with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ss_ping').setLabel('PING ROLE (name or ID, optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
        );
        return interaction.showModal(modal);
      }
    }

    // ── Select menus ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      // Update type selected
      if (interaction.customId === 'select_update_type') {
        const typeKey  = interaction.values[0];
        const typeInfo = UPDATE_TYPES[typeKey];
        pendingUpdates[interaction.user.id] = { typeKey };
        const isTimeExt = typeKey === 'time_extension' || typeKey === 'new_feature';
        const modal = new ModalBuilder().setCustomId('update_modal').setTitle(`${typeInfo.emoji} ${typeInfo.label} — Product Update`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('product_name').setLabel('PRODUCT NAME').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('status_transition').setLabel(isTimeExt ? 'TIME ADDED (e.g. 12 hours, 3 days)' : 'STATUS (e.g. updating → updated)').setStyle(TextInputStyle.Short).setRequired(isTimeExt).setMaxLength(40)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('NOTES (separate bullet points with |)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('custom_title').setLabel('CUSTOM TITLE (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('IMAGE URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
        );
        await interaction.showModal(modal);
        try { await interaction.deleteReply(); } catch (_) {}
        return;
      }

      // Download page select
      if (['dl_page_1','dl_page_2','dl_page_3'].includes(interaction.customId)) {
        const product = getProduct(interaction.values[0]);
        if (!product) return interaction.reply({ content: '❌ Product not found.', flags: 64 });
        const embed = new EmbedBuilder().setTitle(`📦  ${product.name}`).setColor(0x57F287)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (product.url) {
          embed.setDescription('Your download is ready! Click the button below.');
          const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(product.url).setStyle(ButtonStyle.Link));
          await interaction.reply({ embeds: [embed], components: [btn], flags: 64 });
        } else {
          embed.setDescription('Download link not yet available. Check back soon or contact support.');
          await interaction.reply({ embeds: [embed], flags: 64 });
        }
        autoDelete(interaction, 60000);
        return;
      }
    }

    // ── Buttons ───────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId, guild, member } = interaction;

      // Verify button
      if (customId === 'verify_button') {
        const verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE);
        if (!verifiedRole) { await interaction.reply({ content: '⚠️ Verified role not found.', ephemeral: true }); autoDelete(interaction, 5000); return; }
        if (member.roles.cache.has(verifiedRole.id)) { await interaction.reply({ content: '✅ You are already verified!', ephemeral: true }); autoDelete(interaction, 5000); return; }
        try { await member.roles.add(verifiedRole); await interaction.reply({ content: '🎉 You have been verified! Welcome!', ephemeral: true }); autoDelete(interaction, 5000); }
        catch (_) { await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Get invite link
      if (customId === 'get_invite_link') {
        try {
          const invCh = guild.channels.cache.find(c => c.name === INVITES_CHANNEL && c.type === ChannelType.GuildText) || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
          const invite = await invCh.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Invite link for ${member.user.tag}` });
          const cache = inviteCache.get(guild.id) || new Map();
          cache.set(invite.code, { inviterId: member.user.id, uses: 0 });
          inviteCache.set(guild.id, cache);
          const embed = new EmbedBuilder().setTitle('🔗 Your Personal Invite Link')
            .setDescription(`Your **permanent** invite link:\n\n**https://discord.gg/${invite.code}**\n\nEvery **${INVITES_NEEDED} real invites** = 1 free key 🔑\nThis link never expires and is unique to you!`)
            .setColor(0x5865f2).setTimestamp();
          await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        } catch (_) { await interaction.reply({ content: '❌ Could not create invite.', ephemeral: true }); autoDelete(interaction, 5000); }
        return;
      }

      // Check invites
      if (customId === 'check_invites') {
        const data = getUserInviteData(guild.id, member.user.id);
        const available = Math.floor(data.real / INVITES_NEEDED) - data.usedKeys;
        const filled = Math.min(data.real % INVITES_NEEDED, INVITES_NEEDED);
        const bar = '█'.repeat(filled) + '░'.repeat(INVITES_NEEDED - filled);
        const next = data.real % INVITES_NEEDED === 0 && data.real > 0 ? 'Ready to redeem! 🎁' : `${INVITES_NEEDED - (data.real % INVITES_NEEDED)} more needed`;
        const embed = new EmbedBuilder().setTitle('📊 Your Invite Stats')
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }))
          .setDescription(`**Progress:**\n${bar} ${data.real % INVITES_NEEDED}/${INVITES_NEEDED}\n\n**Next Reward:** ${next}\n\n📨 **Total** — ${data.total}\n✅ **Real** — ${data.real}\n🎁 **Available Keys** — ${available}\n🔑 **Used Keys** — ${data.usedKeys}\n👋 **Left** — ${data.left}\n🚫 **Fake** — ${data.fake}`)
          .setColor(0x5865f2).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        return;
      }

      // Redeem key
      if (customId === 'redeem_key') {
        const data = getUserInviteData(guild.id, member.user.id);
        const available = Math.floor(data.real / INVITES_NEEDED) - data.usedKeys;
        if (available <= 0) {
          const needed = INVITES_NEEDED - (data.real % INVITES_NEEDED);
          await interaction.reply({ content: `❌ Need **${INVITES_NEEDED} invites**. You have **${data.real}**. ${needed} more needed!`, ephemeral: true }); autoDelete(interaction, 5000); return;
        }
        data.usedKeys++;
        const embed = new EmbedBuilder().setTitle('🎁 Key Redeemed!')
          .setDescription(`✅ You have successfully redeemed **1 key**!\n\nPlease open a **support ticket** or DM an admin to claim your reward.\n\n🔑 Keys used: **${data.usedKeys}**\n🎁 Keys remaining: **${available - 1}**`)
          .setColor(0x00e5ff).setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true }); autoDelete(interaction, 30000);
        console.log(`🎁 ${member.user.tag} redeemed a key!`);
        return;
      }
    }

    // ── Modal submits ─────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      // Update modal
      if (interaction.customId === 'update_modal') {
        const product     = interaction.fields.getTextInputValue('product_name').trim();
        const notesRaw    = interaction.fields.getTextInputValue('notes');
        const customTitle = interaction.fields.getTextInputValue('custom_title').trim();
        let imageUrl      = interaction.fields.getTextInputValue('image_url').trim();
        if (imageUrl && !imageUrl.startsWith('http')) imageUrl = 'https://' + imageUrl;
        const statusRaw   = interaction.fields.getTextInputValue('status_transition').trim().toLowerCase();
        const pending = pendingUpdates[interaction.user.id] || {};
        const typeKey = pending.typeKey || 'update';
        const typeInfo = UPDATE_TYPES[typeKey] || { label: typeKey, emoji: '📢' };
        delete pendingUpdates[interaction.user.id];

        let oldStatus = null, newStatus = null;
        if (statusRaw && typeKey !== 'time_extension' && typeKey !== 'new_feature') {
          const { old, new: ns } = parseStatusTransition(statusRaw);
          oldStatus = old; newStatus = ns;
          if (!oldStatus) { const lk = productLastStatus[product.toLowerCase()]; if (lk) oldStatus = STATUS_TYPES[lk] === ns ? null : STATUS_TYPES[lk]; }
        }
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }

        const notes = notesRaw ? notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n') : null;
        const embedColor = newStatus ? newStatus.color : getProductColor(product);
        const fields = [
          { name: 'Product', value: `\`${product}\``, inline: false },
          { name: 'Type',    value: `${typeInfo.emoji}  ${typeInfo.label}`, inline: false },
        ];
        if ((typeKey === 'time_extension' || typeKey === 'new_feature') && statusRaw) fields.push({ name: 'Time Added', value: statusRaw, inline: false });
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: true }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: true }); }
        else if (newStatus) fields.push({ name: 'Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notes) fields.push({ name: 'Notes', value: notes, inline: false });

        const embed = new EmbedBuilder()
          .setTitle((customTitle ? customTitle.toUpperCase() : product.toUpperCase()))
          .setColor(embedColor).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (imageUrl) embed.setThumbnail(imageUrl);

        const productData = getProductByName(product);
        const downloadUrl = productData ? (productData.url || '') : '';
        const buttonRow = downloadUrl ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('⬇️  DOWNLOAD').setURL(downloadUrl).setStyle(ButtonStyle.Link)) : null;
        const payload = { embeds: [embed], ...(buttonRow ? { components: [buttonRow] } : {}) };
        try {
          await interaction.channel.send(payload);
          await interaction.reply({ content: `✅ Update posted to <#${interaction.channel.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Announce modal
      if (interaction.customId === 'announce_modal') {
        await interaction.deferReply({ flags: 64 });
        const title    = interaction.fields.getTextInputValue('announce_title').trim();
        const message  = interaction.fields.getTextInputValue('announce_message').trim();
        const chanName = interaction.fields.getTextInputValue('announce_channel').trim();
        const pingStr  = interaction.fields.getTextInputValue('announce_ping').trim();
        let mediaUrl   = interaction.fields.getTextInputValue('announce_media').trim();
        if (mediaUrl && !mediaUrl.startsWith('http')) mediaUrl = 'https://' + mediaUrl;

        let targetCh = interaction.channel;
        if (chanName) { const f = interaction.guild.channels.cache.find(c => c.name === chanName.replace('#','') || c.id === chanName); if (f) targetCh = f; }

        let pingText = '';
        if (pingStr) {
          const clean = pingStr.replace('@','').trim().toLowerCase();
          if (clean === 'everyone') pingText = '@everyone';
          else if (clean === 'here') pingText = '@here';
          else { const rm = pingStr.match(/\d+/); if (rm) pingText = `<@&${rm[0]}>`; else { const r = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === clean); if (r) pingText = `<@&${r.id}>`; } }
        }

        // Detect if media is an image or video
        const isImage = mediaUrl && /\.(png|jpg|jpeg|gif|webp)$/i.test(mediaUrl);
        const isVideo = mediaUrl && (mediaUrl.includes('streamable.com') || mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be'));

        const embed = new EmbedBuilder().setColor(0x5865F2);
        if (title) embed.setTitle(title);
        embed.setDescription(message).setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        if (isImage) embed.setImage(mediaUrl);

        const components = [];
        if (isVideo) {
          components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('▶️ Watch Video').setURL(mediaUrl).setStyle(ButtonStyle.Link)
          ));
        }

        try {
          await targetCh.send({ content: pingText || null, embeds: [embed], ...(components.length ? { components } : {}) });
          await interaction.editReply({ content: `✅ Announcement posted to <#${targetCh.id}>` }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.editReply({ content: `❌ Failed: ${err.message}` }); autoDelete(interaction, 8000); }
        return;
      }

      // Status update modal
      if (interaction.customId === 'setstatus_modal') {
        const product   = interaction.fields.getTextInputValue('ss_product').trim();
        const statusRaw = interaction.fields.getTextInputValue('ss_status').trim().toLowerCase();
        const notesRaw  = interaction.fields.getTextInputValue('ss_notes').trim();
        const pingStr   = interaction.fields.getTextInputValue('ss_ping').trim();
        const { old: oldStatus, new: newStatus } = parseStatusTransition(statusRaw);
        if (newStatus) { const nk = Object.keys(STATUS_TYPES).find(k => STATUS_TYPES[k] === newStatus); if (nk) productLastStatus[product.toLowerCase()] = nk; }
        const fields = [{ name: 'Product', value: `\`${product.toUpperCase()}\``, inline: false }];
        if (oldStatus && newStatus) { fields.push({ name: 'Changed from', value: `${oldStatus.emoji}  ${oldStatus.label}`, inline: false }, { name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false }); }
        else if (newStatus) fields.push({ name: 'New Status', value: `${newStatus.emoji}  ${newStatus.label}`, inline: false });
        if (notesRaw) fields.push({ name: 'Notes', value: notesRaw.split('|').map(n => `• ${n.trim()}`).join('\n'), inline: false });
        const embed = new EmbedBuilder().setTitle('Status Change').setColor(getProductColor(product)).addFields(fields)
          .setFooter({ text: `${BOT_NAME} | ${SITE_URL}`, iconURL: client.user.displayAvatarURL() }).setTimestamp();
        const statusCh = interaction.guild.channels.cache.find(c => c.name.toLowerCase().replace(/[^a-z0-9]/g,'') === 'statusupdates' && c.type === ChannelType.GuildText) || interaction.channel;
        let pingText = '';
        if (pingStr) { const clean = pingStr.replace('@','').trim().toLowerCase(); if (clean==='everyone') pingText='@everyone'; else if (clean==='here') pingText='@here'; else { const rm=pingStr.match(/\d+/); if(rm) pingText=`<@&${rm[0]}>`; else { const r=interaction.guild.roles.cache.find(r=>r.name.toLowerCase()===clean); if(r) pingText=`<@&${r.id}>`; } } }
        try {
          await statusCh.send({ content: pingText || null, embeds: [embed] });
          await interaction.reply({ content: `✅ Status update posted to <#${statusCh.id}>`, flags: 64 }); autoDelete(interaction, 5000);
        } catch (err) { await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: 64 }); autoDelete(interaction, 8000); }
        return;
      }

      // Reseller links modal
      if (interaction.customId === 'reseller_links_modal') {
        let applyUrl = interaction.fields.getTextInputValue('reseller_apply_url').trim();
        let panelUrl = interaction.fields.getTextInputValue('reseller_panel_url').trim();
        if (applyUrl && !applyUrl.startsWith('http')) applyUrl = 'https://' + applyUrl;
        if (panelUrl && !panelUrl.startsWith('http')) panelUrl = 'https://' + panelUrl;
        resellerLinks.apply = applyUrl; resellerLinks.panel = panelUrl;
        const gKey = interaction.guild.id;
        const existing = resellerMessages[gKey];
        if (existing) {
          try {
            const ch = await client.channels.fetch(existing.channelId);
            const msg = await ch.messages.fetch(existing.messageId);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('APPLY HERE!').setEmoji('📋').setStyle(ButtonStyle.Link).setURL(applyUrl),
              new ButtonBuilder().setLabel('Preview Panel').setEmoji('👀').setStyle(ButtonStyle.Link).setURL(panelUrl),
            );
            await msg.edit({ components: [row] });
          } catch (_) {}
        }
        await interaction.reply({ content: `✅ Links updated!\n**Apply:** ${applyUrl}\n**Panel:** ${panelUrl}`, flags: 64 }); autoDelete(interaction, 8000);
        return;
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: '❌ An error occurred.', flags: 64 });
      else await interaction.reply({ content: '❌ An error occurred.', flags: 64 });
    } catch (_) {}
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
