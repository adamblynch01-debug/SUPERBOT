// ─── Cross-server mirroring ──────────────────────────────────────────────────
//
// "Make the bot send everything it posts on the main server to another server."
//
// There are two honest answers to that, and this file is the second one.
//
//   1. DISCORD ALREADY DOES IT, for announcement channels: any server can
//      Follow one, and every published post lands in a channel of their
//      choosing. No bot, no uptime, no permissions to keep granted — Discord
//      delivers it. `/mirror follow` sets that up. It is strictly better than
//      anything below WHEN it applies, and it only applies to announcement
//      channels and only to posts that get Published.
//
//   2. Everything else — a normal text channel, a restock feed, a status post
//      that nobody remembers to hit Publish on — needs a relay, which is this.
//
// The relay hangs off messageCreate rather than the thirty-odd places this bot
// calls .send(). Wrapping call sites would mirror the ones that existed the
// day it was written and silently miss every one added afterwards; listening
// to the channel mirrors whatever ends up there, including posts made by hand.
//
// The failure mode that matters is a LOOP. A → B and B → A, or a relayed
// message being seen as a new message worth relaying, and the two servers
// generate messages at each other until the bot is rate-limited off the
// gateway. Three separate things prevent it, because one is not enough:
//
//   • A message delivered by one of our own mirror webhooks is never mirrored.
//   • A message id we posted ourselves is never mirrored, which covers the
//     fallback path where the webhook could not be created and the bot posted
//     as itself.
//   • A route that would close a cycle in the channel graph is refused at the
//     moment it is added, with the loop it would have made spelled out.
//
// The other thing worth stating plainly: a mirrored @everyone does NOT ping
// the other server by default. A restock post that pings one server is normal;
// the same post pinging a server that did not ask for it, every time, is how a
// mirror gets turned off within the hour.
'use strict';

// A post can carry buttons, and a button is an instruction to this bot about
// the guild it was posted in. Carried into another server, a custom_id that
// means "claim this in guild A" is now a button in guild B doing something its
// clicker cannot see. So interactive components are dropped by default and the
// exceptions are named here.
//
// The language dropdown is on the list because it is the rare component that
// knows nothing about where it is: it translates the embeds of the message it
// was clicked from, so it works identically in a server it was mirrored into.
const COMPONENT_ALLOW = new Set(['xlate_lang']);

const BUTTON = 2, ACTION_ROW = 1, LINK_STYLE = 5;

// Discord message types. 0 DEFAULT, 19 REPLY. Everything else is a join
// notice, a pin notice, a boost — server furniture that means nothing in a
// server it did not happen in.
const MIRRORABLE_TYPES = new Set([0, 19]);

const MAX_EMBEDS = 10;
const MAX_FILES = 10;

/**
 * Strips a message's components down to what is safe to carry into another
 * server: link buttons (a URL is a URL anywhere) and the explicitly allowed
 * custom_ids. Rows left empty are removed rather than sent — an action row
 * with no components in it is a 400 and would fail the whole mirror.
 */
function sanitizeComponents(rows, allow = COMPONENT_ALLOW) {
  const out = [];
  for (const row of (rows || [])) {
    // Only classic action rows. Anything else (a Components-V2 container, or
    // whatever Discord adds next) is dropped rather than half-understood.
    if (!row || row.type !== ACTION_ROW || !Array.isArray(row.components)) continue;
    const kept = row.components.filter(c => {
      if (!c) return false;
      if (c.type === BUTTON && c.style === LINK_STYLE) return true;
      return c.custom_id ? allow.has(c.custom_id) : false;
    });
    if (kept.length) out.push({ type: ACTION_ROW, components: kept });
  }
  return out.slice(0, 5);
}

/**
 * Whether this message should be relayed down this route, and if not, why.
 *
 * `ctx` carries the loop guards: `mirrorWebhookIds` is the set of webhooks
 * this bot mirrors THROUGH, and `postedByMirror` is the set of message ids it
 * has posted as mirrors. A message matching either is a mirror arriving, not
 * a post being made, and relaying it again is the loop.
 */
function shouldMirror(message, route, ctx = {}) {
  const webhookIds = ctx.mirrorWebhookIds || new Set();
  const posted = ctx.postedByMirror || new Set();

  if (message.webhookId && webhookIds.has(message.webhookId)) {
    return { ok: false, why: 'already a mirrored message' };
  }
  if (posted.has(message.id)) {
    return { ok: false, why: 'this bot posted it as a mirror' };
  }
  if (message.type != null && !MIRRORABLE_TYPES.has(message.type)) {
    return { ok: false, why: 'a system message, not a post' };
  }
  // The default, and what was actually asked for: everything the BOT posts.
  // A route can be widened to carry human messages too, which is a different
  // feature (a shared channel) wearing the same plumbing.
  if (route.botOnly !== false && !(message.author && message.author.bot)) {
    return { ok: false, why: 'not a bot post and this route is bot-only' };
  }
  const empty = !((message.content || '').trim())
    && !(message.embeds || []).length
    && !(message.attachments && message.attachments.size)
    && !(message.stickers && message.stickers.size);
  if (empty) return { ok: false, why: 'nothing to carry' };

  return { ok: true };
}

/**
 * A webhook username has to be 1–80 characters and Discord rejects anything
 * containing "discord" outright — a rejection that would fail the send, not
 * the name. Since the name here is a server's own name and servers are named
 * whatever their owners like, it is cleaned rather than trusted.
 */
function webhookName(name) {
  const cleaned = String(name || 'Mirror')
    .replace(/discord/gi, 'disc0rd')
    .slice(0, 80)
    .trim();
  return cleaned || 'Mirror';
}

/**
 * The payload to send into the destination channel.
 *
 * Attachments are re-sent by URL: Discord fetches them at send time, which
 * means the copy lives in the destination server rather than being a link
 * into the source one. A link would rot — attachment URLs are signed and
 * expire — and would 404 for anyone who cannot see the original channel.
 */
function buildMirrorPayload(message, opts = {}) {
  const files = [...((message.attachments && message.attachments.values && [...message.attachments.values()]) || [])]
    .slice(0, MAX_FILES)
    .map(a => ({ attachment: a.url, name: a.name || undefined, description: a.description || undefined }));

  const payload = {
    content: (message.content || '').slice(0, 2000) || undefined,
    embeds: (message.embeds || []).slice(0, MAX_EMBEDS).map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
    files,
    components: sanitizeComponents(
      (message.components || []).map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r))),
    // A mirrored post says nothing about who to ping in the server receiving
    // it. Left alone, an @everyone in the text pings a server that never
    // opted into being pinged — every restock, every status update.
    allowedMentions: opts.allowPings ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
  };
  if (opts.username) payload.username = webhookName(opts.username);
  if (opts.avatarURL) payload.avatarURL = opts.avatarURL;
  return payload;
}

/**
 * The same payload for a plain channel.send() — the fallback for when a
 * webhook cannot be made (no Manage Webhooks in the destination). It loses the
 * source server's name and icon, which is cosmetic; posting nothing is not.
 */
function toChannelPayload(payload) {
  const { username, avatarURL, ...rest } = payload;
  return rest;
}

/**
 * Would adding src → dst close a loop?
 *
 * Walks the existing routes forward from dst and returns the path back to src
 * if it finds one. Returning the PATH rather than true is deliberate: told
 * "that would create a loop", an operator has to go find it; told
 * "#announcements → #news → #announcements", they can already see it.
 */
function findCycle(routes, src, dst) {
  if (src === dst) return [src, dst];
  const next = new Map();
  for (const r of routes) {
    if (r.enabled === false) continue;
    if (!next.has(r.src_channel_id)) next.set(r.src_channel_id, []);
    next.get(r.src_channel_id).push(r.dst_channel_id);
  }
  const seen = new Set();
  const walk = (node, path) => {
    if (node === src) return [...path, src];
    if (seen.has(node)) return null;
    seen.add(node);
    for (const child of (next.get(node) || [])) {
      const hit = walk(child, [...path, node]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(dst, [src]);
}

/**
 * A bounded set of "message ids this bot posted as a mirror". Bounded because
 * this is a long-lived process relaying a busy channel: an unbounded Set here
 * is a slow memory leak that only shows up on the servers using the feature
 * most. Only the recent ids matter — a message that is not mirrored within
 * seconds of being posted never will be.
 */
function makeRecentSet(limit = 2000) {
  const set = new Set();
  return {
    add(id) {
      set.add(id);
      if (set.size > limit) {
        // Sets iterate in insertion order, so the first key is the oldest.
        for (const old of set) { set.delete(old); if (set.size <= limit) break; }
      }
    },
    has: (id) => set.has(id),
    get size() { return set.size; },
  };
}

/** One line per route for `/mirror list`. */
function describeRoute(r, nameOf) {
  const from = nameOf ? nameOf(r.src_channel_id) : r.src_channel_id;
  const to = nameOf ? nameOf(r.dst_channel_id) : r.dst_channel_id;
  const flags = [];
  if (r.bot_only === false) flags.push('all messages');
  if (r.allow_pings) flags.push('pings allowed');
  if (r.enabled === false) flags.push('disabled');
  return `\`#${r.id}\` ${from} → ${to}${flags.length ? ` — ${flags.join(', ')}` : ''}`;
}

module.exports = {
  COMPONENT_ALLOW, MIRRORABLE_TYPES, MAX_EMBEDS, MAX_FILES,
  sanitizeComponents, shouldMirror, buildMirrorPayload, toChannelPayload,
  webhookName, findCycle, makeRecentSet, describeRoute,
};
