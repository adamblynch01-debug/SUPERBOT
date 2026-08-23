/**
 * INTEGRATION PATCH FOR SUPERBOT
 *
 * This file contains the changes needed to:
 * 1. Add 2FA/TOTP code generation commands
 * 2. Fix expired Discord CDN banner URLs
 *
 * INSTRUCTIONS:
 * 1. The modules (totp2fa.js, brandEmbed.js) have been created in modules/
 * 2. The banner file has been copied to assets/zeropoint_banner.png
 * 3. Apply the changes below to index.js
 */

// ============================================================================
// STEP 1: Add imports at the top of index.js (after line 84)
// ============================================================================

const totp2fa = require('./modules/totp2fa');
const { brandEmbed: brandEmbedHelper, getBannerAttachment } = require('./modules/brandEmbed');

// ============================================================================
// STEP 2: Replace the ZEROPOINT_BANNER constant and brandEmbed function
//         (lines 444-452) with this:
// ============================================================================

// Import the new brand helper
const { getBannerAttachment: getBanner } = require('./modules/brandEmbed');

function brandEmbed(embed, guild) {
  const iconURL = (guild && guild.iconURL({ size: 128 })) || null;
  const thumbURL = (guild && guild.iconURL({ size: 256 })) || null;
  if (iconURL) embed.setAuthor({ name: BOT_NAME, iconURL });
  if (thumbURL) embed.setThumbnail(thumbURL);

  // Use local banner attachment instead of expired CDN URL
  embed.setImage('attachment://zeropoint_banner.png');
  return embed;
}

// Helper to get banner attachment for message sends
function getBannerAttachment() {
  return getBanner();
}

// ============================================================================
// STEP 3: Load TOTP accounts on bot ready (add to client.once('ready') block)
// ============================================================================

// Add this inside the client.once('ready', async () => { ... }) block:
const totpAccountPath = path.join(DATA_DIR, 'outlook_accounts.txt');
if (fs.existsSync(totpAccountPath)) {
  totp2fa.loadAccounts(totpAccountPath);
}

// ============================================================================
// STEP 4: Add 2FA commands to ownCommands array (before line 3402)
// ============================================================================

// 2FA / TOTP Commands
new SlashCommandBuilder()
  .setName('get2fa')
  .setDescription('Staff: Get current 2FA code for a Microsoft account')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o => o.setName('email').setDescription('Account email address').setRequired(true)),

new SlashCommandBuilder()
  .setName('list2fa')
  .setDescription('Staff: List all accounts with 2FA enabled')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

new SlashCommandBuilder()
  .setName('load2fa')
  .setDescription('Admin: Load/reload TOTP accounts from file')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('filename').setDescription('File in DATA_DIR (default: outlook_accounts.txt)').setRequired(false)),

// ============================================================================
// STEP 5: Add command handlers (in the interaction handler switch/case)
//         Find where other commands are handled and add these cases
// ============================================================================

case 'get2fa': {
  await interaction.deferReply({ ephemeral: true });

  const email = interaction.options.getString('email');
  const result = totp2fa.generate2FA(email);

  if (result.error) {
    return interaction.editReply({ content: `❌ ${result.error}`, ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('🔐 2FA Code Generated')
    .setDescription(`**Account:** ${result.email}\n**Code:** \`${result.code}\``)
    .addFields(
      { name: 'Expires In', value: `${result.remaining} seconds`, inline: true },
      { name: 'Valid Until', value: `<t:${Math.floor(result.expiresAt.getTime() / 1000)}:T>`, inline: true }
    )
    .setColor(0x00ff00)
    .setFooter({ text: 'Codes refresh every 30 seconds' })
    .setTimestamp();

  brandEmbed(embed, interaction.guild);

  const banner = getBannerAttachment();
  const payload = { embeds: [embed], ephemeral: true };
  if (banner) payload.files = [banner];

  await interaction.editReply(payload);
  break;
}

case 'list2fa': {
  await interaction.deferReply({ ephemeral: true });

  const accounts = totp2fa.listAccounts();
  const count = totp2fa.getAccountCount();

  if (count === 0) {
    return interaction.editReply({ content: '❌ No accounts with 2FA loaded', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('📧 Accounts with 2FA Enabled')
    .setDescription(`**Total:** ${count} accounts\n\n${accounts.slice(0, 25).map(acc => `• ${acc.email}`).join('\n')}`)
    .setColor(0x5865f2)
    .setFooter({ text: count > 25 ? `Showing first 25 of ${count} accounts` : `${count} accounts total` })
    .setTimestamp();

  brandEmbed(embed, interaction.guild);

  const banner = getBannerAttachment();
  const payload = { embeds: [embed], ephemeral: true };
  if (banner) payload.files = [banner];

  await interaction.editReply(payload);
  break;
}

case 'load2fa': {
  if (!await hasAccess(interaction.member)) {
    return interaction.reply({ content: '❌ No permission.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const filename = interaction.options.getString('filename') || 'outlook_accounts.txt';
  const filepath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return interaction.editReply({ content: `❌ File not found: ${filename}`, ephemeral: true });
  }

  const loaded = totp2fa.loadAccounts(filepath);

  const embed = new EmbedBuilder()
    .setTitle('✅ 2FA Accounts Loaded')
    .setDescription(`Successfully loaded **${loaded}** accounts with TOTP secrets from \`${filename}\``)
    .setColor(0x00ff00)
    .setTimestamp();

  brandEmbed(embed, interaction.guild);

  const banner = getBannerAttachment();
  const payload = { embeds: [embed], ephemeral: true };
  if (banner) payload.files = [banner];

  await interaction.editReply(payload);
  break;
}

// ============================================================================
// STEP 6: Update ALL existing embed sends to include banner attachment
// ============================================================================

// When sending embeds with the ZEROPOINT banner, change from:
// await channel.send({ embeds: [embed] });
//
// To:
// const banner = getBannerAttachment();
// const payload = { embeds: [embed] };
// if (banner) payload.files = [banner];
// await channel.send(payload);

// ============================================================================
// NOTES
// ============================================================================

/**
 * File Format for outlook_accounts.txt:
 * email|password|refresh_token|client_id|totp_secret
 *
 * Example:
 * coolhawk@outlook.com|Pass123!|0.AX...token...|client_id|JBSWY3DPEHPK3PXP
 *
 * The 5th field (totp_secret) is the TOTP secret key extracted during account creation.
 *
 * Commands:
 * - /get2fa email:user@outlook.com - Get current 6-digit 2FA code (DM or ephemeral)
 * - /list2fa - List all accounts with 2FA enabled
 * - /load2fa filename:accounts.txt - Reload accounts from file
 *
 * Banner Fix:
 * - Replaced expired Discord CDN URLs with local file attachment
 * - Banner file: assets/zeropoint_banner.png
 * - No more "image failed to load" errors
 */

module.exports = {
  // Export for reference
  instructions: 'See comments above for integration steps'
};
