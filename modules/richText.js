// ─── Making a pasted body look like a post instead of like markdown ──────────
//
// Round 38: "Why my bot can[not] post link in a post like that?", with two
// screenshots — one of somebody else's post carrying a proper Cloudflare
// preview card, and one of ours rendering
//
//     • # ⚠️ INJECTION ERROR FIX
//     🔗 [https://one.one.one.one/](https://one.one.one.one/)
//
// as literal text. Three separate things went wrong there and they are worth
// naming, because each one is a rule about embeds rather than a typo:
//
//  1. **A heading does not render after a bullet.** `# ` is only a heading at
//     the start of a line, and the notes field glues `• ` in front of whatever
//     it is given — so the admin's heading came out as the characters `# `.
//     Bold renders in every position, so headings become bold.
//
//  2. **`[url](url)` is a masked link pointing at itself.** It is redundant
//     everywhere and it did not render here; a BARE url auto-links in an embed
//     with no markdown at all, and cannot be mis-parsed. So it is unwrapped.
//     A genuine masked link — different text, real target — is left alone.
//
//  3. **An embed NEVER gets a preview card.** Discord only unfurls a link that
//     appears in the plain message `content`. That is the entire difference
//     between the two screenshots: the post they liked was a normal message
//     with a URL in it. So the first link in the body is echoed into `content`,
//     where Discord will fetch the site and draw the card.
'use strict';

// Deliberately not greedy about closing punctuation: a URL at the end of a
// sentence is far commoner than a URL with a bracket in it.
const URL_RE = /https?:\/\/[^\s<>\[\]()"'`]+/gi;

// Compares two link forms the way a reader would: protocol, `www.`, a trailing
// slash and case are not differences anyone means.
function sameTarget(a, b) {
  const strip = (s) => String(s).trim().toLowerCase()
    .replace(/^<|>$/g, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  return strip(a) === strip(b);
}

/**
 * Normalise markdown a person typed into a modal so it renders the same in an
 * embed description, an embed field value and a plain message.
 */
function normalizeMarkdown(text) {
  if (!text) return '';
  const out = String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    // `# Heading` → `**Heading**`. Also eats the closing hashes of the
    // `## Heading ##` form, which nobody types on purpose but pastes happen.
    line = line.replace(/^(\s{0,3})#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/, '$1**$2**');

    // `<https://x>` is the "do not unfurl this" form. Inside an embed there is
    // nothing to suppress, so the brackets are just two stray characters.
    line = line.replace(/<((?:https?:\/\/)[^\s<>]+)>/g, '$1');

    // A masked link pointing at its own address is noise at best; unwrap it to
    // the bare URL, which auto-links with no markdown involved.
    line = line.replace(/\[([^\]\n]{1,300})\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g,
      (whole, label, target) => (sameTarget(label, target) ? target : whole));

    return line;
  }).join('\n');

  // Four blank lines in a paste is an accident, and an embed renders every one
  // of them.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The links to echo into plain `content` so Discord draws a preview card.
 * Deduplicated, capped, and never more than Discord will unfurl anyway.
 */
function previewLinks(text, { limit = 2, skip = [] } = {}) {
  if (!text) return [];
  const seen = [];
  for (const raw of String(text).match(URL_RE) || []) {
    // Trailing sentence punctuation is not part of the address.
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (url.length > 400) continue;                       // not a link anyone pasted deliberately
    if (skip.some(s => s && sameTarget(s, url))) continue;
    if (seen.some(s => sameTarget(s, url))) continue;
    seen.push(url);
    if (seen.length >= limit) break;
  }
  return seen;
}

/**
 * Build the plain-message line that carries the preview, given whatever the
 * caller already wanted in `content` (a ping, usually).
 *
 * Returns undefined rather than an empty string when there is nothing to say:
 * Discord rejects a message whose content is present but empty.
 */
function withPreview(content, text, opts) {
  const links = previewLinks(text, opts);
  const head = (content || '').trim();
  if (!links.length) return head || undefined;
  return [head, ...links].filter(Boolean).join('\n');
}

/**
 * The notes box, which is documented as pipe-separated but is pasted into far
 * more often than it is typed into.
 *
 * A pipe means the admin wrote a list and wants bullets. No pipe used to mean
 * "wrap the entire paste in ONE bullet", which is how a heading ended up behind
 * a `• ` — so now it means "they wrote prose, leave it as prose".
 */
function formatNotes(raw) {
  const text = normalizeMarkdown(raw);
  if (!text) return null;
  if (!text.includes('|')) return text;
  return text.split('|').map(n => n.trim()).filter(Boolean).map(n => `• ${n}`).join('\n');
}

// An embed field value is capped at 1024 characters and the whole message is
// REJECTED past it. Long prose belongs in the description anyway (4096), so
// this reports where the caller should put it rather than truncating.
const FIELD_MAX = 1024;
const DESC_MAX = 4096;
function fitsField(text) { return !!text && text.length <= FIELD_MAX; }
function clampDescription(text) {
  if (!text) return text;
  return text.length <= DESC_MAX ? text : text.slice(0, DESC_MAX - 1) + '…';
}

module.exports = {
  normalizeMarkdown, previewLinks, withPreview, formatNotes,
  sameTarget, fitsField, clampDescription, FIELD_MAX, DESC_MAX,
};
