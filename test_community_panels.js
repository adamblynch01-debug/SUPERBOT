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
const buttons = (payload) => json(payload).rows.flatMap(r => r.components);

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

  console.log('\nthe live-stream panel');

await check('an idle panel says nobody is live, and still has something on it', () => {
  const p = C.buildLivePanel(guild, null);
  const { embed } = json(p);
  assert.ok(/Live streams/.test(embed.title), embed.title);
  assert.ok(/Nobody is live/i.test(embed.description), embed.description);
  assert.ok(embed.fields.length >= 3, 'the idle panel is three lines and a full stop — the thing being fixed');
  // Nothing to point a Link button at when offline, and a Link button with no
  // URL rejects the message. The channel must not be left with a bare embed.
  assert.ok(buttons(p).some(b => b.custom_id === 'live_notify'), 'the offline panel has no button at all');
  assert.ok(!buttons(p).some(b => /Watch/.test(b.label || '')), 'an idle panel is offering a Watch button');
});

await check('a live panel carries THIS stream\'s link', () => {
  const p = C.buildLivePanel(guild, { url: 'https://twitch.tv/uh', title: 'Ranked grind', game: 'Rainbow Six' });
  const { embed } = json(p);
  assert.ok(/LIVE RIGHT NOW/.test(embed.title), embed.title);
  assert.strictEqual(embed.color, 0x9146FF, 'the panel is not wearing the platform colour');
  const watch = buttons(p).find(b => b.style === 5 && /Watch/.test(b.label));
  assert.strictEqual(watch.url, 'https://twitch.tv/uh');
  assert.ok(embed.fields.some(f => /Rainbow Six/.test(f.value)));
});

await check('every panel and card stays inside five rows and 6000 characters', () => {
  const long = { url: 'https://twitch.tv/uh', title: 'T'.repeat(400), game: 'G'.repeat(200) };
  for (const [what, p] of [
    ['idle panel',  C.buildLivePanel(guild, null)],
    ['live panel',  C.buildLivePanel(guild, long)],
    ['live card',   C.buildLiveCard(guild, long)],
    ['clips panel', C.buildClipsPanel(guild)],
  ]) {
    assert.ok(p.components.length <= 5, `${what}: ${p.components.length} rows`);
    const size = JSON.stringify(json(p).embed).length;
    assert.ok(size < 6000, `${what} is ${size} characters — over the cap the whole message is REJECTED`);
    json(p).rows.forEach(r => assert.ok(r.components.length <= 5, `${what}: too many components in a row`));
  }
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

await check('the previous announcement is closed before a new one goes up', () => {
  const s = src('modules/communityPanels.js');
  const golive = s.slice(s.indexOf('const raw = '), s.indexOf('const role = interaction.options.getRole'));
  assert.ok(/liveFromCard\(previous\)/.test(golive) && /endedCard\(previous\)/.test(golive),
    'two cards can stand in the channel both saying LIVE NOW');
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
  assert.ok(embed.fields.some(f => /paste/i.test(f.value)), 'nothing tells a member what to actually do');
  const b = buttons(p);
  assert.ok(b.some(x => x.custom_id === 'clips_howto'), 'no walkthrough button');
  assert.ok(b.some(x => x.style === 5 && /medal\.tv/.test(x.url || '')), 'no link to clipping software');
});

await check('both walkthroughs answer only the person who pressed them', () => {
  const s = src('modules/communityPanels.js');
  const fn = s.slice(s.indexOf('async function handleCommunityButton'));
  const replies = fn.match(/interaction\.reply\(\{[^}]*\}/g) || [];
  assert.strictEqual(replies.length, 2, `expected 2 button replies, found ${replies.length}`);
  replies.forEach(r => assert.ok(/flags: 64/.test(r), `a walkthrough is posting into the channel: ${r}`));
});

await check('a button this module does not own is passed on, not swallowed', async () => {
  // It is dispatched in a chain with every other button handler; returning true
  // for a foreign id would kill whatever was meant to answer it.
  assert.strictEqual(await C.handleCommunityButton({ customId: 'giveaway_enter' }), false);
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
  assert.ok(/setCommunityGate\(/.test(s), 'the staff gate was never installed — /golive would be public');
});

await check('the three commands are staff-only', () => {
  const names = C.commands.map(c => c.toJSON().name).sort();
  assert.deepStrictEqual(names, ['golive', 'setup-clips', 'setup-livestream']);
  // Belt and braces: the lockdown in index.js sets "0" for anything not in
  // PUBLIC_COMMANDS, and none of these are in it.
  const s = src('index.js');
  const pub = s.slice(s.indexOf('const PUBLIC_COMMANDS'), s.indexOf('let _lockedCount'));
  names.forEach(n => assert.ok(!pub.includes(`'${n}'`), `${n} is in PUBLIC_COMMANDS`));
  C.commands.forEach(c => assert.ok(c.toJSON().default_member_permissions != null, `${c.toJSON().name} has no default gate`));
});

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
}
