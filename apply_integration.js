/**
 * Automated Integration Script
 * Applies 2FA commands and banner fix to SUPERBOT index.js
 *
 * Usage: node apply_integration.js
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.js');
const BACKUP_PATH = path.join(__dirname, 'index.js.backup');

console.log('🔧 SUPERBOT Integration Script');
console.log('================================\n');

// Read index.js
let content = fs.readFileSync(INDEX_PATH, 'utf-8');

// Create backup
fs.writeFileSync(BACKUP_PATH, content);
console.log('✅ Backup created: index.js.backup\n');

let changes = 0;

// ============================================================================
// CHANGE 1: Add module imports (after line with "const { money: gxMoney }")
// ============================================================================
if (!content.includes("require('./modules/totp2fa')")) {
  const importTarget = "const { money: gxMoney } = require('./modules/money');";
  const newImports = `${importTarget}
const totp2fa = require('./modules/totp2fa');
const { getBannerAttachment: getBanner } = require('./modules/brandEmbed');`;

  content = content.replace(importTarget, newImports);
  changes++;
  console.log('✅ Added module imports (totp2fa, brandEmbed)');
}

// ============================================================================
// CHANGE 2: Fix ZEROPOINT_BANNER constant (replace expired CDN URL)
// ============================================================================
const oldBannerLine = "const ZEROPOINT_BANNER = 'https://media.discordapp.net/attachments/1521288246573797418/1536183475630117034/ZEROPOINT_BANNER.png?ex=6a7a79d9&is=6a792859&hm=724513811a7f39bf0c2eab470e01765f8ebb7351c472869a1349a2bd970808f5&=&format=webp&quality=lossless&width=1280&height=511';";
const newBannerLine = "const ZEROPOINT_BANNER = 'attachment://zeropoint_banner.png'; // Using local file to avoid CDN expiration";

if (content.includes(oldBannerLine)) {
  content = content.replace(oldBannerLine, newBannerLine);
  changes++;
  console.log('✅ Fixed ZEROPOINT_BANNER constant (now uses local file)');
}

// ============================================================================
// CHANGE 3: Update brandEmbed function to use setImage with attachment
// ============================================================================
const oldBrandEmbed = `function brandEmbed(embed, guild) {
  const iconURL = (guild && guild.iconURL({ size: 128 })) || null;
  const thumbURL = (guild && guild.iconURL({ size: 256 })) || null;
  if (iconURL) embed.setAuthor({ name: BOT_NAME, iconURL });
  if (thumbURL) embed.setThumbnail(thumbURL);
  embed.setImage(ZEROPOINT_BANNER);
  return embed;
}`;

const newBrandEmbed = `function brandEmbed(embed, guild) {
  const iconURL = (guild && guild.iconURL({ size: 128 })) || null;
  const thumbURL = (guild && guild.iconURL({ size: 256 })) || null;
  if (iconURL) embed.setAuthor({ name: BOT_NAME, iconURL });
  if (thumbURL) embed.setThumbnail(thumbURL);
  embed.setImage(ZEROPOINT_BANNER); // Uses attachment://zeropoint_banner.png
  return embed;
}

// Helper to get banner attachment for message sends
function getBannerAttachment() {
  return getBanner();
}`;

if (content.includes(oldBrandEmbed)) {
  content = content.replace(oldBrandEmbed, newBrandEmbed);
  changes++;
  console.log('✅ Updated brandEmbed function with attachment helper');
}

// ============================================================================
// CHANGE 4: Add TOTP account loading in ready event
// ============================================================================
const readyMarker = "console.log(`✅ Ready! Logged in as ${client.user.tag}. Serving ${client.guilds.cache.size} servers.`);";
const totpLoadCode = `
  // Load TOTP accounts for 2FA generation
  const totpAccountPath = path.join(DATA_DIR, 'outlook_accounts.txt');
  if (fs.existsSync(totpAccountPath)) {
    const loaded = totp2fa.loadAccounts(totpAccountPath);
    if (loaded > 0) console.log(\`✅ Loaded \${loaded} accounts with 2FA\`);
  }`;

if (content.includes(readyMarker) && !content.includes('totp2fa.loadAccounts')) {
  content = content.replace(readyMarker, readyMarker + totpLoadCode);
  changes++;
  console.log('✅ Added TOTP account loading to ready event');
}

// ============================================================================
// CHANGE 5: Add 2FA commands to ownCommands array
// ============================================================================
const commandsEndMarker = '].map(c => c.toJSON());';
const newCommands = `
  // ─── 2FA / TOTP Commands ───────────────────────────────────────────────────
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
${commandsEndMarker}`;

if (!content.includes("setName('get2fa')")) {
  content = content.replace(commandsEndMarker, newCommands);
  changes++;
  console.log('✅ Added 2FA commands (/get2fa, /list2fa, /load2fa)');
}

// ============================================================================
// CHANGE 6: Add command handlers (find the interaction handler and add cases)
// ============================================================================
const handlerMarker = "case 'leaveguild':";
const newHandlers = `
  // ─── 2FA Command Handlers ──────────────────────────────────────────────────
  case 'get2fa': {
    if (!await hasAccess(interaction.member)) {
      return interaction.reply({ content: '❌ No permission.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const email = interaction.options.getString('email');
    const result = totp2fa.generate2FA(email);

    if (result.error) {
      return interaction.editReply({ content: \`❌ \${result.error}\`, ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🔐 2FA Code Generated')
      .setDescription(\`**Account:** \${result.email}\\n**Code:** \\\`\${result.code}\\\`\`)
      .addFields(
        { name: 'Expires In', value: \`\${result.remaining} seconds\`, inline: true },
        { name: 'Valid Until', value: \`<t:\${Math.floor(result.expiresAt.getTime() / 1000)}:T>\`, inline: true }
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
    if (!await hasAccess(interaction.member)) {
      return interaction.reply({ content: '❌ No permission.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const accounts = totp2fa.listAccounts();
    const count = totp2fa.getAccountCount();

    if (count === 0) {
      return interaction.editReply({ content: '❌ No accounts with 2FA loaded', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('📧 Accounts with 2FA Enabled')
      .setDescription(\`**Total:** \${count} accounts\\n\\n\${accounts.slice(0, 25).map(acc => \\\`• \${acc.email}\\\`).join('\\n')}\`)
      .setColor(0x5865f2)
      .setFooter({ text: count > 25 ? \`Showing first 25 of \${count} accounts\` : \`\${count} accounts total\` })
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
      return interaction.editReply({ content: \`❌ File not found: \${filename}\`, ephemeral: true });
    }

    const loaded = totp2fa.loadAccounts(filepath);

    const embed = new EmbedBuilder()
      .setTitle('✅ 2FA Accounts Loaded')
      .setDescription(\`Successfully loaded **\${loaded}** accounts with TOTP secrets from \\\`\${filename}\\\`\`)
      .setColor(0x00ff00)
      .setTimestamp();

    brandEmbed(embed, interaction.guild);

    const banner = getBannerAttachment();
    const payload = { embeds: [embed], ephemeral: true };
    if (banner) payload.files = [banner];

    await interaction.editReply(payload);
    break;
  }

  ${handlerMarker}`;

if (content.includes(handlerMarker) && !content.includes("case 'get2fa':")) {
  content = content.replace(handlerMarker, newHandlers);
  changes++;
  console.log('✅ Added 2FA command handlers');
}

// ============================================================================
// Write updated file
// ============================================================================
fs.writeFileSync(INDEX_PATH, content);

console.log(`\n✅ Integration complete! Applied ${changes} changes.`);
console.log('\nNext steps:');
console.log('1. Create outlook_accounts.txt in DATA_DIR with format:');
console.log('   email|password|refresh_token|client_id|totp_secret');
console.log('2. Restart the bot');
console.log('3. Test with: /list2fa, /get2fa email:user@outlook.com');
console.log('\nTo revert: cp index.js.backup index.js');
