// ─── #live-stream AND #post-your-clips ────────────────────────────────────────
// "WHAT YOU DID WITH THE /SETUP-WEBSITE WHEN I TOLD YOU IT LOOK DEAD. DO THE
// SAME FOR THE LIVE-STREAM AND POST-YOUR-CLIPS CHANNEL."
//
// Same complaint, same shape of answer. #post-your-clips had NOTHING in it —
// members were pasting bare medal.tv URLs into an empty room with no post at
// the top saying what the room is for. #live-stream had nothing standing in it
// either, so between streams it read as abandoned.
//
// The part that is not a nicer-looking hardcode:
//
//   "EXCEPT FOR THIS ONE GIVE ME OPTION TO ATTACH STREAM LINK EVERYTIME GOING
//    LIVE."
//
// A stream link is different every time, so it cannot live in the panel. It is
// `/golive link:<url>` — which posts a fresh card (a fresh ping; that is the
// point of announcing) AND edits the standing panel so it says LIVE RIGHT NOW
// with that link on it. Run `/golive` with no link and the stream is marked
// over: the panel goes back to idle and the last card stops saying LIVE, so a
// three-day-old announcement is not still claiming to be live.
//
// Which message is the panel is not stored anywhere. Each embed carries a
// marker in its footer and the command finds it by scanning recent history —
// the same trick storefrontPanels.js uses, for the same reason: it survives a
// restart, and an in-memory id does not.
'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits,
} = require('discord.js');
const { languageRow } = require('./translate');
const { upsertPanel } = require('./storefrontPanels');

const SITE_URL = (process.env.SITE_URL || 'https://uhservices.xyz').replace(/\/+$/, '');

const MARK_LIVE     = 'panel:live-stream';   // the standing panel
const MARK_LIVE_NOW = 'panel:live-now';      // one announcement, per stream
const MARK_CLIPS    = 'panel:clips';

let gate = { hasAccess: () => false };
function setCommunityGate(g) { gate = { ...gate, ...g }; }

// ─── the link ─────────────────────────────────────────────────────────────────
// A Link button with a URL Discord will not accept does not degrade — it
// REJECTS THE WHOLE MESSAGE, so the announcement fails to send and the admin
// sees an error instead of a stream going live. Everything a link is used for
// below goes through here first, and a link that does not survive it is
// reported to the admin rather than handed to Discord.
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // A pasted link is often wrapped in <> by whatever it was copied out of.
  s = s.replace(/^<+|>+$/g, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // "twitch" is not a link. A host with no dot in it is a typo, and one with a
  // space in it never came from a browser.
  if (!u.hostname.includes('.') || /\s/.test(u.href)) return null;
  if (u.href.length > 512) return null;   // Discord's button URL cap is 512
  return u.href;
}

// Which site it is, for the colour and the wording. Unknown is a first-class
// answer: plenty of people stream somewhere this list has never heard of, and
// guessing "Twitch" at a Kick link would be worse than saying nothing.
const PLATFORMS = [
  { name: 'Twitch',  emoji: '🟣', color: 0x9146FF, test: /(^|\.)twitch\.tv$/i },
  { name: 'Kick',    emoji: '🟢', color: 0x53FC18, test: /(^|\.)kick\.com$/i },
  { name: 'YouTube', emoji: '🔴', color: 0xFF0000, test: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { name: 'TikTok',  emoji: '🎵', color: 0x69C9D0, test: /(^|\.)tiktok\.com$/i },
  { name: 'Rumble',  emoji: '🟩', color: 0x85C742, test: /(^|\.)rumble\.com$/i },
  { name: 'X',       emoji: '✖️', color: 0x1D9BF0, test: /(^|\.)(x\.com|twitter\.com)$/i },
];

function platformOf(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./i, ''); } catch (_) { return null; }
  return PLATFORMS.find(p => p.test.test(host)) || null;
}

// ─── the live-stream panel ────────────────────────────────────────────────────
// `live` is either null (nobody is streaming) or the announcement's details.
// Both states are real states and the panel says which one it is in — an idle
// panel that looks identical to a live one is how a channel starts reading as
// dead in the first place.
function buildLivePanel(guild, live) {
  const p = live && platformOf(live.url);
  const embed = new EmbedBuilder()
    .setColor(live ? (p ? p.color : 0xE91E63) : 0x2B2D31)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(live ? '🔴  LIVE RIGHT NOW' : '📺  Live streams');

  if (live) {
    if (live.url) embed.setURL(live.url);
    embed.setDescription(
      (live.title ? `**${live.title}**\n` : '')
      + `The stream is up now${p ? ` on **${p.name}**` : ''}. Tap **Watch now** below.`
    );
    if (live.game) embed.addFields({ name: '🎮 Playing', value: live.game, inline: true });
    embed.addFields({ name: '🔗 Where', value: p ? `${p.emoji} ${p.name}` : 'Link below', inline: true });
  } else {
    embed.setDescription(
      `**This is where streams get announced.**\n`
      + `Nobody is live at the moment. When a stream starts, the link is posted right here — `
      + `you do not have to go looking for it.`
    ).addFields(
      { name: '🔴 When we go live', value: 'An announcement lands in this channel with the link on it.', inline: true },
      { name: '🔔 Get notified', value: 'Turn on notifications for this channel so you actually see it.', inline: true },
      { name: '💬 Watching along', value: 'Chat in the stream, or in here — both get read.', inline: true },
    );
  }

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_LIVE}` }).setTimestamp();

  const row = new ActionRowBuilder();
  if (live && live.url) {
    row.addComponents(new ButtonBuilder().setLabel('Watch now').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(live.url));
  }
  // Offline there is no link to put on a Link button, and a Link button has to
  // have one. This is the button that stops the idle panel being three lines
  // and a full stop.
  row.addComponents(
    new ButtonBuilder().setCustomId('live_notify').setLabel('How do I get notified?').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// The announcement itself. Separate message from the panel on purpose: the
// panel is edited in place (so it is never a duplicate) and the announcement is
// posted fresh (so it actually notifies somebody).
function buildLiveCard(guild, live) {
  const p = platformOf(live.url);
  const embed = new EmbedBuilder()
    .setColor(p ? p.color : 0xE91E63)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🔴  LIVE NOW${live.title ? ` — ${live.title}`.slice(0, 200) : ''}`)
    .setURL(live.url)
    .setDescription(`We are streaming${p ? ` on **${p.name}**` : ''} right now.\n${live.url}`);

  if (live.game) embed.addFields({ name: '🎮 Playing', value: live.game, inline: true });
  if (p) embed.addFields({ name: '📺 Platform', value: `${p.emoji} ${p.name}`, inline: true });
  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_LIVE_NOW}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Watch now').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(live.url),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// What the last announcement becomes once the stream is over. The link stays —
// on most platforms it is the VOD — but nothing on it still says LIVE, which is
// the whole reason this exists. A card that claims to be live three days later
// teaches people to ignore the channel.
function endedCard(message) {
  const old = message.embeds[0];
  const embed = EmbedBuilder.from(old)
    .setColor(0x2B2D31)
    .setTitle((old.title || 'LIVE NOW').replace(/^🔴\s*LIVE NOW/i, '⚫  Stream ended'))
    .setDescription(`This stream is over. The link may still work as a replay.\n${old.url || ''}`.trim());
  const row = new ActionRowBuilder();
  if (old.url) row.addComponents(new ButtonBuilder().setLabel('Watch the replay').setEmoji('⏪').setStyle(ButtonStyle.Link).setURL(old.url));
  row.addComponents(new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL));
  return { embeds: [embed], components: [row] };
}

// ─── the clips panel ──────────────────────────────────────────────────────────
function buildClipsPanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0xFAA61A)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('🎬  Post your clips')
    .setDescription(
      `**Got a clip worth watching? Drop it in here.**\n`
      + `Anything you have hit with our tools — the ridiculous ones especially. Paste the link and it plays inline; `
      + `no upload, no compression, no 25 MB limit.`
    )
    .addFields(
      { name: '📎 How to post', value: 'Paste the link on its own line. Medal, Streamable, YouTube and Twitch clips all play right in the channel.', inline: false },
      { name: '🎥 No clipping software?', value: 'Medal and Outplayed are free and both record the last few minutes after the fact — the buttons below.', inline: true },
      { name: '💬 Say what happened', value: 'A line of context under the link gets a clip watched. A bare URL usually gets scrolled past.', inline: true },
      { name: '📌 Clips only', value: 'Keep chat in the general channels so this one stays watchable end to end.', inline: false },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_CLIPS}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clips_howto').setLabel('How do I record a clip?').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('Medal').setEmoji('🎥').setStyle(ButtonStyle.Link).setURL('https://medal.tv'),
    new ButtonBuilder().setLabel('Outplayed').setEmoji('🎞️').setStyle(ButtonStyle.Link).setURL('https://outplayed.tv'),
  );
  return { embeds: [embed], components: [row] };
}

// ─── posting ──────────────────────────────────────────────────────────────────
const withLanguage = (payload) => {
  const components = [...(payload.components || [])];
  if (components.length >= 5) return payload;
  return { ...payload, components: [...components, languageRow()] };
};

// The most recent message in the channel carrying `marker` in an embed footer,
// or null. Same 50-message window as upsertPanel: a channel whose panel has
// scrolled past 50 messages is a channel where re-posting is the right answer
// anyway.
async function findMarked(channel, marker, me) {
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    return recent.find(m =>
      m.author.id === me.id && m.embeds.some(e => ((e.footer && e.footer.text) || '').includes(marker))) || null;
  } catch (e) {
    console.warn('[Community] could not scan channel history:', e.message);
    return null;
  }
}

// The details of the announcement currently standing in the channel, read back
// off the message itself. There is no "is a stream running" flag anywhere —
// the channel IS the state, which is what makes this survive a restart and a
// redeploy without a table.
function liveFromCard(message) {
  if (!message) return null;
  const e = message.embeds[0];
  if (!e || !e.url) return null;
  if (!/LIVE NOW/i.test(e.title || '')) return null;   // an ended card is not a live one
  const title = (e.title || '').replace(/^🔴\s*LIVE NOW\s*—?\s*/i, '').trim();
  const game = (e.fields || []).find(f => /Playing/i.test(f.name));
  return { url: e.url, title: title || null, game: game ? game.value : null };
}

// ─── commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('setup-livestream')
    .setDescription('Admin: Post (or refresh) the live-stream panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #live-stream)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('golive')
    .setDescription('Admin: Announce a stream with its link — leave the link blank to mark it ended')
    .addStringOption(o => o.setName('link').setDescription('The stream link for THIS stream (blank = the stream is over)').setRequired(false))
    .addStringOption(o => o.setName('title').setDescription('What the stream is, e.g. "Ranked grind with the spoofer on"').setRequired(false))
    .addStringOption(o => o.setName('game').setDescription('What you are playing').setRequired(false))
    .addRoleOption(o => o.setName('ping').setDescription('Role to notify (pick @everyone for everyone)').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Where to announce (defaults to #live-stream)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-clips')
    .setDescription('Admin: Post (or refresh) the post-your-clips panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #post-your-clips)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// findChannelByName is handed in rather than re-implemented: it is the
// NFKD-folding resolver, and the second server names its channels in
// mathematical bold, which toLowerCase() cannot touch.
async function handleCommunityCommand(interaction, { findChannel }) {
  const cmd = interaction.commandName;
  if (cmd !== 'setup-livestream' && cmd !== 'golive' && cmd !== 'setup-clips') return false;
  if (!gate.hasAccess(interaction)) {
    await interaction.reply({ content: '❌ No permission.', flags: 64 });
    return true;
  }
  await interaction.deferReply({ flags: 64 });

  const wanted = cmd === 'setup-clips' ? 'post-your-clips' : 'live-stream';
  const picked = interaction.options.getChannel('channel');
  const found  = picked || findChannel(interaction.guild, wanted)
    || (cmd === 'setup-clips' ? findChannel(interaction.guild, 'clips') : findChannel(interaction.guild, 'streams'));
  const channel = found || interaction.channel;
  const me = interaction.client.user;

  try {
    if (cmd === 'setup-clips') {
      const { edited } = await upsertPanel(channel, MARK_CLIPS, withLanguage(buildClipsPanel(interaction.guild)), me);
      await interaction.editReply(`${edited ? '♻️ Refreshed' : '📌 Posted'} the clips panel in <#${channel.id}>.`
        + (found ? '' : `\nℹ️ No **#${wanted}** channel here, so it went in this one.`));
      return true;
    }

    if (cmd === 'setup-livestream') {
      // If a stream is running right now, the panel says so. Re-posting the
      // panel mid-stream must not quietly claim nobody is live.
      const live = liveFromCard(await findMarked(channel, MARK_LIVE_NOW, me));
      const { edited } = await upsertPanel(channel, MARK_LIVE, withLanguage(buildLivePanel(interaction.guild, live)), me);
      await interaction.editReply(`${edited ? '♻️ Refreshed' : '📌 Posted'} the live-stream panel in <#${channel.id}>.`
        + (live ? '\n🔴 A stream is live, so the panel carries its link. `/golive` with no link marks it over.' : '')
        + (found ? '' : `\nℹ️ No **#${wanted}** channel here, so it went in this one.`));
      return true;
    }

    // ── /golive ───────────────────────────────────────────────────────────────
    const raw = (interaction.options.getString('link') || '').trim();
    const previous = await findMarked(channel, MARK_LIVE_NOW, me);

    if (!raw) {
      // No link means the stream is over.
      const wasLive = liveFromCard(previous);
      if (wasLive) { try { await previous.edit(withLanguage(endedCard(previous))); } catch (e) { console.warn('[Community] could not close the live card:', e.message); } }
      const panel = await findMarked(channel, MARK_LIVE, me);
      if (panel) { try { await panel.edit(withLanguage(buildLivePanel(interaction.guild, null))); } catch (e) { console.warn('[Community] could not idle the panel:', e.message); } }
      await interaction.editReply(
        wasLive
          ? `⚫ Marked the stream as ended in <#${channel.id}> — the announcement now reads *Stream ended* and the panel is back to idle.`
          : `ℹ️ Nothing was live in <#${channel.id}>${panel ? ' — the panel is idle either way.' : '.'}`
          + `\nTo announce a stream, run this again with **link:** set.`);
      return true;
    }

    const url = normalizeUrl(raw);
    if (!url) {
      await interaction.editReply(`❌ \`${raw.slice(0, 100)}\` is not a link Discord will accept, so nothing was posted.`
        + `\nPaste the full address, e.g. \`https://twitch.tv/yourname\`.`);
      return true;
    }

    const live = {
      url,
      title: (interaction.options.getString('title') || '').trim() || null,
      game:  (interaction.options.getString('game')  || '').trim() || null,
    };

    // The previous announcement stops saying LIVE before the new one goes up,
    // so the channel never holds two live cards at once.
    if (liveFromCard(previous)) {
      try { await previous.edit(withLanguage(endedCard(previous))); } catch (e) { console.warn('[Community] could not close the previous card:', e.message); }
    }

    const role = interaction.options.getRole('ping');
    // @everyone is a real role whose id is the guild id, and its mention form
    // `<@&guildId>` renders as a dead string rather than a ping. The literal is
    // the only thing that notifies.
    const content = role ? (role.id === interaction.guildId ? '@everyone' : `<@&${role.id}>`) : undefined;

    const card = await channel.send(withLanguage({ ...buildLiveCard(interaction.guild, live), ...(content ? { content } : {}) }));

    const panel = await findMarked(channel, MARK_LIVE, me);
    let panelNote = '';
    if (panel) {
      try { await panel.edit(withLanguage(buildLivePanel(interaction.guild, live))); panelNote = ' The panel now says LIVE with this link on it.'; }
      catch (e) { panelNote = ` ⚠️ The panel could not be updated: ${e.message}`; }
    } else {
      panelNote = ' There is no standing panel in that channel yet — run `/setup-livestream` once and it will track every stream after this.';
    }

    const p = platformOf(url);
    await interaction.editReply(`🔴 Announced in <#${channel.id}>${p ? ` (${p.name})` : ''}${role ? `, pinging ${role.id === interaction.guildId ? '@everyone' : `**${role.name}**`}` : ' with no ping'}.`
      + panelNote
      + `\nWhen you stop, run \`/golive\` with **no link** and both go back to idle.`
      + `\n${card.url}`);
    return true;
  } catch (e) {
    await interaction.editReply(`❌ Could not post there: ${e.message}`);
    return true;
  }
}

// ─── the two buttons ──────────────────────────────────────────────────────────
// Both ephemeral: they are a walkthrough for the person who pressed them, not
// another wall of text in a channel that was already too quiet.
async function handleCommunityButton(interaction) {
  if (interaction.customId === 'live_notify') {
    const embed = new EmbedBuilder()
      .setColor(0xE91E63)
      .setTitle('🔔 Getting told when a stream starts')
      .setDescription([
        '**On desktop** — right-click this channel → **Notification Settings** → *All Messages*.',
        '**On mobile** — long-press the channel → **Notifications** → *All Messages*.',
        '',
        'That is per-channel, so it will not make the rest of the server noisier.',
        'If the announcement pings a role, holding that role is what puts it on your phone.',
      ].join('\n'))
      .setFooter({ text: SITE_URL.replace(/^https?:\/\//, '') });
    await interaction.reply({ embeds: [embed], flags: 64 });
    return true;
  }

  if (interaction.customId === 'clips_howto') {
    const embed = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle('❓ How to record and post a clip')
      .setDescription([
        '**1.** Install **Medal** (medal.tv) or **Outplayed** (outplayed.tv). Both are free and both record in the background.',
        '**2.** Play. When something happens, hit the clip hotkey — it saves the last few minutes, so you do not have to know in advance.',
        '**3.** The app gives you a link. Copy it.',
        '**4.** Paste the link in this channel on its own line. It will play inline.',
      ].join('\n'))
      .addFields(
        { name: 'Already have a file?', value: 'Discord caps uploads at 10 MB without Nitro, and a long clip will not fit. Put it on Streamable or YouTube (unlisted is fine) and post that link instead.' },
        { name: 'Xbox / PlayStation', value: 'Record with the console, upload to YouTube from the console app, then post the link here.' },
      )
      .setFooter({ text: SITE_URL.replace(/^https?:\/\//, '') });
    await interaction.reply({ embeds: [embed], flags: 64 });
    return true;
  }

  return false;
}

module.exports = {
  commands, handleCommunityCommand, handleCommunityButton, setCommunityGate,
  // Exported for the tests, which render the panels without a Discord connection.
  buildLivePanel, buildLiveCard, buildClipsPanel, endedCard, liveFromCard,
  normalizeUrl, platformOf, findMarked,
  MARK_LIVE, MARK_LIVE_NOW, MARK_CLIPS,
};
