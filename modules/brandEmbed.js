/**
 * Brand Embed Helper - Apply ZEROPOINT branding to embeds
 * Uses local banner file to avoid Discord CDN expiration
 */
'use strict';

const { AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');

const BANNER_PATH = path.join(__dirname, '..', 'assets', 'zeropoint_banner.png');
const BANNER_URL = process.env.ZEROPOINT_BANNER_URL || null;

/**
 * Apply ZEROPOINT branding to an embed
 * @param {EmbedBuilder} embed - The embed to brand
 * @param {Object} options - Options for branding
 * @param {boolean} options.useBanner - Whether to add the banner image (default: true)
 * @param {boolean} options.useAttachment - Use local file attachment instead of URL (default: true if no URL set)
 * @returns {Object} { embed, attachment } - Returns embed and optional attachment
 */
function brandEmbed(embed, options = {}) {
  const useBanner = options.useBanner !== false;
  const useAttachment = options.useAttachment !== false || !BANNER_URL;

  if (!useBanner) {
    return { embed, attachment: null };
  }

  // Use local attachment if available and configured
  if (useAttachment && fs.existsSync(BANNER_PATH)) {
    const attachment = new AttachmentBuilder(BANNER_PATH, { name: 'zeropoint_banner.png' });
    embed.setImage('attachment://zeropoint_banner.png');
    return { embed, attachment };
  }

  // Fallback to URL if provided
  if (BANNER_URL) {
    embed.setImage(BANNER_URL);
    return { embed, attachment: null };
  }

  // No banner available
  console.warn('[BrandEmbed] No banner available (no local file or URL)');
  return { embed, attachment: null };
}

/**
 * Quick helper to get just the attachment
 */
function getBannerAttachment() {
  if (fs.existsSync(BANNER_PATH)) {
    return new AttachmentBuilder(BANNER_PATH, { name: 'zeropoint_banner.png' });
  }
  return null;
}

/**
 * Get banner URL (for setImage)
 */
function getBannerImageUrl() {
  if (fs.existsSync(BANNER_PATH)) {
    return 'attachment://zeropoint_banner.png';
  }
  if (BANNER_URL) {
    return BANNER_URL;
  }
  return null;
}

module.exports = {
  brandEmbed,
  getBannerAttachment,
  getBannerImageUrl,
  BANNER_PATH
};
