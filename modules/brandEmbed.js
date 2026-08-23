/**
 * Brand Embed Helper - Apply ZEROPOINT branding to embeds
 * Uses ZEROPOINT_BANNER_URL env var
 */
'use strict';

const BANNER_URL = process.env.ZEROPOINT_BANNER_URL || 'https://zeropoint.wtf/zeropoint_banner.png';

/**
 * Apply ZEROPOINT branding to an embed
 * @param {EmbedBuilder} embed - The embed to brand
 * @param {Guild} guild - Optional guild (for future use)
 * @returns {EmbedBuilder} - Returns the same embed for chaining
 */
function brandEmbed(embed, guild) {
  if (BANNER_URL) {
    embed.setImage(BANNER_URL);
  }
  return embed;
}

module.exports = brandEmbed;
