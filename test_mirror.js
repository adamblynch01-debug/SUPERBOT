// Cross-server mirroring.
//
// Almost everything pinned here is about a loop not happening. A mirror that
// drops a post is a missing post; a mirror that feeds itself generates
// messages between two servers as fast as the API allows until the bot is
// rate-limited off the gateway and every other feature stops with it.
//
// The rest is about a mirrored post not acting like a native one: not pinging
// a server that never asked to be pinged, and not carrying buttons that mean
// something in the server it came from.
//
//   node test_mirror.js
'use strict';

const assert = require('assert');
const M = require('./modules/mirror');

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

const msg = (o = {}) => ({
  id: 'm1', type: 0, content: 'hello', embeds: [], components: [],
  attachments: new Map(), stickers: new Map(),
  author: { id: 'BOT', bot: true }, ...o,
});
const ROUTE = { botOnly: true };

// ─── Loops ───────────────────────────────────────────────────────────────────
check('a message from our own mirror webhook is never mirrored again', () => {
  // The primary loop: B receives a mirror of A's post, sees a new message in
  // B, and mirrors it back to A. Forever.
  const ctx = { mirrorWebhookIds: new Set(['WH1']) };
  const r = M.shouldMirror(msg({ webhookId: 'WH1' }), ROUTE, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/mirrored/.test(r.why));
});

check('a webhook we do not own passes the loop guard, and is judged on its author', () => {
  // The loop guard is about OUR webhooks only — someone else's is not a mirror
  // coming back. Whether it then gets carried is the bot_only question below,
  // and on an opened-up route it does.
  const ctx = { mirrorWebhookIds: new Set(['WH1']) };
  const r = M.shouldMirror(msg({ webhookId: 'OTHER' }), ROUTE, ctx);
  assert.strictEqual(r.ok, true, 'no selfId configured — legacy author.bot reading');
  assert.strictEqual(
    M.shouldMirror(msg({ webhookId: 'OTHER' }), { botOnly: true, includeOtherBots: true },
      { ...ctx, selfId: 'BOT' }).ok, true);
});

check('a message this bot posted as a mirror is not re-mirrored', () => {
  // The fallback path posts as the bot rather than through a webhook, so it
  // has no webhookId to recognise it by — only its id.
  const posted = M.makeRecentSet();
  posted.add('m1');
  const r = M.shouldMirror(msg({ id: 'm1' }), ROUTE, { postedByMirror: posted });
  assert.strictEqual(r.ok, false);
});

check('the posted-id set does not grow without bound', () => {
  // A long-lived process relaying a busy channel. Unbounded, this leaks on
  // exactly the servers that use the feature most.
  const s = M.makeRecentSet(10);
  for (let i = 0; i < 500; i++) s.add(`m${i}`);
  assert.ok(s.size <= 10, `set grew to ${s.size}`);
  assert.ok(s.has('m499'), 'the newest id must still be there — it is the one that matters');
});

check('a route that closes a loop is refused, and the loop is named', () => {
  const routes = [
    { src_channel_id: 'A', dst_channel_id: 'B' },
    { src_channel_id: 'B', dst_channel_id: 'C' },
  ];
  const cycle = M.findCycle(routes, 'A', 'C');   // adding A→C? no: C leads nowhere
  assert.strictEqual(cycle, null);
  const bad = M.findCycle(routes, 'C', 'A');     // C→A closes A→B→C→A
  assert.ok(bad, 'a three-hop loop was not detected');
  assert.deepStrictEqual(bad, ['C', 'A', 'B', 'C']);
});

check('a channel mirroring to itself is refused', () => {
  assert.deepStrictEqual(M.findCycle([], 'A', 'A'), ['A', 'A']);
});

check('a disabled route cannot be part of a detected loop', () => {
  const routes = [{ src_channel_id: 'A', dst_channel_id: 'B', enabled: false }];
  assert.strictEqual(M.findCycle(routes, 'B', 'A'), null);
});

// ─── What gets carried ───────────────────────────────────────────────────────
check('an @everyone in a mirrored post does not ping the other server', () => {
  // The single most likely reason a mirror gets switched off: a restock post
  // that pings one server by design pinging a second one that never asked.
  const p = M.buildMirrorPayload(msg({ content: '@everyone restock is live' }));
  assert.deepStrictEqual(p.allowedMentions, { parse: [] });
  assert.ok(/@everyone/.test(p.content), 'the TEXT should be intact — only the ping is suppressed');
});

check('pings can be turned on for a route that wants them', () => {
  const p = M.buildMirrorPayload(msg(), { allowPings: true });
  assert.ok(p.allowedMentions.parse.includes('everyone'));
});

check('attachments are re-uploaded, not linked', () => {
  // An attachment URL is signed and expires, and 404s for anyone who cannot
  // see the source channel — which is everyone, in the server being mirrored
  // INTO.
  const attachments = new Map([['a1', { url: 'https://cdn/x.png?ex=abc', name: 'x.png' }]]);
  const p = M.buildMirrorPayload(msg({ attachments }));
  assert.strictEqual(p.files.length, 1);
  assert.strictEqual(p.files[0].attachment, 'https://cdn/x.png?ex=abc');
  assert.strictEqual(p.files[0].name, 'x.png');
});

check('a spoilered attachment stays spoilered', () => {
  const attachments = new Map([['a1', { url: 'https://cdn/s.png', name: 'SPOILER_s.png' }]]);
  const p = M.buildMirrorPayload(msg({ attachments }));
  assert.strictEqual(p.files[0].name, 'SPOILER_s.png', 'the SPOILER_ prefix IS the spoiler');
});

check('embeds are capped at what Discord accepts', () => {
  const p = M.buildMirrorPayload(msg({ embeds: Array.from({ length: 14 }, (_, i) => ({ title: `e${i}` })) }));
  assert.strictEqual(p.embeds.length, 10, '11 embeds is a 400, and a 400 is a dropped post');
});

// ─── Components ──────────────────────────────────────────────────────────────
check('a custom_id button is dropped, a link button is kept', () => {
  // A button is an instruction about the guild it was posted in. In another
  // server it is a control doing something its clicker cannot see.
  const rows = [{ type: 1, components: [
    { type: 2, style: 5, url: 'https://uhservices.xyz', label: 'Shop' },
    { type: 2, style: 1, custom_id: 'claim_order::99', label: 'Claim' },
  ]}];
  const out = M.sanitizeComponents(rows);
  assert.strictEqual(out[0].components.length, 1);
  assert.strictEqual(out[0].components[0].url, 'https://uhservices.xyz');
});

check('the language dropdown survives the mirror', () => {
  // It translates the embeds of whatever message it is attached to and knows
  // nothing about the guild — the one component that works anywhere.
  const rows = [{ type: 1, components: [{ type: 3, custom_id: 'xlate_lang' }] }];
  assert.strictEqual(M.sanitizeComponents(rows)[0].components[0].custom_id, 'xlate_lang');
});

check('a row emptied by sanitising is removed, not sent empty', () => {
  // An action row with no components in it is a 400 — which would fail the
  // whole mirrored post over a button that was being dropped anyway.
  const rows = [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'nope' }] }];
  assert.deepStrictEqual(M.sanitizeComponents(rows), []);
});

check('an unrecognised component container is dropped rather than half-read', () => {
  assert.deepStrictEqual(M.sanitizeComponents([{ type: 17, components: [{ type: 10 }] }]), []);
});

// ─── What is not a post ──────────────────────────────────────────────────────
check('join notices and pin notices are not mirrored', () => {
  assert.strictEqual(M.shouldMirror(msg({ type: 7 }), ROUTE, {}).ok, false);
  assert.strictEqual(M.shouldMirror(msg({ type: 6 }), ROUTE, {}).ok, false);
  assert.strictEqual(M.shouldMirror(msg({ type: 19 }), ROUTE, {}).ok, true, 'a reply is a real post');
});

check('a human message is skipped on a bot-only route and carried on an open one', () => {
  const human = msg({ author: { id: 'U1', bot: false } });
  assert.strictEqual(M.shouldMirror(human, { botOnly: true }, {}).ok, false);
  assert.strictEqual(M.shouldMirror(human, { botOnly: false }, {}).ok, true);
});

check('an empty message is not mirrored, but one with only an embed is', () => {
  assert.strictEqual(M.shouldMirror(msg({ content: '   ' }), ROUTE, {}).ok, false);
  assert.strictEqual(M.shouldMirror(msg({ content: '', embeds: [{ title: 'x' }] }), ROUTE, {}).ok, true);
  assert.strictEqual(
    M.shouldMirror(msg({ content: '', attachments: new Map([['a', { url: 'u' }]]) }), ROUTE, {}).ok, true);
});

// ─── The webhook identity ────────────────────────────────────────────────────
check('a server name containing "discord" does not fail the send', () => {
  // Discord rejects the request outright rather than the name — so a server
  // called "Discord Deals" would mirror nothing at all, with a 400 as the
  // only clue.
  assert.ok(!/discord/i.test(M.webhookName('Discord Deals')));
  assert.strictEqual(M.webhookName('UH SERVICES'), 'UH SERVICES');
  assert.strictEqual(M.webhookName(''), 'Mirror');
  assert.ok(M.webhookName('x'.repeat(200)).length <= 80);
});

check('the fallback payload drops the fields channel.send would reject', () => {
  const p = M.buildMirrorPayload(msg(), { username: 'UH SERVICES', avatarURL: 'https://i/x.png' });
  assert.strictEqual(p.username, 'UH SERVICES');
  const c = M.toChannelPayload(p);
  assert.ok(!('username' in c) && !('avatarURL' in c));
  assert.strictEqual(c.content, 'hello');
});

// ─── Who "the bot" is ────────────────────────────────────────────────────────
//
// The finding these pin: `message.author.bot` is TRUE FOR EVERY WEBHOOK
// MESSAGE. A route flagged bot-only was therefore carrying anything posted by
// anyone holding Manage Webhooks in the source channel — past a flag that reads
// like it says otherwise. It was never a boundary.
check('a stranger\'s webhook does not ride a bot-only route', () => {
  const ctx = { selfId: 'BOT', mirrorWebhookIds: new Set() };
  const rogue = msg({ id: 'm9', webhookId: 'THEIRS', author: { id: 'THEIRS', bot: true } });
  const r = M.shouldMirror(rogue, { botOnly: true }, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/webhook/.test(r.why), `the reason has to name the webhook, got: ${r.why}`);
});

check('another bot does not ride a bot-only route either, unless invited', () => {
  const ctx = { selfId: 'BOT', mirrorWebhookIds: new Set() };
  const other = msg({ author: { id: 'OTHERBOT', bot: true } });
  assert.strictEqual(M.shouldMirror(other, { botOnly: true }, ctx).ok, false);
  assert.strictEqual(M.shouldMirror(other, { botOnly: true, includeOtherBots: true }, ctx).ok, true);
});

check('include_other_bots is not a way in for humans', () => {
  // Widening a route to other bots must not quietly widen it to people — that
  // is what include_humans (botOnly: false) is for, and it is a separate ask.
  const ctx = { selfId: 'BOT' };
  const human = msg({ author: { id: 'U1', bot: false } });
  assert.strictEqual(M.shouldMirror(human, { botOnly: true, includeOtherBots: true }, ctx).ok, false);
});

check('our own posts still go through', () => {
  const ctx = { selfId: 'BOT' };
  assert.strictEqual(M.shouldMirror(msg(), { botOnly: true }, ctx).ok, true);
});

// ─── Flood control ───────────────────────────────────────────────────────────
//
// The case: the source server is taken over. The attacker does not break
// anything — they inherit a live, authorised route. One in, one out, forever.
// And because discord.js QUEUES rather than drops, the flood becomes a backlog
// that delays every command in every other server.
check('the window only counts the last minute', () => {
  const w = M.makeRateWindow(60000);
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) w.hit('k', t0 + i);
  assert.strictEqual(w.count('k', t0 + 10), 5);
  // Hits sit at t0..t0+4. At t0+60002 the cutoff is t0+2, so the three at or
  // before it have aged out and the two after it have not.
  assert.strictEqual(w.count('k', t0 + 60002), 2, 'the window slides, it does not reset');
  assert.strictEqual(w.count('k', t0 + 60010), 0, 'everything older than the window is gone');
  assert.strictEqual(w.size, 0, 'and the key itself is dropped, or this leaks per route');
});

check('a route trips its own limit', () => {
  const w = M.makeRateWindow();
  const route = { id: 1, dst_guild_id: 'G', rate_per_min: 5 };
  let tripped = null;
  for (let i = 0; i < 20 && !tripped; i++) {
    const r = M.checkRate(w, route, 1_000_000 + i);
    if (!r.ok) tripped = r;
  }
  assert.ok(tripped, 'never tripped');
  assert.strictEqual(tripped.scope, 'route');
  assert.strictEqual(tripped.count, 6, 'trips on the message that exceeds it, not the one that reaches it');
  // The reason is read hours later by whoever finds a dead route, so it has to
  // name the number and the window — not say "rate limited".
  assert.ok(/6 messages in 60s/.test(tripped.reason), tripped.reason);
});

check('several routes into one server share a second budget', () => {
  // Otherwise five routes into the same server each spend the full per-route
  // allowance and the receiving server is buried anyway.
  const w = M.makeRateWindow();
  const routes = [1, 2, 3, 4, 5].map(id => ({ id, dst_guild_id: 'G', rate_per_min: 100 }));
  let tripped = null;
  for (let i = 0; i < 200 && !tripped; i++) {
    const r = M.checkRate(w, routes[i % 5], 1_000_000 + i);
    if (!r.ok) tripped = r;
  }
  assert.ok(tripped, 'never tripped — the per-guild budget is not being charged');
  assert.strictEqual(tripped.scope, 'guild');
  assert.strictEqual(tripped.count, M.DEFAULT_GUILD_PER_MIN + 1);
});

check('routes into different servers do not spend each other\'s budget', () => {
  const w = M.makeRateWindow();
  const a = { id: 1, dst_guild_id: 'GA' }, b = { id: 2, dst_guild_id: 'GB' };
  for (let i = 0; i < 15; i++) assert.strictEqual(M.checkRate(w, a, 1_000_000 + i).ok, true);
  assert.strictEqual(M.checkRate(w, b, 1_000_000).ok, true);
});

check('resuming a route forgets the flood that paused it', () => {
  // Without the clear, the first message after /mirror resume is measured
  // against the burst that tripped it and the route pauses itself again.
  const w = M.makeRateWindow();
  const route = { id: 7, dst_guild_id: 'G', rate_per_min: 3 };
  for (let i = 0; i < 4; i++) M.checkRate(w, route, 1_000_000 + i);
  w.clear('r:7'); w.clear('g:G');
  assert.strictEqual(M.checkRate(w, route, 1_000_010).ok, true);
});

check('a paused route says so in the listing, with the reason', () => {
  const line = M.describeRoute({ id: 3, src_channel_id: 'A', dst_channel_id: 'B',
    enabled: false, paused_reason: '300 messages in 60s' });
  assert.ok(/PAUSED: 300 messages in 60s/.test(line), line);
  const open = M.describeRoute({ id: 4, src_channel_id: 'A', dst_channel_id: 'B',
    include_other_bots: true, rate_per_min: 60 });
  assert.ok(/all bots/.test(open) && /60\/min/.test(open), open);
});

console.log(`\n${passed} checks passed`);
