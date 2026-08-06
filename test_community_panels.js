// Round 37 — "DO THE SAME FOR THE LIVE-STREAM AND POST-YOUR-CLIPS CHANNEL.
// EXCEPT FOR THIS ONE GIVE ME OPTION TO ATTACH STREAM LINK EVERYTIME GOING
// LIVE. ALSO DO THE SAME FOR DOWNLOADS PUT THIS 2 IN ONE POST."
//
// The panels are the easy half. The half that can break a live server is the
// link: a Link button whose URL Discord will not accept does not render badly,
// it REJECTS THE WHOLE MESSAGE — so a typo'd stream link would mean the
// announcement never goes out at all, at the exact moment somebody went live.
// Most of this file is about that, about the panel and the announcement never
// disagreeing on whether a stream is running, and about the merged downloads
// post staying inside Discord's five rows.
//
//   node test_community_panels.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('./modules/communityPanels');

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

const guild = { name: 'UH SERVICES', id: 'G1', iconURL: () => 'https://cdn.example/icon.png' };
const json = (payload) => ({
  embed: payload.embeds[0].toJSON(),
  rows: payload.components.map(r => r.toJSON()),
});
// Same, for the cards that legitimately have no components at all — a
// suggestion is voted on with reactions, so it carries no row.
const json2 = (payload) => ({
  embed: payload.embeds[0].toJSON(),
  rows: (payload.components || []).map(r => r.toJSON()),
});
const buttons = (payload) => json(payload).rows.flatMap(r => r.components);
const footerOf = (payload) => json2(payload).embed.footer.text;

// Source, with the comments taken out. Every anchor below is a fact about the
// CODE, and the comment above a line often quotes the very rule it pins — which
// would let a check pass off nothing but its own explanation.
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');

main();
async function main() {

  console.log('\nthe stream link, which is the part that can reject a message');

await check('a link Discord would refuse never reaches a button', () => {
  for (const bad of ['', '   ', 'twitch', 'not a link', 'javascript:alert(1)', 'ftp://x.com/a', 'https://', '<>']) {
    assert.strictEqual(C.normalizeUrl(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

await check('a link typed the way people actually type it still works', () => {
  assert.strictEqual(C.normalizeUrl('twitch.tv/uhservices'), 'https://twitch.tv/uhservices');
  assert.strictEqual(C.normalizeUrl('  https://kick.com/uh  '), 'https://kick.com/uh');
  // Discord, and several clients, wrap a pasted URL in angle brackets to stop
  // it embedding. Handed to setURL() unchanged that is not a URL.
  assert.strictEqual(C.normalizeUrl('<https://youtu.be/abc>'), 'https://youtu.be/abc');
});

await check('a URL past the 512 characters a button allows is refused, not truncated', () => {
  // Truncating it would produce a valid-looking button pointing somewhere else.
  assert.strictEqual(C.normalizeUrl('https://twitch.tv/' + 'a'.repeat(600)), null);
  assert.ok(C.normalizeUrl('https://twitch.tv/' + 'a'.repeat(400)));
});

await check('the platform is read from the host, not from the string appearing anywhere', () => {
  assert.strictEqual(C.platformOf('https://twitch.tv/x').name, 'Twitch');
  assert.strictEqual(C.platformOf('https://www.kick.com/x').name, 'Kick');
  assert.strictEqual(C.platformOf('https://youtu.be/x').name, 'YouTube');
  // The trap: a host that merely ENDS in the brand, or carries it in the path,
  // is a different site. Getting this wrong paints an attacker's link purple
  // and labels it Twitch.
  assert.strictEqual(C.platformOf('https://nottwitch.tv/x'), null);
  assert.strictEqual(C.platformOf('https://evil.example/twitch.tv/x'), null);
  assert.strictEqual(C.platformOf('https://streams.example/x'), null, 'an unknown platform is a real answer');
});

  console.log('\nthe live-stream panel — furniture, one state, never written by /golive');

await check('the panel says what the channel is for and has something on it', () => {
  const p = C.buildLivePanel(guild);
  const { embed } = json(p);
  assert.ok(/Live streams/.test(embed.title), embed.title);
  assert.ok(embed.fields.length >= 3, 'the panel is three lines and a full stop — the thing being fixed');
  // Nothing to point a Link button at: there may be no stream, and a Link
  // button with no URL rejects the whole message.
  assert.ok(buttons(p).some(b => b.custom_id === 'live_notify'), 'no notify button');
  assert.ok(!buttons(p).some(b => /Watch/.test(b.label || '')), 'the panel is offering a Watch button');
});

await check('the panel has exactly ONE form, so /golive cannot render an announcement into it', () => {
  // Round 38: "at the moment after posting ./golive url, it makes 2 post +
  // removeS ./setup-livestream". It did, because buildLivePanel took a `live`
  // argument and had a second "🔴 LIVE RIGHT NOW" form to be overwritten with.
  // The argument is GONE — not ignored — so nothing can pass one again.
  assert.strictEqual(C.buildLivePanel.length, 1, 'buildLivePanel takes a second argument again');
  const a = json(C.buildLivePanel(guild)).embed;
  const b = json(C.buildLivePanel(guild, { url: 'https://twitch.tv/uh', title: 'x', game: 'y' })).embed;
  assert.deepStrictEqual({ ...a, timestamp: null }, { ...b, timestamp: null },
    'passing a stream to the panel changed it');
  assert.ok(!/LIVE RIGHT NOW/i.test(a.title), a.title);
});

await check('/golive never edits the panel — no code path outside setup writes MARK_LIVE', () => {
  const s = src('modules/communityPanels.js');
  // The ONE legitimate write is the table-driven upsert in the /setup- branch.
  const writes = s.match(/upsertPanel\(|\.edit\(withLanguage\(build\w*Panel/g) || [];
  assert.deepStrictEqual(writes, ['upsertPanel('],
    `the panel is written from more than one place: ${JSON.stringify(writes)}`);
  // Bounded at the end of the command handler: module.exports names MARK_LIVE
  // legitimately, and so does the /setup- branch above.
  const golive = s.slice(s.indexOf("const raw = (interaction.options.getString('link')"),
                         s.indexOf('async function handleCommunityButton'));
  assert.ok(!/MARK_LIVE\b(?!_NOW)/.test(golive), '/golive still references the panel marker');
  assert.ok(/panel was not touched/i.test(golive), '/golive does not tell the admin the panel was left alone');
});

await check('every panel and card stays inside five rows and 6000 characters', () => {
  const long = { url: 'https://twitch.tv/uh', title: 'T'.repeat(400), game: 'G'.repeat(200) };
  for (const [what, p] of [
    ['live panel',    C.buildLivePanel(guild)],
    ['live card',     C.buildLiveCard(guild, long)],
    ['member card',   C.buildLiveCard(guild, { ...long, by: '424242' })],
    ['clips panel',   C.buildClipsPanel(guild)],
    ['pc panel',      C.buildPcPanel(guild)],
    ['suggest panel', C.buildSuggestPanel(guild)],
    ['giveaway panel',C.buildGiveawayPanel(guild)],
    ['suggestion',    C.buildSuggestionCard(guild, { id: '7', user: { username: 'someone' } }, 'S'.repeat(1500))],
  ]) {
    assert.ok(p.components === undefined || p.components.length <= 5, `${what}: too many rows`);
    const size = JSON.stringify(json2(p).embed).length;
    assert.ok(size < 6000, `${what} is ${size} characters — over the cap the whole message is REJECTED`);
    (json2(p).rows || []).forEach(r => assert.ok(r.components.length <= 5, `${what}: too many components in a row`));
  }
});

await check('no marker is a substring of another one', () => {
  // The lookup is `footer.includes(marker)`, so a marker that contains another
  // makes a sweep match the wrong message. This is the rule that stops
  // /giveaway's clean-up from deleting /setup-giveaway's panel, and it is
  // checked mechanically because it is invisible by eye.
  const marks = [
    C.MARK_LIVE, C.MARK_CLIPS, C.MARK_PC, C.MARK_SUGGEST, C.MARK_GIVEAWAY,
    C.MARK_LIVE_NOW, C.MARK_SUGGESTION, C.MARK_GW_ENTRY, C.MARK_GW_RESULTS,
    C.MARK_CLIP_POST,
  ];
  for (const a of marks) for (const b of marks) {
    if (a === b) continue;
    assert.ok(!a.includes(b), `"${a}" contains "${b}" — a search for one finds the other`);
  }
  // And specifically the pair that would have cost a live panel.
  assert.ok(!C.MARK_GW_ENTRY.includes(C.MARK_GIVEAWAY) && !C.MARK_GW_RESULTS.includes(C.MARK_GIVEAWAY));
});

  console.log('\nthe announcement, and putting it to bed');

await check('the card is a fresh post with the link on it', () => {
  const p = C.buildLiveCard(guild, { url: 'https://kick.com/uh', title: null, game: null });
  const { embed } = json(p);
  assert.ok(/LIVE NOW/.test(embed.title));
  assert.strictEqual(embed.url, 'https://kick.com/uh');
  // In the description too: a Link button does not exist on a phone client
  // rendering an old embed, and it is not copy-pasteable anywhere.
  assert.ok(embed.description.includes('https://kick.com/uh'), embed.description);
});

await check('a card the stream is over no longer claims to be live', () => {
  // The reason this exists: a three-day-old post still saying LIVE NOW is how a
  // channel teaches people to ignore it.
  const live = json(C.buildLiveCard(guild, { url: 'https://twitch.tv/uh', title: 'Grind', game: null }));
  const ended = C.endedCard({ embeds: [live.embed] });
  const e = json(ended).embed;
  assert.ok(!/LIVE NOW/i.test(e.title), e.title);
  assert.ok(/Stream ended/i.test(e.title), e.title);
  // The link stays — on most platforms it is the VOD.
  assert.ok(json(ended).rows[0].components.some(b => b.url === 'https://twitch.tv/uh'));
  assert.ok(!json(ended).rows[0].components.some(b => /Watch now/.test(b.label || '')), 'still saying Watch now');
});

await check('whether a stream is running is read back off the channel, not remembered', () => {
  // There is no flag anywhere, which is exactly why this survives a redeploy.
  const live = json(C.buildLiveCard(guild, { url: 'https://twitch.tv/uh', title: 'Grind night', game: 'R6' }));
  const back = C.liveFromCard({ embeds: [live.embed] });
  assert.strictEqual(back.url, 'https://twitch.tv/uh');
  assert.strictEqual(back.title, 'Grind night', 'the title came back with the LIVE NOW prefix still on it');
  assert.strictEqual(back.game, 'R6');
});

await check('an ended card does not read as a live one', () => {
  const live = json(C.buildLiveCard(guild, { url: 'https://twitch.tv/uh', title: 'x', game: null }));
  const ended = json(C.endedCard({ embeds: [live.embed] }));
  assert.strictEqual(C.liveFromCard({ embeds: [ended.embed] }), null,
    'ending a stream and re-running /setup-livestream would put the panel back to LIVE');
  assert.strictEqual(C.liveFromCard(null), null);
  assert.strictEqual(C.liveFromCard({ embeds: [] }), null);
});

await check('the old announcement is REMOVED, and removed before the new one goes up', () => {
  // "when ./golive url post happens, do have it remove the old one." Retiring
  // it in place was the previous behaviour and is now only the fallback for a
  // failed delete — so what is pinned is the order: gone, then posted. The
  // other way round leaves a window with two cards both saying LIVE NOW.
  const s = src('modules/communityPanels.js');
  const golive = s.slice(s.indexOf('const raw = '), s.indexOf('const p = platformOf(url)'));
  const retire = golive.indexOf('retireAnnouncement(previous)');
  const send   = golive.indexOf('channel.send(');
  assert.ok(retire > 0, 'nothing removes the previous announcement');
  assert.ok(send > retire, 'the new card goes up before the old one comes down');
});

await check('a failed delete falls back to retiring the card, and says which happened', () => {
  // Deleting somebody else's message needs Manage Messages. A silent failure
  // there is the one that leaves two LIVE NOW cards standing, so the fallback
  // edits the old card instead — and the admin is told, because the fix is a
  // permission they have to grant.
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf('async function retireAnnouncement'), s.indexOf('function endedCard'));
  assert.ok(/message\.delete\(\)/.test(fn) && /return 'deleted'/.test(fn));
  assert.ok(/endedCard\(message\)/.test(fn), 'a delete the bot is not allowed leaves the card claiming to be live');
  assert.ok(/return 'failed'/.test(fn), 'both attempts failing reads as success');
  assert.ok(/Manage Messages/.test(s.slice(s.indexOf('const raw = '))), 'the admin is not told what to grant');
});

await check('a bad link stops the announcement instead of half-posting it', () => {
  const s = src('modules/communityPanels.js');
  const golive = s.slice(s.indexOf('const url = normalizeUrl(raw)'));
  const guardEnds = golive.indexOf('const live = {');
  assert.ok(guardEnds > 0 && /if\s*\(!url\)/.test(golive.slice(0, guardEnds)),
    'the link is used before it is checked');
  assert.ok(/return true;/.test(golive.slice(0, guardEnds)), 'the bad-link branch falls through and posts anyway');
});

  console.log('\nthe ping');

await check('@everyone is emitted as the literal, because the role mention does not ping', () => {
  // @everyone IS a role and its id IS the guild id, so getRole() hands it back
  // like any other. `<@&guildId>` renders as dead text — the one form that
  // notifies nobody, on the one option somebody picks to notify everybody.
  const s = src('modules/communityPanels.js');
  assert.ok(/role\.id === interaction\.guildId \? '@everyone'/.test(s), 'the @everyone case is not special-cased');
});

await check('no ping at all is the default', () => {
  const s = src('modules/communityPanels.js');
  assert.ok(/const content = role \?/.test(s), 'every /golive would ping something');
  assert.ok(/\.setName\('ping'\)/.test(s) && !/\.setName\('ping'\)[\s\S]{0,200}?setRequired\(true\)/.test(s),
    'the ping option is required');
});

  console.log('\nthe clips panel');

await check('the panel says what the channel is for and how to get a clip into it', () => {
  const p = C.buildClipsPanel(guild);
  const { embed } = json(p);
  assert.ok(/Post your clips/i.test(embed.title));
  assert.ok(embed.fields.some(f => /press the button/i.test(f.value)), 'nothing tells a member what to actually do');
  const b = buttons(p);
  assert.ok(b.some(x => x.custom_id === 'clip_submit'), 'no way for a member to post a clip');
  assert.ok(b.some(x => x.custom_id === 'clips_howto'), 'no walkthrough button');
  assert.ok(b.some(x => x.style === 5 && /medal\.tv/.test(x.url || '')), 'no link to clipping software');
});

await check('every walkthrough answers only the person who pressed it', () => {
  // Five replies now: the four walkthroughs (notify, clips, pc, giveaway) and
  // the refusal a non-staff member gets from the live-stream button. One
  // missing `flags: 64` and a button press dumps a wall of text into a channel.
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf('async function handleCommunityButton'), s.indexOf('async function handleCommunityModal'));
  const replies = fn.match(/interaction\.reply\(\{[^}]*\}/g) || [];
  assert.strictEqual(replies.length, 5, `expected 5 button replies, found ${replies.length}`);
  replies.forEach(r => assert.ok(/flags: 64/.test(r), `a walkthrough is posting into the channel: ${r}`));
  // And the three buttons that need a line of text open a modal.
  assert.strictEqual((fn.match(/showModal\(/g) || []).length, 3);
});

await check('a button this module does not own is passed on, not swallowed', async () => {
  // It is dispatched in a chain with every other button handler; returning true
  // for a foreign id would kill whatever was meant to answer it.
  assert.strictEqual(await C.handleCommunityButton({ customId: 'giveaway_enter' }), false);
});

  console.log('\nthe member-facing "Post a clip" button');

await check('the button opens a form rather than eating the press', () => {
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'clip_submit')"));
  assert.ok(/community_clip_modal/.test(fn.slice(0, 400)));
  // Three inputs, and only the link required — asking a member to fill in a
  // title before they can post is how a button stops being used.
  const modal = fn.slice(0, fn.indexOf('showModal'));
  assert.strictEqual((modal.match(/setCustomId\('(link|title|game)'\)/g) || []).length, 3);
  assert.strictEqual((modal.match(/setRequired\(true\)/g) || []).length, 1);
});

await check('the clip PLAYS, which means the URL is in the message body and not only the embed', () => {
  // Discord builds a player for a link it finds in `content`. A URL inside an
  // embed never gets one — the same rule that meant no post of ours could have
  // a preview card. Without this the clip channel is a wall of cards nobody
  // clicks, which is the whole thing it was asked not to be.
  const member = { id: '77', user: { globalName: 'Someone' }, displayAvatarURL: () => 'https://cdn/a.png' };
  const p = C.buildClipCard(guild, member, { url: 'https://medal.tv/clips/xyz', title: '1v5', game: 'Siege' });
  assert.strictEqual(p.content, 'https://medal.tv/clips/xyz',
    'the clip link is not in the message body, so Discord will not play it');
  const { embed } = json(p);
  assert.ok(/1v5/.test(embed.title), embed.title);
  assert.strictEqual(embed.url, 'https://medal.tv/clips/xyz');
  assert.strictEqual(embed.author.name, 'Someone');
  assert.ok(embed.description.includes('<@77>'), 'the card does not say whose clip it is');
  assert.ok(embed.fields.some(f => /Siege/.test(f.value)), 'the game was typed in and dropped');
  assert.ok(buttons(p).some(b => b.style === 5 && b.url === 'https://medal.tv/clips/xyz'), 'no Watch button');
  assert.ok(buttons(p).some(b => b.custom_id === 'clip_submit'), 'no way to post one from a clip');
});

await check('a clip with nothing typed in it still renders', () => {
  const member = { id: '77', user: { username: 'someone' }, displayAvatarURL: () => 'https://cdn/a.png' };
  const p = C.buildClipCard(guild, member, { url: 'https://streamable.com/abc', title: null, game: null });
  assert.ok(json(p).embed.title.length > 2, 'an untitled clip has no title at all');
  assert.strictEqual(p.content, 'https://streamable.com/abc');
});

await check('a clip is never swept — the channel is meant to fill up', () => {
  // This is the difference between #post-your-clips and #live-stream. A stream
  // announcement is only interesting while the stream is on; a clip is worth
  // watching next month. Nothing may retire or replace one.
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_clip_modal')"),
                     s.indexOf('return false;\n}\n\nmodule.exports'));
  assert.ok(!/retireAnnouncement|findMarked/.test(fn), 'posting a clip removes another message');
  // The marker exists so a clip can be RECOGNISED, not so it can be found and
  // removed. Three mentions is all there should be: the constant, the footer it
  // is stamped into, and the export. A fourth is something looking for clips.
  assert.strictEqual((s.match(/MARK_CLIP_POST/g) || []).length, 3,
    'something else has started using the clip marker — check it is not a sweep');
  assert.ok(!/MARK_CLIP_POST/.test(src('index.js')), 'index.js has started hunting for clips');
});

await check('a member pressing the clip button can never ping anybody', () => {
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_clip_modal')"));
  const send = fn.slice(fn.indexOf('channel.send('), fn.indexOf('lastClip.set'));
  assert.ok(/allowedMentions: \{ parse: \[\] \}/.test(send),
    'the card mentions the author, so the default would notify them and any role they type');
  // And it is rate-limited, because the button is on a public panel and clips
  // accumulate rather than replacing each other.
  assert.ok(/CLIP_COOLDOWN_MS/.test(fn.slice(0, fn.indexOf('const raw'))), 'no cooldown');
});

await check('a member cannot get the bot to vouch for a blocked domain', () => {
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_clip_modal')"));
  const guard = fn.slice(0, fn.indexOf('const clip = {'));
  assert.ok(/hasBannedLink/.test(guard), 'any link a member types goes out under the bot\'s name unchecked');
  assert.ok(/normalizeUrl\(raw\)/.test(guard) && /if \(!url\)/.test(guard));
  // Lazily required: antiscam's start-up must not be dragged into a panel
  // render, and an unavailable list must not take the button down.
  assert.ok(/require\('\.\/antiscam'\)/.test(guard) && /catch \(_\)/.test(guard));
});

  console.log('\n"I\'m going live" is staff-only');

await check('the button is still ON the panel — "we keep it just adjust it"', () => {
  const b = buttons(C.buildLivePanel(guild));
  assert.ok(b.some(x => x.custom_id === 'live_go'), 'the going-live button was removed rather than gated');
  // And the panel no longer tells every reader to press it, because most of
  // them now cannot. A button that refuses the people it invited is worse than
  // no button.
  const { embed } = json(C.buildLivePanel(guild));
  const blurb = embed.description + JSON.stringify(embed.fields);
  assert.ok(!/Streaming yourself/i.test(blurb), 'the panel still invites members to announce a stream');
  assert.ok(/Staff/i.test(blurb), 'nothing says who the button is for');
});

await check('a member who presses it is told where to go instead, and gets no form', async () => {
  // The button cannot be hidden from some readers and shown to others, so the
  // refusal is the only thing standing between a member and the server's
  // stream announcement. The default gate is closed.
  let replied = null, modalled = false;
  const handled = await C.handleCommunityButton({
    customId: 'live_go',
    reply: async (p) => { replied = p; },
    showModal: async () => { modalled = true; },
  });
  assert.strictEqual(handled, true, 'the press was passed on to another handler');
  assert.strictEqual(modalled, false, 'a member was given the announcement form');
  assert.ok(replied && replied.flags === 64, 'the refusal was posted into the channel');
  assert.ok(/clip/i.test(replied.content), 'the refusal does not tell them where their clip goes');
});

await check('staff get the form', async () => {
  C.setCommunityGate({ hasAccess: () => true });
  try {
    let modalled = false;
    await C.handleCommunityButton({ customId: 'live_go', showModal: async () => { modalled = true; }, reply: async () => {} });
    assert.ok(modalled, 'staff cannot use the button either, which makes it dead furniture');
  } finally {
    C.setCommunityGate({ hasAccess: () => false });
  }
});

await check('the gate is on the MODAL too, not only the button', () => {
  // A modal is submitted by customId. Anyone who has ever legitimately opened
  // this one can re-submit it later, and a button-only check would let a
  // demoted admin keep posting announcements.
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_golive_modal')"));
  assert.ok(/gate\.hasAccess\(interaction\)/.test(fn.slice(0, fn.indexOf('const raw'))),
    'the announcement form trusts whoever submits it');
});

await check('there is ONE announcement, whichever way it was posted', () => {
  // It used to be filed under `live-by:<id>` when a member posted it, so that a
  // member replaced only their own. With the button staff-only that split has
  // no user left, and keeping it would mean /golive and the button quietly
  // failing to replace each other.
  const withBy = footerOf(C.buildLiveCard(guild, { url: 'https://twitch.tv/a', by: '111' }));
  const without = footerOf(C.buildLiveCard(guild, { url: 'https://twitch.tv/c' }));
  assert.ok(withBy.includes(C.MARK_LIVE_NOW) && without.includes(C.MARK_LIVE_NOW));
  assert.ok(!withBy.includes('live-by:'), 'a per-member marker is back');
  assert.strictEqual(C.markLiveBy, undefined, 'the per-member marker helper is still exported');
  // The card still says WHO, by mention — a username would go stale on a rename.
  assert.ok(json2(C.buildLiveCard(guild, { url: 'https://twitch.tv/a', by: '111' })).embed.description.includes('<@111>'));
});

await check('the admin restrictions are gone, not merely unreachable', () => {
  // "Remove that restriction for admins." Whoever can press this can already
  // run /golive with any link at all, so a cooldown and a domain check on the
  // button are theatre that only slows staff down mid-stream.
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_golive_modal')"),
                     s.indexOf("if (interaction.customId === 'community_clip_modal')"));
  assert.ok(!/COOLDOWN/.test(fn), 'staff are still rate-limited on their own announcement');
  assert.ok(!/hasBannedLink/.test(fn), 'staff links are still run past the members\' blocked list');
  // The link is still checked for being a LINK — that one is not a
  // restriction, it is the thing that stops the message being rejected.
  assert.ok(/normalizeUrl\(raw\)/.test(fn));
});

await check('the button replaces the standing announcement, exactly like /golive', () => {
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_golive_modal')"),
                     s.indexOf("if (interaction.customId === 'community_clip_modal')"));
  assert.ok(/findMarked\(channel, MARK_LIVE_NOW, me\)/.test(fn), 'it does not look for the old announcement');
  assert.ok(/retireAnnouncement\(previous\)/.test(fn), 'the old announcement is left up');
  // A modal cannot carry a role picker, so this path never pings — and it says
  // so, rather than leaving staff wondering why nobody saw it.
  assert.ok(/no ping/.test(fn) && /\/golive/.test(fn), 'nothing tells staff how to ping with it');
});

  console.log('\nthe post-your-pc and suggestions panels');

await check('each panel says what its channel is for and has a way in', () => {
  const pc = C.buildPcPanel(guild);
  assert.ok(/setup/i.test(json2(pc).embed.title), json2(pc).embed.title);
  assert.ok(buttons(pc).some(b => b.custom_id === 'pc_howto'), 'no walkthrough on the pc panel');
  const sg = C.buildSuggestPanel(guild);
  assert.ok(/Suggestions/i.test(json2(sg).embed.title), json2(sg).embed.title);
  assert.ok(buttons(sg).some(b => b.custom_id === 'suggest_new'), 'no way to file a suggestion');
  const gw = C.buildGiveawayPanel(guild);
  assert.ok(/Giveaway/i.test(json2(gw).embed.title), json2(gw).embed.title);
  assert.ok(buttons(gw).some(b => b.custom_id === 'giveaway_howto'), 'no walkthrough on the giveaway panel');
});

await check('a filed suggestion credits the author without pinging them, and gets a vote', () => {
  const card = C.buildSuggestionCard(guild, { id: '55', user: { username: 'someone' } }, 'Add a bot command for X');
  const { embed } = json2(card);
  assert.ok(embed.description.includes('Add a bot command for X'));
  assert.ok(JSON.stringify(embed).includes('<@55>'), 'the suggestion does not say who made it');
  assert.ok(embed.footer.text.includes(C.MARK_SUGGESTION));
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf("if (interaction.customId === 'community_suggest_modal')"));
  assert.ok(/allowedMentions: \{ parse: \[\] \}/.test(fn));
  // Reactions, not buttons: Discord stores the count so the vote survives a
  // redeploy. A button tally would need a table this bot has not got.
  assert.ok(/react\(e\)/.test(fn) && /'⬆️', '⬇️'/.test(fn), 'the suggestion cannot be voted on');
  assert.ok(/startThread\(/.test(fn), 'discussion goes in the list itself and buries the next suggestion');
});

  console.log('\nclearing the old giveaway, and leaving its panel alone');

await check('a new giveaway sweeps the previous post AND its results', () => {
  const s = src('index.js');
  const fn = s.slice(s.indexOf('async function clearOldGiveaway'), s.indexOf('async function saveVouches') + 1 || undefined);
  assert.ok(fn.length > 100, 'clearOldGiveaway is gone');
  assert.ok(/MARK_GW_ENTRY/.test(fn) && /MARK_GW_RESULTS/.test(fn),
    'the results post is left behind — "it clears the old giveaway + giveaway results"');
  assert.ok(/m\.author\.id !== client\.user\.id/.test(fn), 'it would delete a member\'s message');
});

await check('the sweep can never take the /setup-giveaway panel with it', () => {
  // This is the whole reason the disposable markers are not prefixed `panel:`:
  // the lookup is includes(), so `panel:giveaway-live` would have been found by
  // a search for `panel:giveaway`. Two independent guards, because losing the
  // panel is exactly what the user asked to have stopped.
  const s = src('index.js');
  const fn = s.slice(s.indexOf('async function clearOldGiveaway'));
  assert.ok(/includes\(MARK_GIVEAWAY\)\)\) continue;/.test(fn.slice(0, fn.indexOf('m.delete()'))),
    'nothing explicitly spares the panel');
  assert.ok(!C.MARK_GW_ENTRY.includes(C.MARK_GIVEAWAY) && !C.MARK_GW_RESULTS.includes(C.MARK_GIVEAWAY));
});

await check('it is swept BEFORE the new giveaway is posted, and the count is reported', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (cmd === 'giveaway')"));
  const swept = h.indexOf('clearOldGiveaway(');
  const sent  = h.indexOf('.send({ embeds: [embed]');
  assert.ok(swept > 0, '/giveaway does not clear the old one');
  assert.ok(sent > swept, 'the old giveaway is cleared after the new one is posted');
  assert.ok(/Cleared \$\{swept\.length\}/.test(h), 'posts are deleted without a word');
  assert.ok(/panel was left alone/i.test(h), 'the admin is not told the panel survived');
});

await check('an ENDED giveaway keeps its marker, or the next sweep cannot find it', () => {
  // endGiveaway REPLACES the entry card's footer with "Ended on …". Leaving the
  // marker off there would hide every finished giveaway from the clean-up —
  // which is the state the channel is in most of the time.
  const s = src('index.js');
  const fn = s.slice(s.indexOf('async function endGiveaway'), s.indexOf('async function clearOldGiveaway'));
  assert.ok(fn.length > 100, 'the three end-blocks were not consolidated');
  const footer = fn.split('\n').find(l => /setFooter/.test(l) && /Ended on/.test(l));
  assert.ok(footer && footer.includes('MARK_GW_ENTRY'), `the ended footer drops the marker: ${footer}`);
  assert.ok(/MARK_GW_RESULTS/.test(fn), 'the results post is unmarked and can never be cleared');
  assert.ok(/gw\.imageUrl/.test(fn), 'ending a giveaway loses its image');
});

  console.log('\nthe merged downloads post');

await check('the site link and the dropdowns are one message', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (cmd === 'setupdownloads')"), s.indexOf("if (cmd === 'setdownload')"));
  assert.ok(/linkRow/.test(h) && /components: \[linkRow, \.\.\.shownChunks/.test(h),
    'the link is still a separate post');
  assert.ok(/DOWNLOADS_URL/.test(h), 'the downloads URL is not on the panel');
  assert.strictEqual((h.match(/dlCh\.send\(/g) || []).length, 0, 'still sending a second message');
});

await check('re-running it edits the panel instead of stacking another', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (cmd === 'setupdownloads')"), s.indexOf("if (cmd === 'setdownload')"));
  assert.ok(/upsertPanel\(dlCh, MARK_DOWNLOADS/.test(h), 'no upsert — every run posts a duplicate');
  assert.ok(/MARK_DOWNLOADS/.test(s.slice(0, s.indexOf('client.once'))), 'the marker is not defined');
  // And the marker has to be IN the footer, or upsertPanel cannot find it.
  const footer = h.split('\n').find(l => l.includes('setFooter'));
  assert.ok(footer && footer.includes('MARK_DOWNLOADS'), `the footer does not carry the marker: ${footer}`);
});

await check('the link row costs a row, so the pages are capped and the shortfall is SAID', () => {
  // Five rows is the cap and a sixth rejects the whole message. downloads.js
  // pages at 25 and stops at 5 pages; with a link row there is room for 4. A
  // silent cap here would read as "everything is listed" when it is not.
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (cmd === 'setupdownloads')"), s.indexOf("if (cmd === 'setdownload')"));
  assert.ok(/const MENU_ROWS = 4/.test(h), 'the page budget is not stated');
  assert.ok(/chunks\.slice\(0, MENU_ROWS\)/.test(h));
  assert.ok(/notShown > 0 \?/.test(h), 'products that did not fit are dropped without a word');
  assert.ok(/Page \$\{i \+ 1\} of \$\{shownChunks\.length\}/.test(h),
    'the page labels count pages that are not on the panel');
});

await check('the cleanup only removes a post that is nothing but the link', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf('const superseded = []'), s.indexOf('await interaction.editReply({\n          content: `${edited'));
  assert.ok(/m\.author\.id !== client\.user\.id/.test(h), 'it would delete a member\'s message');
  assert.ok(/panel:/.test(h), 'it would delete another panel');
  assert.ok(/if \(body\) continue;/.test(h), 'a post with a sentence in it would be deleted');
  assert.ok(/superseded\.push\(m\.id\)/.test(h) && /Removed \$\{superseded\.length\}/.test(s),
    'a deletion happens without being reported');
});

await check('the dropdown ids the old panels use still resolve', () => {
  // A panel already in the channel keeps working: the handler matches
  // `dl_page_N` and the option value is still the product id.
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (cmd === 'setupdownloads')"), s.indexOf("if (cmd === 'setdownload')"));
  assert.ok(/dl_page_\$\{i \+ 1\}/.test(h));
  assert.ok(/value: p\.id/.test(h), 'the option value changed — every existing panel would 404');
});

  console.log('\nand it is wired in');

await check('index.js registers the commands and dispatches both entry points', () => {
  const s = src('index.js');
  assert.ok(/communityCommands\.map/.test(s), 'the commands are not registered');
  assert.ok(/handleCommunityCommand\(interaction, \{ findChannel: findChannelByName \}\)/.test(s),
    'the commands are not dispatched — or not with the NFKD resolver, which the second server needs');
  assert.ok(/handleCommunityButton\(interaction\)/.test(s), 'the buttons are not dispatched');
  // Without this the two member-facing buttons open a form that goes nowhere.
  assert.ok(/handleCommunityModal\(interaction\)/.test(s), 'the panel modals are not dispatched');
  assert.ok(/setCommunityGate\(/.test(s), 'the staff gate was never installed — /golive would be public');
});

await check('all six commands are staff-only', () => {
  const names = C.commands.map(c => c.toJSON().name).sort();
  assert.deepStrictEqual(names, ['golive', 'setup-clips', 'setup-giveaway',
    'setup-livestream', 'setup-postyourpc', 'setup-suggestions']);
  // Belt and braces: the lockdown in index.js sets "0" for anything not in
  // PUBLIC_COMMANDS, and none of these are in it.
  const s = src('index.js');
  const pub = s.slice(s.indexOf('const PUBLIC_COMMANDS'), s.indexOf('let _lockedCount'));
  names.forEach(n => assert.ok(!pub.includes(`'${n}'`), `${n} is in PUBLIC_COMMANDS`));
  C.commands.forEach(c => assert.ok(c.toJSON().default_member_permissions != null, `${c.toJSON().name} has no default gate`));
});

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}
