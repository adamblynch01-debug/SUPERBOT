// ─── CONTENT RENDERING ────────────────────────────────────────────────────────
// The Terms of Service saved fine — 3051 characters of it, on 2026-08-02. What
// it did NOT do was display. The body was pasted in as ASCII art wrapped in a
// ```text fence, and a fenced block inside an embed is the one piece of Discord
// markup that does not wrap: every 61-character ╔═══╗ rule and every
// `━━━━━━━━━━ SECTION` header ran off the right edge, so on a phone the terms
// were a column of truncated lines and on desktop a horizontal scrollbar.
//
// So the fix is at the RENDER step, not the storage step. The body in the
// database is left exactly as the operator typed it — it is their document, and
// re-writing it in place would mean the next /set-tos silently disagreed with
// what they last pasted. Instead the art is translated to native Discord
// markdown on the way out, where the client is free to reflow it.
//
// Anything that is not recognisably boxed art passes through untouched.
//
// This lives in its own module because TWO systems render it: the bot's
// /post-tos and the web panel's editor preview. A second copy of these rules
// would diverge on the first change, and the panel would then promise a layout
// Discord does not produce — which is the whole bug this was written to fix.
'use strict';

const CONTENT_TYPES = {
  tos:              { label: 'Terms of Service', defaultTitle: '📜 Terms of Service' },
  rules:            { label: 'Rules',            defaultTitle: '📋 Server Rules' },
  guide:            { label: 'Guide',            defaultTitle: '📖 Guide' },
  'payment-method': { label: 'Payment Methods',  defaultTitle: '💳 Payment Methods' },
};
const CONTENT_KEYS = Object.keys(CONTENT_TYPES);

const BOX_CHARS = /[╔╗╚╝═║┃━┏┓┗┛│─┌┐└┘├┤┬┴┼▀▄█]/;

function renderContentBody(raw) {
  let body = String(raw || '');

  // 1. Unwrap a fence around the WHOLE document. A fence around part of it is
  //    intentional (a payment address, a command) and is left alone.
  const fenced = body.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) body = fenced[1];

  // Nothing box-drawn in here — it is already markdown, leave it be.
  if (!BOX_CHARS.test(body)) return body.trim();

  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();

    // A rule made only of box characters carries no words; the embed's own
    // title and field borders already do that job.
    if (t && !t.replace(new RegExp(BOX_CHARS.source, 'g'), '').trim()) { out.push(''); continue; }

    // `━━━━━━━━━ REFUND & PAYMENT POLICY` — a section header wearing a rule.
    const header = t.match(/^[━─═]{3,}\s*(.+?)\s*[━─═]*$/);
    if (header && header[1] && !BOX_CHARS.test(header[1])) {
      out.push('', `**${header[1].toUpperCase()}**`);
      continue;
    }

    // `┃  One purchase per account` / `┃ ✦ All payments are non-refundable`
    const bar = t.match(/^[┃│┏┗▌]\s*(?:[✦•▪▸►]\s*)?(.*)$/);
    if (bar) { if (bar[1].trim()) out.push(`• ${bar[1].trim()}`); continue; }

    // A boxed banner line with real words in it — the store name, the invite.
    if (BOX_CHARS.test(t)) {
      const words = t.replace(new RegExp(BOX_CHARS.source, 'g'), ' ').trim();
      if (words) out.push(`**${words}**`);
      continue;
    }

    // Already-bulleted lines keep their bullet but lose the leading indent,
    // which Discord would otherwise render as a nested list.
    const bullet = t.match(/^[•▪▸►·-]\s*(.*)$/);
    if (bullet) { out.push(`• ${bullet[1]}`); continue; }

    out.push(t);
  }

  // Blank runs are how the art breathed; two blank lines in markdown is just a
  // gap, three or more is a hole.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Discord: 4096 per description, 6000 across all embeds in one message, 10
// embeds per message. Split on paragraph boundaries so a page never breaks
// mid-sentence, and never mid-word.
function paginate(text, limit = 3900) {
  const pages = [];
  let cur = '';
  for (const para of String(text).split(/\n\n+/)) {
    const block = para.length > limit
      // A single paragraph longer than a page still has to go somewhere.
      ? para.match(new RegExp(`[\\s\\S]{1,${limit}}(?:\\n|$)|[\\s\\S]{1,${limit}}`, 'g')) || [para]
      : [para];
    for (const b of block) {
      if (cur && cur.length + b.length + 2 > limit) { pages.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : [''];
}

// Group embeds into messages under Discord's whole-message caps: 6000
// characters across every embed in one message (exceeding it rejects the WHOLE
// message, not the last embed) and 10 embeds per message. 5500 leaves headroom
// for the title, footer and field scaffolding the caller adds.
function chunkEmbedsIntoMessages(embeds, budget = 5500, maxPerMessage = 10) {
  const messages = [];
  let run = [], runLen = 0;
  for (const e of embeds) {
    const d = e.data || e;
    const len = String(d.description || '').length + String(d.title || '').length + 100;
    if (run.length && (runLen + len > budget || run.length >= maxPerMessage)) {
      messages.push(run); run = []; runLen = 0;
    }
    run.push(e); runLen += len;
  }
  if (run.length) messages.push(run);
  return messages;
}

module.exports = {
  CONTENT_TYPES, CONTENT_KEYS, BOX_CHARS,
  renderContentBody, paginate, chunkEmbedsIntoMessages,
};
