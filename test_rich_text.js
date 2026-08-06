// Round 38 — "Why my bot can[not] post link in a post like that?"
//
// Two screenshots came with that: somebody else's post with a proper preview
// card under it, and ours rendering
//
//     • # ⚠️ INJECTION ERROR FIX
//     🔗 [https://one.one.one.one/](https://one.one.one.one/)
//
// as literal characters. Three independent rules about embeds were being
// broken, and each one is pinned below, because every one of them is the kind
// of thing that looks fine in the modal and only goes wrong once posted.
//
//   node test_rich_text.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('./modules/richText');

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');

console.log('\nthe markdown people actually paste');

check('a heading becomes bold, because a heading does not render behind a bullet', () => {
  // This is the exact line from the screenshot. `# ` is only a heading at the
  // START of a line, and the notes box glued `• ` in front of it.
  assert.strictEqual(R.normalizeMarkdown('# ⚠️ INJECTION ERROR FIX'), '**⚠️ INJECTION ERROR FIX**');
  assert.strictEqual(R.normalizeMarkdown('### Small one'), '**Small one**');
  assert.strictEqual(R.normalizeMarkdown('## Closed form ##'), '**Closed form**');
});

check('a # that is not a heading is left alone', () => {
  // Channel mentions, C#, and "issue #4" all start with the same character.
  assert.strictEqual(R.normalizeMarkdown('#general is the place'), '#general is the place');
  assert.strictEqual(R.normalizeMarkdown('fixed in #4'), 'fixed in #4');
  assert.strictEqual(R.normalizeMarkdown('C# and F#'), 'C# and F#');
});

check('[url](url) is unwrapped to the bare url', () => {
  // The second line of the screenshot. A bare URL auto-links inside an embed
  // with no markdown involved, so it cannot be mis-parsed by any client.
  assert.strictEqual(
    R.normalizeMarkdown('🔗 [https://one.one.one.one/](https://one.one.one.one/)'),
    '🔗 https://one.one.one.one/');
  // Same address written two ways is still the same address.
  assert.strictEqual(R.normalizeMarkdown('[one.one.one.one](https://one.one.one.one/)'), 'https://one.one.one.one/');
  assert.strictEqual(R.normalizeMarkdown('[www.uhservices.xyz](https://uhservices.xyz)'), 'https://uhservices.xyz');
});

check('a REAL masked link is left exactly as it was', () => {
  // Unwrapping this one would replace the words the admin chose with a URL.
  const real = 'Read the [setup guide](https://uhservices.xyz/guide) first.';
  assert.strictEqual(R.normalizeMarkdown(real), real);
});

check('angle brackets around a link are dropped', () => {
  // `<url>` means "do not unfurl this". There is nothing to unfurl inside an
  // embed, so the brackets are two stray characters on the screen.
  assert.strictEqual(R.normalizeMarkdown('Go to <https://uhservices.xyz>'), 'Go to https://uhservices.xyz');
});

check('a paste with a wall of blank lines is closed up, and trimmed', () => {
  assert.strictEqual(R.normalizeMarkdown('\n\na\n\n\n\n\nb\n\n'), 'a\n\nb');
  assert.strictEqual(R.normalizeMarkdown(''), '');
  assert.strictEqual(R.normalizeMarkdown(null), '');
});

check('windows line endings do not survive into the embed', () => {
  assert.strictEqual(R.normalizeMarkdown('# Title\r\nbody'), '**Title**\nbody');
});

console.log('\nthe notes box');

check('a pipe still means bullets — that is what the box has always done', () => {
  assert.strictEqual(R.formatNotes('fixed crash | new menu | faster'), '• fixed crash\n• new menu\n• faster');
  assert.strictEqual(R.formatNotes('one ||  two '), '• one\n• two', 'an empty segment became an empty bullet');
});

check('no pipe means prose, NOT one bullet wrapped around the whole paste', () => {
  // The bug: `notesRaw.split('|').map(n => \`• ${n}\`)` with no pipe in it
  // produced a single bullet containing everything, which is what put `# ` in
  // a position where it could not render.
  const pasted = '# ⚠️ INJECTION ERROR FIX\n\nIf you are injecting, use this VPN first:\n\nhttps://one.one.one.one/';
  const out = R.formatNotes(pasted);
  assert.ok(!out.startsWith('•'), `still bulleting a paste: ${JSON.stringify(out.slice(0, 40))}`);
  assert.ok(out.startsWith('**⚠️ INJECTION ERROR FIX**'), out.slice(0, 40));
  assert.strictEqual((out.match(/•/g) || []).length, 0);
});

check('an empty notes box is null, not an empty field', () => {
  // An embed field with an empty value is rejected by Discord.
  assert.strictEqual(R.formatNotes(''), null);
  assert.strictEqual(R.formatNotes('   \n  '), null);
  assert.strictEqual(R.formatNotes(undefined), null);
});

console.log('\nthe preview card, which is the thing that was actually asked for');

check('the first link in the body is pulled out to go in plain content', () => {
  // An embed NEVER gets a preview card. The post in the screenshot the user
  // liked was an ordinary message with a URL in it.
  assert.deepStrictEqual(R.previewLinks('use https://one.one.one.one/ first'), ['https://one.one.one.one/']);
  assert.deepStrictEqual(R.previewLinks('nothing here'), []);
});

check('a link at the end of a sentence does not take the full stop with it', () => {
  assert.deepStrictEqual(R.previewLinks('Get it at https://uhservices.xyz.'), ['https://uhservices.xyz']);
  assert.deepStrictEqual(R.previewLinks('(see https://uhservices.xyz)'), ['https://uhservices.xyz']);
});

check('the same address twice is one card, and two is the cap', () => {
  const many = 'https://a.com https://a.com/ https://b.com https://c.com https://d.com';
  assert.deepStrictEqual(R.previewLinks(many), ['https://a.com', 'https://b.com']);
});

check('the download link is skipped — it already has a button', () => {
  assert.deepStrictEqual(
    R.previewLinks('grab it: https://uhservices.xyz/dl and read https://uhservices.xyz/guide',
      { skip: ['https://uhservices.xyz/dl/'] }),
    ['https://uhservices.xyz/guide']);
});

check('withPreview keeps the ping on the first line and hangs the link under it', () => {
  assert.strictEqual(R.withPreview('@everyone', 'see https://x.com'), '@everyone\nhttps://x.com');
});

check('withPreview returns undefined rather than an empty string', () => {
  // Discord rejects a message whose content key is present but empty, and
  // `content: ''` is exactly what a naive join produces on a post with no ping
  // and no link — i.e. most of them.
  assert.strictEqual(R.withPreview('', 'no links in here'), undefined);
  assert.strictEqual(R.withPreview('', ''), undefined);
  assert.strictEqual(R.withPreview('@here', ''), '@here');
});

check('a monstrous "url" is not echoed into content', () => {
  assert.deepStrictEqual(R.previewLinks('https://x.com/' + 'a'.repeat(500)), []);
});

console.log('\nthe caps that reject a whole message');

check('a note too long for a field is moved, not truncated', () => {
  assert.strictEqual(R.fitsField('x'.repeat(1024)), true);
  assert.strictEqual(R.fitsField('x'.repeat(1025)), false, 'a 1025-character field REJECTS the whole message');
  assert.strictEqual(R.fitsField(''), false);
});

check('a description past 4096 is clamped rather than rejected', () => {
  const out = R.clampDescription('y'.repeat(5000));
  assert.strictEqual(out.length, 4096);
  assert.ok(out.endsWith('…'));
  assert.strictEqual(R.clampDescription('short'), 'short');
});

console.log('\nand the three commands actually use it');

check('/postupdate normalises the notes, moves a long one, and echoes the link', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (interaction.customId === 'update_modal')"),
                    s.indexOf("if (interaction.customId === 'announce_modal')"));
  assert.ok(/const notes = formatNotes\(notesRaw\)/.test(h), 'still bulleting the whole paste');
  assert.ok(!/notesRaw\.split\('\|'\)/.test(h), 'the old one-bullet-for-everything code is still there');
  assert.ok(/fitsField\(notes\)/.test(h) && /setDescription\(clampDescription\(notes\)\)/.test(h),
    'a note over 1024 characters still rejects the whole message');
  assert.ok(/withPreview\('', notes, \{ skip: \[downloadUrl, imageUrl\] \}\)/.test(h),
    'no preview card, or it duplicates the download button');
  assert.ok(/content: previewContent/.test(h), 'the link is not put where Discord will unfurl it');
});

check('/announce normalises the body and keeps the ping above the link', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (interaction.customId === 'announce_modal')"),
                    s.indexOf("if (interaction.customId === 'setstatus_modal')"));
  assert.ok(/normalizeMarkdown\(message\)/.test(h), 'a pasted heading still renders as a # ');
  assert.ok(/withPreview\(pingText, body/.test(h), 'the ping was dropped, or there is no preview');
  assert.ok(/clampDescription\(body\)/.test(h), 'a 5000-character announcement is rejected by Discord');
});

check('/setstatus got the same treatment', () => {
  const s = src('index.js');
  const h = s.slice(s.indexOf("if (interaction.customId === 'setstatus_modal')"),
                    s.indexOf("if (interaction.customId === 'reseller_links_modal')"));
  assert.ok(/formatNotes\(notesRaw\)/.test(h) && !/notesRaw\.split\('\|'\)/.test(h));
  assert.ok(/withPreview\(pingText, ssNotes\)/.test(h));
  assert.ok(/fitsField\(ssNotes\)/.test(h));
});

check('nothing left in index.js still bullets a whole paste', () => {
  // There were three copies of this line. A fourth appearing later would bring
  // the bug back in a command nobody thought to check.
  const s = src('index.js');
  const left = s.match(/\.split\('\|'\)\.map\(n => `• /g) || [];
  assert.deepStrictEqual(left, [], `${left.length} copy/copies of the old bullet code remain`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
