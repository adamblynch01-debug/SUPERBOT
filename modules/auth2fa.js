// ─── 2FA Auth REST Server Module ─────────────────────────────────────────────
'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory sessions: sessionId → { email, discordId, verified, expiresAt }
const pendingSessions = new Map();

// Same format index.js's /genkey uses — kept in sync manually since this
// module doesn't import index.js's internals.
function parseDurationForApi(raw) {
  const m = (raw || '').trim().toLowerCase().match(/^(\d+)\s*([mhdw])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n <= 0) return null;
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * unitMs[m[2]];
}

// ─── Discord interaction handler (call this from main index.js) ─────────────
async function handle2FAInteraction(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith('auth_')) return false;

  const sessionId = interaction.customId.replace('auth_', '');
  const session   = pendingSessions.get(sessionId);

  if (!session) {
    await interaction.reply({ content: '❌ Session expired or not found. Please log in again.', ephemeral: true });
    return true;
  }
  if (Date.now() > session.expiresAt) {
    pendingSessions.delete(sessionId);
    await interaction.reply({ content: '❌ This verification request has expired. Please log in again.', ephemeral: true });
    return true;
  }

  session.verified = true;
  pendingSessions.set(sessionId, session);

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('✅ Authentication Successful')
      .setDescription('You have been verified. You can now return to the website — you will be logged in automatically.')
      .setFooter({ text: 'UH SERVICES • Security' })
      .setTimestamp()],
    components: [],
  });
  console.log(`✅ User ${session.discordId} authenticated via Discord 2FA`);
  return true;
}

// ─── Start the HTTP server ──────────────────────────────────────────────────
// `issueKey` is passed in from index.js — it owns keysData/generateKeyString/
// saveKeys, this module just exposes an authenticated HTTP door to it.
function startAuthServer(discordClient, { issueKey } = {}) {
  // POST /api/auth/initiate-2fa
  app.post('/api/auth/initiate-2fa', async (req, res) => {
    const { email, discordId } = req.body;
    if (!email || !discordId)
      return res.status(400).json({ message: 'Email and discordId are required.' });

    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    pendingSessions.set(sessionId, { email, discordId, verified: false, expiresAt });

    try {
      const user = await discordClient.users.fetch(discordId);
      const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('🔐 Two-Factor Authentication Required')
        .setDescription(`A login attempt was made on **UHSERVICES.GG**.\n\nClick the button below to verify it's you.`)
        .addFields({ name: '📧 Account', value: email, inline: true })
        .setFooter({ text: 'This request expires in 10 minutes • UH SERVICES' })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`auth_${sessionId}`)
          .setLabel('Authenticate').setStyle(ButtonStyle.Success).setEmoji('🔑')
      );
      await user.send({ embeds: [embed], components: [row] });
      console.log(`📨 Sent 2FA DM to Discord user ${discordId} for ${email}`);
      return res.json({ userId: sessionId, message: 'Verification DM sent.' });
    } catch (err) {
      pendingSessions.delete(sessionId);
      let message = 'Failed to send Discord DM. Make sure you are in the UH SERVICES server.';
      if (err.code === 50007) message = 'Cannot send DM — please enable DMs from server members in your Discord privacy settings.';
      if (err.code === 10013) message = 'Discord User ID not found. Double-check the ID in your Security settings.';
      return res.status(488).json({ message });
    }
  });

  // POST /api/auth/verify-token
  app.post('/api/auth/verify-token', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const session = pendingSessions.get(userId);
    if (!session) return res.json({ verified: false, error: 'Session not found' });
    if (Date.now() > session.expiresAt) {
      pendingSessions.delete(userId);
      return res.json({ verified: false, error: 'Session expired' });
    }
    if (session.verified) {
      pendingSessions.delete(userId);
      return res.json({ verified: true });
    }
    return res.json({ verified: false });
  });

  // POST /api/keys/issue — website calls this after a successful order.
  // Requires header  x-api-key: <KEY_API_SECRET>  — set that env var on
  // Railway to a long random string, and put the same value in your
  // website's backend (never in frontend/client-side code).
  app.post('/api/keys/issue', async (req, res) => {
    const apiSecret = process.env.KEY_API_SECRET;
    if (!apiSecret) {
      return res.status(503).json({ error: 'Key issuing is not configured on this server (KEY_API_SECRET not set).' });
    }
    if (req.get('x-api-key') !== apiSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!issueKey) {
      return res.status(500).json({ error: 'Key issuing is not wired up on this bot instance.' });
    }

    const { discordUserId, roleId, duration, guildId } = req.body;
    if (!discordUserId || !roleId || !duration) {
      return res.status(400).json({ error: 'discordUserId, roleId, and duration are required.' });
    }

    const durationMs = parseDurationForApi(duration);
    if (!durationMs) {
      return res.status(400).json({ error: 'Invalid duration format. Use 30m, 12h, 7d, or 2w.' });
    }

    const result = await issueKey({
      discordUserId,
      roleId,
      durationMs,
      guildId: guildId || process.env.GUILD_ID,
    });

    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ success: true, key: result.key, dmSent: result.dmSent });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', botReady: discordClient.isReady() });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🔐 2FA Auth server listening on port ${PORT}`));
}

module.exports = { startAuthServer, handle2FAInteraction };
