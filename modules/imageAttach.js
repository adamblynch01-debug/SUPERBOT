// ─── "Upload a picture and I'll put it on that post" ─────────────────────────
//
// The vouch flow has done this for a while: after the bot posts the embed it
// tells the author they can drop an image in the channel, and it moves that
// image onto the post. This is that behaviour, extracted, so every post the
// bot makes can offer it instead of just the one — and so there is ONE copy of
// it. Two copies of a flow this fiddly drift, and the half that drifts is
// always the one nobody is looking at.
//
// Two things here are not obvious and are the whole reason this is careful:
//
//  1. **The image is RE-UPLOADED onto the target message, not linked.** Discord
//     attachment URLs are signed and expire within a day, and the uploader's
//     message gets deleted straight after anyway. Pointing the embed at that
//     URL produces a post that looks right for an hour and is a broken image
//     by tomorrow. Sending the bytes again as an attachment of the post itself
//     makes the picture live as long as the post does.
//
//  2. **The collector listens where the COMMAND was run, not where the post
//     went.** `/announce channel:#updates` posts somewhere the admin may not
//     even be looking; they are typing here, so they upload here.
'use strict';

const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const DEFAULT_WINDOW_MS = 60_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function isImage(att) {
  if (!att) return false;
  if (att.contentType && String(att.contentType).startsWith('image/')) return true;
  return IMAGE_EXT.test(String(att.name || ''));
}

// An embed that already carries a picture has nothing to ask for. Callers pass
// their builder straight through, so accept both shapes.
function embedHasImage(embed) {
  const data = embed && (embed.data || embed);
  return !!(data && data.image && data.image.url);
}

/**
 * Offer the person who triggered a post the chance to put an image on it.
 *
 * Fire-and-forget: it never throws and never rejects, because it runs after
 * the post has already succeeded. A failure here must not turn a posted
 * announcement into "❌ An error occurred".
 *
 * @param {object}  o
 * @param {import('discord.js').Interaction} o.interaction  the command/modal interaction
 * @param {import('discord.js').Message}     o.message      the post to attach to
 * @param {EmbedBuilder|object}              o.embed        that post's embed
 * @param {string}  [o.fileBase]   attachment filename stem, e.g. `announce-123`
 * @param {number}  [o.windowMs]   how long to wait for the upload
 * @param {function}[o.onAttached] called with (attachmentUrl, message) after a successful attach
 */
async function offerImageUpload({ interaction, message, embed, fileBase = 'image', windowMs = DEFAULT_WINDOW_MS, onAttached } = {}) {
  try {
    if (!interaction || !message || !embed) return;
    const channel = interaction.channel;
    if (!channel || typeof channel.createMessageCollector !== 'function') return;
    if (embedHasImage(embed)) return;

    const seconds = Math.round(windowMs / 1000);
    let prompt = null;
    try {
      prompt = await interaction.followUp({
        content: `📸 Want a picture on that post? Upload one **in this channel** within ${seconds}s`
               + ` and I'll move it onto the post and delete your upload. Ignore this if not.`,
        flags: 64,
      });
    } catch (_) { return; }

    // Editing an ephemeral follow-up goes through the interaction's webhook —
    // `interaction.editReply` would edit the "✅ posted" message instead.
    const say = async (content) => {
      if (!prompt) return;
      try { await interaction.webhook.editMessage(prompt.id, { content }); } catch (_) {}
    };

    let handled = false;
    const collector = channel.createMessageCollector({
      filter: m => m.author && m.author.id === interaction.user.id && m.attachments && m.attachments.size > 0,
      max: 1,
      time: windowMs,
    });

    collector.on('collect', async m => {
      handled = true;
      const att = [...m.attachments.values()].find(isImage) || m.attachments.first();
      if (!isImage(att)) {
        // Left where it is, deliberately. The collector fires on ANY file, so
        // this may well be an admin dropping a zip in the channel who has
        // nothing to do with the post — deleting it would destroy a message
        // that was never addressed to the bot.
        await say('❌ That was not an image, so the post is unchanged. Run the command again if you want another go.');
        return;
      }
      try {
        const ext = (String(att.name || '').split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        const fileName = `${fileBase}.${ext}`;
        const next = EmbedBuilder.from(embed.data || embed).setImage(`attachment://${fileName}`);
        // `files` replaces the message's attachments; `components` is left out
        // on purpose so the post keeps its buttons and language dropdown —
        // edit only overwrites the fields it is given.
        await message.edit({ embeds: [next], files: [new AttachmentBuilder(att.url, { name: fileName })] });
        await say('✅ Image added to the post.');
        if (typeof onAttached === 'function') {
          try { await onAttached(message.embeds?.[0]?.image?.url || att.url, message); } catch (_) {}
        }
      } catch (err) {
        // Nearly always the upload size limit for the server's boost tier.
        await say(`❌ Couldn't attach that: ${err.message}`);
      }
      // Keep the channel as clean as it was before the picture existed. Needs
      // Manage Messages; if the bot hasn't got it the upload just stays put,
      // which is untidy but not broken.
      try { if (m.deletable) await m.delete(); } catch (_) {}
    });

    collector.on('end', async () => {
      if (!handled) await say('⏱️ No image uploaded — the post is fine as it is.');
    });
  } catch (err) {
    console.warn('[ImageAttach] skipped:', err && err.message);
  }
}

module.exports = { offerImageUpload, isImage, embedHasImage, DEFAULT_WINDOW_MS };
