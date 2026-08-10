// ─── the standing channel panels ──────────────────────────────────────────────
// "WHAT YOU DID WITH THE /SETUP-WEBSITE WHEN I TOLD YOU IT LOOK DEAD. DO THE
// SAME FOR THE LIVE-STREAM AND POST-YOUR-CLIPS CHANNEL."
//
// Same complaint, same shape of answer, now covering #live-stream,
// #post-your-clips, #post-your-pc and #suggestions. Each channel gets ONE post
// at the top saying what the room is for and giving the member the button that
// does the thing.
//
// ─── the rule this module got wrong once, and is the reason for the shape ─────
//
//   "at the moment after posting ./golive url, it makes 2 post + removeS
//    ./setup-livestream.  ./setup-livestream SHOULD BE LEFT ALONE IF POSTED."
//
// It did. `/golive` used to EDIT the standing panel into a "🔴 LIVE RIGHT NOW"
// state as well as posting the announcement, which from the channel's point of
// view is two posts and a panel that has stopped looking like a panel. The
// panel and the announcement are different KINDS of thing and the fix is to
// stop pretending otherwise:
//
//   • **The panel is furniture.** Only `/setup-livestream` ever writes it. It
//     always reads the same. `/golive` must not touch it, ever — there is no
//     code path in here that edits MARK_LIVE outside the setup command, and
//     that is asserted in test_community_panels.js.
//   • **The announcement is disposable.** There is one, it is the current one,
//     and a new one REPLACES it: "do have it remove the old one." Deleted, not
//     retitled. Retiring it to a "Stream ended" card is only the fallback for
//     when the bot has no Manage Messages, because a card still claiming to be
//     live is worse than a tidy tombstone.
//
// A stream link is different every time, so it cannot live in the panel. It is
// `/golive link:<url>` for staff, and for everyone else it is the **I'm going
// live** button on the panel, which asks for the link in a modal and posts the
// same nice card on their behalf.
//
// Which message is which is not stored anywhere. Each embed carries a marker in
// its footer and the commands find it by scanning recent history — the same
// trick storefrontPanels.js uses, for the same reason: it survives a restart,
// and an in-memory id does not.
//
// **Markers must never be prefixes of each other.** The lookup is `includes()`,
// so a marker named `panel:giveaway-live` would be found by a search for
// `panel:giveaway` and a sweep meant for the old giveaway would eat the panel.
// That is why the disposable ones are `live-by:` / `giveaway:` and the
// furniture is `panel:`.
'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { languageRow } = require('./translate');
const { upsertPanel } = require('./storefrontPanels');

const SITE_URL = (process.env.SITE_URL || 'https://zeropoint.wtf').replace(/\/+$/, '');

// Furniture — written only by its own /setup- command, never by anything else.
const MARK_LIVE     = 'panel:live-stream';
const MARK_CLIPS    = 'panel:clips';
const MARK_PC       = 'panel:post-your-pc';
const MARK_SUGGEST  = 'panel:suggestions';
const MARK_GIVEAWAY = 'panel:giveaway';

// Disposable — replaced or removed by the next one of its kind. Deliberately
// NOT prefixed `panel:`, so a sweep can never match a panel by substring.
const MARK_LIVE_NOW    = 'live-now';                        // the stream announcement
const MARK_SUGGESTION  = 'suggestion:filed';
// A clip is NOT disposable, which is the difference between this channel and
// #live-stream. A stream announcement is only interesting while the stream is
// on, so a new one replaces it; a clip is worth watching next month and the
// channel is meant to fill up. Nothing ever sweeps this marker — it is here so
// a clip can be told apart from an ordinary message, not so it can be deleted.
const MARK_CLIP_POST   = 'clip:posted';
// index.js owns /giveaway; these are declared here so the panel and the sweep
// cannot drift apart, and so the prefix rule above is enforced in one place.
const MARK_GW_ENTRY    = 'giveaway:entry';
const MARK_GW_RESULTS  = 'giveaway:results';

let gate = { hasAccess: () => false };
function setCommunityGate(g) { gate = { ...gate, ...g }; }

// Clips accumulate rather than replace, so a member holding the button down
// really can fill the channel. One a minute each is enough for somebody posting
// a genuine run of clips and useless to anybody flooding it.
const CLIP_COOLDOWN_MS = 60_000;
const lastClip = new Map();   // `${guildId}:${userId}` → ms

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
  // Clip hosts rather than places you stream. They are here because the clips
  // panel tells people to use Medal, Streamable and Outplayed by name, and a
  // Medal link — the commonest one in that channel by far — was coming back
  // "unknown" from a list that had only ever been written for /golive.
  { name: 'Medal',      emoji: '🎥', color: 0xFFCF00, test: /(^|\.)medal\.tv$/i },
  { name: 'Streamable', emoji: '🎞️', color: 0x0F90FA, test: /(^|\.)streamable\.com$/i },
  { name: 'Outplayed',  emoji: '🎞️', color: 0xE8563F, test: /(^|\.)outplayed\.tv$/i },
];

function platformOf(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./i, ''); } catch (_) { return null; }
  return PLATFORMS.find(p => p.test.test(host)) || null;
}

// ─── the live-stream panel ────────────────────────────────────────────────────
// ONE state, always the same, because it is furniture. It used to take a `live`
// argument and render a second "🔴 LIVE RIGHT NOW" form, which is what let
// `/golive` overwrite the panel with an announcement — the bug being fixed. The
// argument is gone rather than merely unused: an unused parameter is an
// invitation to pass something to it again.
function buildLivePanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('📺  Live streams')
    .setDescription(
      `**This is where streams get announced.**\n`
      + `When we go live the link is posted right here — you do not have to go looking for it. `
      + `There is only ever one announcement up, and it is the current one.`
    )
    .addFields(
      { name: '🔔 Get notified', value: 'Turn on notifications for this channel so you actually see it. It will not make the rest of the server noisier.', inline: true },
      { name: '💬 Watching along', value: 'Chat in the stream, or in here — both get read.', inline: true },
      { name: '🎬 Got a clip instead?', value: 'Clips go in the clips channel, where anyone can post one. This channel is streams only.', inline: true },
      { name: '📌 Staff', value: '**I\'m going live** posts the announcement — same thing as `/golive`, without leaving the channel. It replaces the last one.', inline: false },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_LIVE}` }).setTimestamp();

  // No Link button can point at "the current stream" — there may not be one,
  // and a Link button without a URL rejects the whole message. These three are
  // what stops the panel being three lines and a full stop.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('live_go').setLabel("I'm going live").setEmoji('🔴').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('live_notify').setLabel('How do I get notified?').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// The announcement itself, and a different KIND of message from the panel: the
// panel is edited in place forever, this one is posted fresh (so it actually
// notifies somebody) and deleted when it is replaced.
//
// `live.by` is the streamer's user id when the panel button was used. It changes
// the WORDING only. It used to change the marker as well, so that a member's
// announcement replaced only their own — that was for the member-facing version
// of this button, which has since moved to the clips channel where it belongs.
// The button is staff-only now, so there is one announcement, whichever way it
// was posted, and `/golive` and the button replace each other.
function buildLiveCard(guild, live) {
  const p = platformOf(live.url);
  const marker = MARK_LIVE_NOW;
  const embed = new EmbedBuilder()
    .setColor(p ? p.color : 0xE91E63)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🔴  LIVE NOW${live.title ? ` — ${live.title}`.slice(0, 200) : ''}`)
    .setURL(live.url)
    .setDescription(
      (live.by ? `<@${live.by}> is live` : 'We are streaming')
      + `${p ? ` on **${p.name}**` : ''} right now.\n${live.url}`
    );

  if (live.game) embed.addFields({ name: '🎮 Playing', value: live.game, inline: true });
  if (p) embed.addFields({ name: '📺 Platform', value: `${p.emoji} ${p.name}`, inline: true });
  // Said on the card as well as in the description, because whoever is
  // streaming is the first thing a reader wants and the description gets
  // truncated on a narrow client.
  if (live.by) embed.addFields({ name: '🎙️ Streaming', value: `<@${live.by}>`, inline: true });
  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${marker}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Watch now').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(live.url),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// What happens to the last announcement when a new one goes up: it goes away.
// "do have it remove the old one."
//
// The fallback matters. Deleting somebody else's message needs Manage Messages
// and the bot does not always have it; a delete that quietly fails would leave
// two cards both saying LIVE NOW, which is the worse of the two failures. So if
// the delete is refused the card is retired in place instead — the link stays
// (on most platforms it is the VOD) and nothing on it still says LIVE.
//
// Returns 'deleted' | 'retired' | 'failed'.
async function retireAnnouncement(message) {
  if (!message) return 'failed';
  try { await message.delete(); return 'deleted'; }
  catch (e) { console.warn('[Community] could not delete the old announcement:', e.message); }
  try { await message.edit(withLanguage(endedCard(message))); return 'retired'; }
  catch (e) { console.warn('[Community] could not retire the old announcement either:', e.message); }
  return 'failed';
}

// The retired form, used only by the fallback above. The link stays — on most
// platforms it is the VOD — but nothing on it still says LIVE, which is the
// whole reason this exists. A card that claims to be live three days later
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
// "/setup-clips add a button for users, they add link, you post for them and
// make it look all nice." THIS is the channel that button belongs in: a clip is
// something any member has and wants to show, where a stream announcement is
// the server's own and goes out under staff's name.
function buildClipsPanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0xFAA61A)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('🎬  Post your clips')
    .setDescription(
      `**Got a clip worth watching? Drop it in here.**\n`
      + `Press **Post a clip**, paste the link, and it goes up properly — your name on it, the game, `
      + `a Watch button, and the clip playing inline.`
    )
    .addFields(
      { name: '🎬 How to post', value: 'Press the button and paste the link. Medal, Streamable, YouTube, Twitch clips and Kick all play right in the channel.', inline: false },
      { name: '🎥 No clipping software?', value: 'Medal and Outplayed are free and both record the last few minutes after the fact — the buttons below.', inline: true },
      { name: '💬 Say what happened', value: 'The box asks you what the clip is. One line is enough, and it is what gets it watched instead of scrolled past.', inline: true },
      { name: '📌 Clips stay up', value: 'Nothing here gets cleared to make room — post yours whenever. Keep the chat about them in the general channels.', inline: false },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_CLIPS}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clip_submit').setLabel('Post a clip').setEmoji('🎬').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('clips_howto').setLabel('How do I record a clip?').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('Medal').setEmoji('🎥').setStyle(ButtonStyle.Link).setURL('https://medal.tv'),
    new ButtonBuilder().setLabel('Outplayed').setEmoji('🎞️').setStyle(ButtonStyle.Link).setURL('https://outplayed.tv'),
  );
  return { embeds: [embed], components: [row] };
}

// Free text a member typed, on its way into plain message content rather than
// into an embed field. Two things have to come out of it.
//
// A SECOND URL is the one that matters: the clip link is checked against the
// blocked-domain list, and a link smuggled into the title would ride along
// unchecked — and, being in the content, could even be the one Discord decides
// to unfurl. There is no legitimate reason for a URL in "what happens in it".
//
// The rest is markdown. In an embed field a stray `**` was cosmetic; in content
// it can restyle everything after it, so the handful of characters that do that
// are escaped rather than stripped, and the member still sees what they typed.
function plainText(s, max) {
  return String(s || '')
    .replace(/https?:\/\/\S+/gi, '')      // no second link
    .replace(/[<>]/g, '')                 // no <@id> / <#id> / <@&id> smuggling
    .replace(/([*_~`|\\])/g, '\\$1')      // markdown, escaped not deleted
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// A member's clip, posted by the bot on their behalf.
//
// ─── why this has NO EMBED ────────────────────────────────────────────────────
// "NO VIDEO PLAYER FOR POST YOUR CLIPS." It had one, and this is why it did not
// work: **Discord will not auto-embed a link in a message that already carries
// an embed of its own.** The two screenshots are the proof — the identical
// medal.tv link posted by a member unfurls into a player, and posted by the bot
// with our card attached does not, even though the URL was right there in the
// content.
//
// So the pretty card WAS the problem. It was competing with, and suppressing, a
// far better one that Medal/YouTube/Streamable/Twitch supply themselves: title,
// uploader, thumbnail and an inline player. This posts plain content and lets
// Discord build that. What we add is the one thing the platform's card cannot
// know — who in this server posted it, and what game it is.
//
// Anything added here that is an `embeds:` entry takes the player away again.
//
// Unlike a stream announcement this is NOT replaced by the next one. The
// channel is a gallery; filling up is the desired outcome.
function buildClipCard(guild, member, clip) {
  const p = platformOf(clip.url);
  const title = plainText(clip.title, 120);
  const game  = plainText(clip.game, 80);

  // `-#` is Discord's subtext: small and grey, which is what a footer looked
  // like before, and it lives in the content because there is no embed to put a
  // footer in. It also carries the marker, so a clip is still recognisable.
  const head = title
    ? `🎬 **${title}** — <@${member.id}>`
    : `🎬 <@${member.id}> posted a clip`;
  const bits = [game ? `🎮 ${game}` : null, p ? `${p.emoji} ${p.name}` : null].filter(Boolean);

  const content = [
    bits.length ? `${head}\n-# ${bits.join('  •  ')}` : head,
    clip.url,   // on its own line, and the only URL in here. This is the player.
    `-# ${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_CLIP_POST}`,
  ].join('\n');

  const row = new ActionRowBuilder().addComponents(
    // Kept even though the unfurled card is clickable: an unfurl can fail (an
    // unsupported host, a private clip, a Discord hiccup) and the button is the
    // one part of this that cannot.
    new ButtonBuilder().setLabel('Watch the clip').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(clip.url),
    // The next person's clip is usually prompted by seeing one. Making them
    // scroll back up to the panel to post it is where that goes to die.
    new ButtonBuilder().setCustomId('clip_submit').setLabel('Post yours').setEmoji('🎬').setStyle(ButtonStyle.Secondary),
  );
  return { content, components: [row] };
}

// ─── the post-your-pc panel ───────────────────────────────────────────────────
// "lets do one for /Setup-Postyourpc (for user to post their pc setups etc..)"
function buildPcPanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0x00B0F4)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('🖥️  Post your setup')
    .setDescription(
      `**Show the room. Rig, desk, handheld, whole battlestation — all of it counts.**\n`
      + `Drag the photo straight into this channel. No link needed and no upload site involved.`
    )
    .addFields(
      { name: '📸 How to post', value: 'Drop the picture in the channel and put your specs in the same message. One message per setup keeps it readable.', inline: false },
      { name: '🧾 What to list', value: 'CPU, GPU, RAM, monitors, peripherals — and the mouse, because somebody always asks.', inline: true },
      { name: '🔧 Want advice?', value: 'Say what you use it for and your budget. "Is this good" with no context gets no useful answers.', inline: true },
      { name: '📌 Setups only', value: 'Keep the back-and-forth in the general channels so this one stays scrollable.', inline: false },
      { name: '🚫 Careful what is on screen', value: 'Check the photo for licence keys, order emails and your own address before you post it. This channel is public.', inline: false },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_PC}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pc_howto').setLabel('What should I include?').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// ─── the suggestions panel ────────────────────────────────────────────────────
// "do one for the suggestion channel aslo". A panel that only explains the
// channel is half a feature — the button files the suggestion, so it lands in
// one shape every time and is votable straight away.
function buildSuggestPanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('💡  Suggestions')
    .setDescription(
      `**Tell us what to build, stock or change.**\n`
      + `Press **Make a suggestion** and it gets posted here with voting on it. `
      + `Every one is read, and the ones people vote for get done first.`
    )
    .addFields(
      { name: '👍 Voting', value: 'Vote on other people\'s with the arrows under each suggestion. That ordering is what we work from.', inline: true },
      { name: '✅ What gets picked up', value: 'Concrete beats vague. "Stock X for Y" or "the panel should show Z" is actionable; "make it better" is not.', inline: true },
      { name: '🔎 Check first', value: 'Have a scroll — if it is already up there, vote on that one instead. Two of the same splits the vote.', inline: false },
      { name: '🎫 Not a suggestion?', value: 'A broken product, a missing order or anything about your own account is a ticket, not a suggestion — you will get an answer faster.', inline: false },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_SUGGEST}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('suggest_new').setLabel('Make a suggestion').setEmoji('💡').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );
  return { embeds: [embed], components: [row] };
}

// A filed suggestion. Voted on with reactions rather than buttons on purpose:
// a reaction count is stored by Discord, so it survives a redeploy, and this
// bot has already been bitten once by state that only lived in the container.
function buildSuggestionCard(guild, member, text) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setAuthor({
      name: member.user ? (member.user.globalName || member.user.username) : String(member.id),
      iconURL: (member.displayAvatarURL && member.displayAvatarURL({ size: 128 })) || undefined,
    })
    .setTitle('💡  Suggestion')
    .setDescription(text.slice(0, 3000))
    .addFields({ name: 'From', value: `<@${member.id}>`, inline: true })
    .setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_SUGGESTION}` })
    .setTimestamp();
  return { embeds: [embed] };
}

// ─── the giveaway panel ───────────────────────────────────────────────────────
// "Lets do one for ./Setup-giveway". Furniture again: it explains the channel
// and stays put. `/giveaway` posts the entry card next to it and clears the
// previous one, and it never touches this.
function buildGiveawayPanel(guild) {
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('🎁  Giveaways')
    .setDescription(
      `**Free stuff, drawn at random, no strings.**\n`
      + `When one is running it is posted right underneath this. Press the button on it once — that is your entry.`
    )
    .addFields(
      { name: '🎉 How to enter', value: 'Hit **Participate** on the giveaway post. One press is enough; pressing again does nothing.', inline: true },
      { name: '⏰ When it ends', value: 'Each post carries its own countdown. Winners are drawn automatically the second it runs out.', inline: true },
      { name: '🏆 If you win', value: 'You get tagged here. Open a ticket to claim it — nobody will ever DM you first asking for anything.', inline: false },
      { name: '🔔 Do not miss one', value: 'Turn notifications on for this channel. Giveaways ping, but only once.', inline: true },
      { name: '📌 One post at a time', value: 'A new giveaway clears the last one and its results, so what you see here is always current.', inline: true },
    );

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 256 }));
  embed.setFooter({ text: `${SITE_URL.replace(/^https?:\/\//, '')} • ${MARK_GIVEAWAY}` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('giveaway_howto').setLabel('How do giveaways work?').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('The store').setEmoji('🛒').setStyle(ButtonStyle.Link).setURL(SITE_URL),
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
// Every /setup- one is the same command with a different panel and a different
// default channel, so it is a table rather than five copies of one handler.
const PANELS = {
  'setup-livestream': { marker: MARK_LIVE,     build: buildLivePanel,     wanted: 'live-stream',      alt: 'streams',     label: 'live-stream' },
  'setup-clips':      { marker: MARK_CLIPS,    build: buildClipsPanel,    wanted: 'post-your-clips',  alt: 'clips',       label: 'clips' },
  'setup-postyourpc': { marker: MARK_PC,       build: buildPcPanel,       wanted: 'post-your-pc',     alt: 'setups',      label: 'setup' },
  'setup-suggestions':{ marker: MARK_SUGGEST,  build: buildSuggestPanel,  wanted: 'suggestions',      alt: 'suggestion',  label: 'suggestions' },
  'setup-giveaway':   { marker: MARK_GIVEAWAY, build: buildGiveawayPanel, wanted: 'giveaways',        alt: 'giveaway',    label: 'giveaway' },
};

const commands = [
  new SlashCommandBuilder().setName('setup-livestream')
    .setDescription('Admin: Post (or refresh) the live-stream panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #live-stream)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('golive')
    .setDescription('Admin: Announce a stream with its link — leave the link blank to clear the announcement')
    .addStringOption(o => o.setName('link').setDescription('The stream link for THIS stream (blank = remove the announcement)').setRequired(false))
    .addStringOption(o => o.setName('title').setDescription('What the stream is, e.g. "Ranked grind with the spoofer on"').setRequired(false))
    .addStringOption(o => o.setName('game').setDescription('What you are playing').setRequired(false))
    .addRoleOption(o => o.setName('ping').setDescription('Role to notify (pick @everyone for everyone)').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Where to announce (defaults to #live-stream)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-clips')
    .setDescription('Admin: Post (or refresh) the post-your-clips panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #post-your-clips)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-postyourpc')
    .setDescription('Admin: Post (or refresh) the post-your-setup panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #post-your-pc)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-suggestions')
    .setDescription('Admin: Post (or refresh) the suggestions panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #suggestions)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-giveaway')
    .setDescription('Admin: Post (or refresh) the giveaways panel')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to #giveaways)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// findChannelByName is handed in rather than re-implemented: it is the
// NFKD-folding resolver, and the second server names its channels in
// mathematical bold, which toLowerCase() cannot touch.
async function handleCommunityCommand(interaction, { findChannel }) {
  const cmd = interaction.commandName;
  const spec = PANELS[cmd];
  if (!spec && cmd !== 'golive') return false;
  if (!gate.hasAccess(interaction)) {
    await interaction.reply({ content: '❌ No permission.', flags: 64 });
    return true;
  }
  await interaction.deferReply({ flags: 64 });

  const wanted = spec ? spec.wanted : 'live-stream';
  const alt    = spec ? spec.alt    : 'streams';
  const picked = interaction.options.getChannel('channel');
  const found  = picked || findChannel(interaction.guild, wanted) || findChannel(interaction.guild, alt);
  const channel = found || interaction.channel;
  const me = interaction.client.user;

  try {
    if (spec) {
      // Furniture. It renders one way, so re-running this can never turn it
      // into something else, and nothing outside this branch writes it.
      const { edited } = await upsertPanel(channel, spec.marker, withLanguage(spec.build(interaction.guild)), me);
      await interaction.editReply(`${edited ? '♻️ Refreshed' : '📌 Posted'} the ${spec.label} panel in <#${channel.id}>.`
        + (found ? '' : `\nℹ️ No **#${wanted}** channel here, so it went in this one.`));
      return true;
    }

    // ── /golive ───────────────────────────────────────────────────────────────
    // What this does NOT do is touch the panel. It used to, and that is the bug
    // being fixed: "./setup-livestream SHOULD BE LEFT ALONE IF POSTED."
    const raw = (interaction.options.getString('link') || '').trim();
    const previous = await findMarked(channel, MARK_LIVE_NOW, me);

    if (!raw) {
      // No link means take the announcement down. Nothing replaces it.
      const outcome = previous ? await retireAnnouncement(previous) : 'none';
      await interaction.editReply(
        outcome === 'deleted' ? `🧹 Removed the stream announcement from <#${channel.id}>. The panel is untouched.`
        : outcome === 'retired' ? `⚫ I could not delete the old announcement (no **Manage Messages** in <#${channel.id}>), so it now reads *Stream ended* instead. Grant that permission and the next one gets removed properly.`
        : outcome === 'failed' ? `⚠️ There is an announcement in <#${channel.id}> I can neither delete nor edit — check my permissions there.`
        : `ℹ️ There was no stream announcement in <#${channel.id}> to remove.`
          + `\nTo announce one, run this again with **link:** set.`);
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

    // "when ./golive url post happens, do have it remove the old one." The old
    // one goes BEFORE the new one is posted, so there is never a moment with
    // two cards in the channel both saying LIVE NOW.
    const outcome = previous ? await retireAnnouncement(previous) : 'none';

    const role = interaction.options.getRole('ping');
    // @everyone is a real role whose id is the guild id, and its mention form
    // `<@&guildId>` renders as a dead string rather than a ping. The literal is
    // the only thing that notifies.
    const content = role ? (role.id === interaction.guildId ? '@everyone' : `<@&${role.id}>`) : undefined;

    const card = await channel.send(withLanguage({ ...buildLiveCard(interaction.guild, live), ...(content ? { content } : {}) }));

    const p = platformOf(url);
    await interaction.editReply(`🔴 Announced in <#${channel.id}>${p ? ` (${p.name})` : ''}${role ? `, pinging ${role.id === interaction.guildId ? '@everyone' : `**${role.name}**`}` : ' with no ping'}.`
      + (outcome === 'deleted' ? ' The previous announcement was removed.'
         : outcome === 'retired' ? ' ⚠️ I could not delete the previous announcement (no **Manage Messages** here) so it was marked *Stream ended* instead.'
         : outcome === 'failed' ? ' ⚠️ The previous announcement is still standing — I can neither delete nor edit it.'
         : '')
      + `\nThe \`/setup-livestream\` panel was not touched.`
      + `\nWhen you stop, run \`/golive\` with **no link** and this announcement is removed.`
      + `\n${card.url}`);
    return true;
  } catch (e) {
    await interaction.editReply(`❌ Could not post there: ${e.message}`);
    return true;
  }
}

// ─── the panel buttons ────────────────────────────────────────────────────────
// The walkthroughs are ephemeral: they answer the person who pressed them, not
// another wall of text in a channel that was already too quiet. The other two
// open a modal, which is the only way to ask a member for a line of text
// without making them type a slash command they will never find.
async function handleCommunityButton(interaction) {
  // Staff only: "for /Setup-Livestream the 'Im going live' button make it only
  // for admin". A stream announcement is the server's, and it is the one post
  // in here that people turn notifications on for.
  //
  // The button stays visible to everyone because Discord cannot hide a
  // component from some readers and not others, so the refusal has to say
  // something useful rather than "no permission" — the member reading it is not
  // doing anything wrong, they are in the wrong channel for what they want.
  if (interaction.customId === 'live_go') {
    if (!gate.hasAccess(interaction)) {
      await interaction.reply({
        content: '🔴 Stream announcements in here are posted by staff.'
          + '\nIf you have a **clip**, the clips channel has a **Post a clip** button that puts it up under your name.',
        flags: 64,
      });
      return true;
    }
    const modal = new ModalBuilder().setCustomId('community_golive_modal').setTitle('Going live');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('link').setLabel('Your stream link').setStyle(TextInputStyle.Short)
        .setPlaceholder('https://twitch.tv/yourname').setRequired(true).setMaxLength(400)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('title').setLabel('What are you streaming? (optional)').setStyle(TextInputStyle.Short)
        .setPlaceholder('Ranked grind').setRequired(false).setMaxLength(120)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('game').setLabel('Game (optional)').setStyle(TextInputStyle.Short)
        .setPlaceholder('Rainbow Six Siege').setRequired(false).setMaxLength(80)),
    );
    await interaction.showModal(modal);
    return true;
  }

  // The member-facing one. Ungated on purpose: this is the button the round-38
  // note was actually asking for, and gating it would leave it on the panel
  // doing nothing for everybody it is aimed at.
  if (interaction.customId === 'clip_submit') {
    const modal = new ModalBuilder().setCustomId('community_clip_modal').setTitle('Post a clip');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('link').setLabel('Clip link').setStyle(TextInputStyle.Short)
        .setPlaceholder('https://medal.tv/... or a YouTube / Streamable / Twitch link')
        .setRequired(true).setMaxLength(400)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('title').setLabel('What happens in it? (optional)').setStyle(TextInputStyle.Short)
        .setPlaceholder('1v5 clutch with the spoofer on').setRequired(false).setMaxLength(120)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('game').setLabel('Game (optional)').setStyle(TextInputStyle.Short)
        .setPlaceholder('Rainbow Six Siege').setRequired(false).setMaxLength(80)),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.customId === 'suggest_new') {
    const modal = new ModalBuilder().setCustomId('community_suggest_modal').setTitle('Make a suggestion');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('text').setLabel('What should we do?').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Be specific — what, and why it would help.')
        .setRequired(true).setMinLength(12).setMaxLength(1500)),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.customId === 'pc_howto') {
    const embed = new EmbedBuilder()
      .setColor(0x00B0F4)
      .setTitle('❓ Posting your setup')
      .setDescription([
        '**1.** Take the photo in decent light — the whole desk, not just the tower.',
        '**2.** Drag it into this channel. Discord allows 10 MB without Nitro, which any phone photo fits.',
        '**3.** In the SAME message, list the parts.',
      ].join('\n'))
      .addFields(
        { name: 'Worth listing', value: 'CPU • GPU • RAM • storage • monitors (size and refresh rate) • keyboard • mouse • headset • chair.' },
        { name: 'Do not know your specs?', value: 'Press **Win + R**, type `dxdiag`, hit Enter. CPU and RAM are on the first tab, the GPU is on **Display**.' },
        { name: 'Check the photo first', value: 'Licence keys, order emails, your own name on a browser tab — all of it is readable in a screenshot. This channel is public.' },
      )
      .setFooter({ text: SITE_URL.replace(/^https?:\/\//, '') });
    await interaction.reply({ embeds: [embed], flags: 64 });
    return true;
  }

  if (interaction.customId === 'giveaway_howto') {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('❓ How the giveaways work')
      .setDescription([
        '**1.** A giveaway post appears in this channel with a countdown on it.',
        '**2.** Press **🎉 Participate** once. That is your entry — pressing again changes nothing.',
        '**3.** When the countdown runs out the winners are drawn at random and tagged here.',
      ].join('\n'))
      .addFields(
        { name: 'If you win', value: 'Open a ticket to claim. **Nobody will DM you first** — anyone who does is not us, and will not be asking for a payment either way.' },
        { name: 'Only one at a time', value: 'Starting a new giveaway clears the previous post and its results, so whatever is in this channel is the current one.' },
        { name: 'Missed it?', value: 'Turn notifications on for this channel. Each giveaway pings once when it starts and never again.' },
      )
      .setFooter({ text: SITE_URL.replace(/^https?:\/\//, '') });
    await interaction.reply({ embeds: [embed], flags: 64 });
    return true;
  }

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

// ─── the modals ───────────────────────────────────────────────────────────────
async function handleCommunityModal(interaction) {
  // The staff shortcut. This is `/golive` with the options asked for in a modal
  // instead: same announcement, same marker, and it replaces the standing one
  // whichever of the two posted it. None of the member-facing restrictions
  // apply — "Remove that restriction for admins" — so there is no cooldown and
  // no blocked-domain check, because whoever pressed it can already run
  // /golive with any link at all and gating one and not the other would only
  // be theatre.
  if (interaction.customId === 'community_golive_modal') {
    await interaction.deferReply({ flags: 64 });
    if (!gate.hasAccess(interaction)) {
      await interaction.editReply('❌ Stream announcements are staff-only.');
      return true;
    }
    const me = interaction.client.user;
    const channel = interaction.channel;

    const raw = (interaction.fields.getTextInputValue('link') || '').trim();
    const url = normalizeUrl(raw);
    if (!url) {
      await interaction.editReply(`❌ \`${raw.slice(0, 100)}\` is not a link I can post.`
        + `\nPaste the full address, e.g. \`https://twitch.tv/yourname\`, and try again.`);
      return true;
    }

    const live = {
      url,
      title: (interaction.fields.getTextInputValue('title') || '').trim() || null,
      game:  (interaction.fields.getTextInputValue('game')  || '').trim() || null,
      by: interaction.user.id,
    };

    try {
      const previous = await findMarked(channel, MARK_LIVE_NOW, me);
      const outcome = previous ? await retireAnnouncement(previous) : 'none';
      // The card names the streamer, and naming somebody is not the same as
      // ringing their phone about their own stream. A modal cannot carry a role
      // picker either, so this never pings the server — `/golive ping:` is
      // still the way to do that.
      const card = await channel.send({
        ...withLanguage(buildLiveCard(interaction.guild, live)),
        allowedMentions: { parse: [] },
      });
      const p = platformOf(url);
      await interaction.editReply(`🔴 Announced in <#${channel.id}>${p ? ` (${p.name})` : ''}, with no ping.`
        + (outcome === 'deleted' ? ' The previous announcement was removed.'
           : outcome === 'retired' ? ' ⚠️ I could not delete the previous announcement (no **Manage Messages** here) so it was marked *Stream ended* instead.' : '')
        + `\nTo ping a role with it, use \`/golive link: ping:\` instead.`
        + `\n${card.url}`);
    } catch (e) {
      await interaction.editReply(`❌ I could not post that here: ${e.message}`);
    }
    return true;
  }

  // The member-facing one, and the reason the live-stream button could become
  // staff-only without taking anything away from anybody: this is where a
  // member posts their own thing.
  if (interaction.customId === 'community_clip_modal') {
    await interaction.deferReply({ flags: 64 });
    const channel = interaction.channel;
    const key = `${interaction.guildId}:${interaction.user.id}`;

    const since = Date.now() - (lastClip.get(key) || 0);
    if (since < CLIP_COOLDOWN_MS) {
      const wait = Math.ceil((CLIP_COOLDOWN_MS - since) / 1000);
      await interaction.editReply(`⏳ You posted a clip a moment ago — try again in ${wait}s.`);
      return true;
    }

    const raw = (interaction.fields.getTextInputValue('link') || '').trim();
    const url = normalizeUrl(raw);
    if (!url) {
      await interaction.editReply(`❌ \`${raw.slice(0, 100)}\` is not a link I can post.`
        + `\nPaste the full address, e.g. \`https://medal.tv/clips/...\`, and try again.`);
      return true;
    }

    // The bot's name is on the post, so the post is the bot vouching for the
    // link. Anything on the server's own banned-domain list does not get that.
    // Loaded lazily and behind a try: an unavailable list must not take the
    // feature down, and requiring antiscam at the top of this file would drag
    // its start-up into every test that renders a panel.
    try {
      const { _internals } = require('./antiscam');
      const bad = _internals && _internals.hasBannedLink && _internals.hasBannedLink(url);
      if (bad && bad.found) {
        await interaction.editReply('❌ That domain is on this server\'s blocked list, so I will not post it.');
        return true;
      }
    } catch (_) { /* no list available — carry on */ }

    const clip = {
      url,
      title: (interaction.fields.getTextInputValue('title') || '').trim() || null,
      game:  (interaction.fields.getTextInputValue('game')  || '').trim() || null,
    };

    try {
      // No ping, ever. A member pressing a button must not be able to notify
      // anybody, and allowedMentions is pinned rather than left to the default
      // because the card carries their own mention.
      //
      // No `withLanguage` either. The translatable content of a clip post is a
      // title somebody typed and a game name, and the price of a dropdown here
      // is the whole player: translating rewrites the message, and a rewrite
      // with our text in it is a message with an app-supplied body Discord
      // re-scans — the unfurl is not guaranteed to survive it. The clip is
      // worth more than the dropdown.
      const card = await channel.send({
        ...buildClipCard(interaction.guild, interaction.member || interaction.user, clip),
        allowedMentions: { parse: [] },
      });
      lastClip.set(key, Date.now());
      const p = platformOf(url);
      await interaction.editReply(`🎬 Posted your clip in <#${channel.id}>${p ? ` (${p.name})` : ''}.`
        + `\n${card.url}`);
    } catch (e) {
      await interaction.editReply(`❌ I could not post that here: ${e.message}`);
    }
    return true;
  }

  if (interaction.customId === 'community_suggest_modal') {
    await interaction.deferReply({ flags: 64 });
    const text = (interaction.fields.getTextInputValue('text') || '').trim();
    if (text.length < 12) {
      await interaction.editReply('❌ That is too short to act on — say what you want and why in a sentence or two.');
      return true;
    }
    try {
      const card = await interaction.channel.send({
        ...buildSuggestionCard(interaction.guild, interaction.member || interaction.user, text),
        // The card mentions the author. Mentioning them is the point; pinging
        // them about their own suggestion is not.
        allowedMentions: { parse: [] },
      });
      // Reactions rather than buttons: Discord stores the count, so the vote
      // survives a redeploy. A button tally would need a table.
      for (const e of ['⬆️', '⬇️']) { try { await card.react(e); } catch (_) {} }
      // A thread keeps the discussion off the list, which is the thing that
      // makes a suggestion channel unreadable by the fifth suggestion.
      try {
        await card.startThread({ name: `💡 ${text.replace(/\s+/g, ' ').slice(0, 80)}`, autoArchiveDuration: 10080 });
      } catch (_) { /* no thread permission, or not a text channel */ }
      await interaction.editReply(`✅ Filed — it is up in <#${interaction.channel.id}> with voting on it.\n${card.url}`);
    } catch (e) {
      await interaction.editReply(`❌ I could not post that here: ${e.message}`);
    }
    return true;
  }

  return false;
}

module.exports = {
  commands, handleCommunityCommand, handleCommunityButton, handleCommunityModal,
  setCommunityGate,
  // Exported for the tests, which render the panels without a Discord connection.
  buildLivePanel, buildLiveCard, buildClipsPanel, buildClipCard, buildPcPanel,
  buildSuggestPanel, buildSuggestionCard, buildGiveawayPanel,
  endedCard, liveFromCard, retireAnnouncement,
  normalizeUrl, platformOf, findMarked,
  MARK_LIVE, MARK_LIVE_NOW, MARK_CLIPS, MARK_CLIP_POST, MARK_PC, MARK_SUGGEST,
  MARK_SUGGESTION, MARK_GIVEAWAY, MARK_GW_ENTRY, MARK_GW_RESULTS,
};
