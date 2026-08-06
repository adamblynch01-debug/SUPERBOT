// ─── POST TRANSLATION ─────────────────────────────────────────────────────────
// Round 29 item 1: "Add a way to translate every post like in this other bot."
// The reference is a language dropdown pinned under a post; picking a language
// shows that post in it.
//
// EVERY post is the hard part. The bot has dozens of them, half rendered from
// operator-authored text in guild_content that changes whenever staff edits it,
// so a table of hand-written translations is out of date the first time someone
// runs /set-tos. So this does not translate POSTS at all — it translates the
// EMBEDS OF THE MESSAGE THE DROPDOWN IS ATTACHED TO, read back off the
// interaction. Any message the bot sends with languageRow() appended becomes
// translatable, and none of them need to know this module exists.
//
// Three things this gets right that a naive call to a translate API does not:
//
//   1. It masks anything that is a KEY rather than a sentence. `/getrole`,
//      product names, invoice numbers, URLs, <@mentions> and code fences are
//      looked up by other systems or typed back by the customer; a translator
//      turning /getrole into /obtenerrol produces a post that is confidently
//      wrong. If any mask comes back missing, the translation is DISCARDED and
//      the English is shown — a mangled Terms of Service is worse than an
//      untranslated one.
//   2. It caches by content hash, forever, in Postgres. The same document is
//      translated once per language no matter how many people press the button,
//      which is what makes this affordable and what makes the second click
//      instant. Editing the document changes the hash, so a stale translation
//      cannot survive an edit.
//   3. It remembers the customer's choice, and seeds it from interaction.locale
//      — the language their Discord client is already in — so most people never
//      have to touch the dropdown at all.
//
// PROVIDER: DeepL if DEEPL_API_KEY is set, else Google Cloud Translation if
// GOOGLE_TRANSLATE_API_KEY is set, else Google's keyless endpoint. The last one
// needs no account and is what runs today; it is also undocumented and rate
// limited, which the cache mostly hides. Setting a key upgrades quality without
// a code change.
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const db = require('../db');

// Ten, not five. The reference bot offers five; the extra ones cost nothing
// until somebody picks them, because nothing is translated until it is asked
// for. Order is by how much of this server actually speaks them.
const LANGS = [
  { code: 'en', flag: '🇬🇧', native: 'English',    english: 'English' },
  { code: 'es', flag: '🇪🇸', native: 'Español',    english: 'Spanish' },
  { code: 'pt', flag: '🇵🇹', native: 'Português',  english: 'Portuguese' },
  { code: 'fr', flag: '🇫🇷', native: 'Français',   english: 'French' },
  { code: 'de', flag: '🇩🇪', native: 'Deutsch',    english: 'German' },
  { code: 'it', flag: '🇮🇹', native: 'Italiano',   english: 'Italian' },
  { code: 'nl', flag: '🇳🇱', native: 'Nederlands', english: 'Dutch' },
  { code: 'pl', flag: '🇵🇱', native: 'Polski',     english: 'Polish' },
  { code: 'tr', flag: '🇹🇷', native: 'Türkçe',     english: 'Turkish' },
  { code: 'ru', flag: '🇷🇺', native: 'Русский',    english: 'Russian' },
];
const LANG_BY_CODE = new Map(LANGS.map(l => [l.code, l]));
const DEFAULT_LANG = 'en';

// Discord sends locales like 'pt-BR', 'es-419', 'en-GB'. The region is not
// something this offers a separate translation for, so it is dropped rather
// than treated as an unknown language and thrown away.
function normalizeLang(raw) {
  const code = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
  return LANG_BY_CODE.has(code) ? code : null;
}

// ─── masking ─────────────────────────────────────────────────────────────────
// Everything here is a thing the reader is expected to TYPE, CLICK or LOOK UP.
// Translating any of it breaks the instruction it appears in.
const PROTECT = [
  /```[\s\S]*?```/g,                     // fenced blocks
  /`[^`\n]+`/g,                          // inline code — where /commands usually live
  /<a?:\w+:\d+>/g,                       // custom emoji
  /<@!?\d+>|<#\d+>|<@&\d+>/g,            // user / channel / role mentions
  /<t:\d+(?::[tTdDfFR])?>/g,             // timestamps — Discord localises these itself
  /<\/[\w-]+(?: [\w-]+)*:\d+>/g,         // slash-command mentions
  /https?:\/\/\S+/g,                     // links
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,        // addresses
  /(?<![\w/])\/[a-z][a-z0-9-]{1,31}\b/g, // a bare /command written without backticks
  /\{\w+\}/g,                            // {placeholder}
  /\$\d[\d,]*(?:\.\d{2})?/g,             // prices
  /#[A-Z0-9]{4,}\b/g,                    // invoice / order numbers
];

// ⟦0⟧ rather than [0] or {0}: square and curly brackets are ordinary
// punctuation in prose, and a translator will happily move, duplicate or
// translate what is inside them. These two are not, so they survive intact —
// and when they do not, unmask() says so instead of guessing.
const MASK_OPEN = '\u27E6';
const MASK_CLOSE = '\u27E7';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The header above claims product names are protected. They were not: no
// pattern in PROTECT can tell "H8ED Private External — Month" from a sentence,
// and none ever will, because a product name is only a name by DECREE of
// whoever sells it. A Spanish-speaking buyer's delivery DM came back offering
// them "H8ED Privado Externo — Día", which is not a thing this shop sells and
// not a thing they can quote back to staff.
//
// So the caller names them. Whoever builds the embed already holds
// product_name and tier_label as separate values and knows exactly which
// characters are a catalogue key; this module never can. Literals are masked
// BEFORE the generic rules, so a name containing a price or a URL is taken
// whole rather than nibbled apart, and longest-first so a tier label that also
// appears inside a product name cannot shadow it.
//
// Two characters or fewer are ignored: a product called "GB" would otherwise
// mask that substring out of the ordinary words around it.
function literalRules(extra) {
  return [...new Set((extra || []).map(s => String(s == null ? '' : s).trim()).filter(s => s.length > 2))]
    .sort((a, b) => b.length - a.length)
    .map(s => new RegExp(escapeRe(s), 'gi'));
}

function mask(text, extra) {
  const kept = [];
  let out = String(text);
  for (const re of [...literalRules(extra), ...PROTECT]) {
    out = out.replace(re, (m) => {
      kept.push(m);
      return `${MASK_OPEN}${kept.length - 1}${MASK_CLOSE}`;
    });
  }
  return { masked: out, kept };
}

// Tolerant of the spacing a translator adds around the brackets, and of the
// order changing — a different language puts the object in a different place,
// which is the whole point of translating. Not tolerant of a mask going
// MISSING: that means a piece of the text a system reads was rewritten, and the
// caller is told to discard the whole translation.
function unmask(text, kept) {
  const seen = new Set();
  const out = String(text).replace(
    new RegExp(`${MASK_OPEN}\\s*(\\d+)\\s*${MASK_CLOSE}`, 'g'),
    (_, i) => { seen.add(Number(i)); return kept[Number(i)] !== undefined ? kept[Number(i)] : ''; }
  );
  const intact = kept.every((_, i) => seen.has(i));
  return { text: out, intact };
}

// ─── providers ───────────────────────────────────────────────────────────────
const DEEPL_KEY = () => (process.env.DEEPL_API_KEY || '').trim();
const GT_KEY = () => (process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();

async function viaDeepL(text, target) {
  const key = DEEPL_KEY();
  // DeepL splits free and paid across two hostnames and answers the wrong one
  // with 403. The ':fx' suffix on a free key is how you tell them apart.
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const res = await axios.post(`${host}/v2/translate`,
    new URLSearchParams({ text, target_lang: target.toUpperCase(), source_lang: 'EN', preserve_formatting: '1' }).toString(),
    { headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  const t = res.data && res.data.translations && res.data.translations[0];
  if (!t) throw new Error('DeepL returned no translation');
  return t.text;
}

async function viaGoogleCloud(text, target) {
  const res = await axios.post(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(GT_KEY())}`,
    { q: text, source: 'en', target, format: 'text' }, { timeout: 15000 });
  const t = res.data && res.data.data && res.data.data.translations && res.data.data.translations[0];
  if (!t) throw new Error('Google Translate returned no translation');
  return t.translatedText;
}

// The keyless endpoint. Its response is a nest of arrays, and the first element
// is the sentence list — joined WITHOUT a separator because the split points
// are mid-paragraph and it already carries its own spaces and newlines.
async function viaGoogleFree(text, target) {
  const url = 'https://translate.googleapis.com/translate_a/single?'
    + new URLSearchParams({ client: 'gtx', sl: 'en', tl: target, dt: 't', q: text }).toString();
  const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const parts = res.data && res.data[0];
  if (!Array.isArray(parts)) throw new Error('unexpected response from the translate endpoint');
  return parts.map(p => (p && p[0]) || '').join('');
}

function provider() {
  if (DEEPL_KEY()) return { name: 'deepl', call: viaDeepL };
  if (GT_KEY()) return { name: 'google-cloud', call: viaGoogleCloud };
  return { name: 'google-free', call: viaGoogleFree };
}

// ─── cache ───────────────────────────────────────────────────────────────────
// Keyed on the hash of the SOURCE, so an edit to a document invalidates it by
// simply not matching any more — there is no stale entry to remember to purge.
const memCache = new Map(); // `${hash}:${lang}` → translated
const MEM_MAX = 500;

const hashOf = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

async function cacheGet(hash, lang) {
  const k = `${hash}:${lang}`;
  if (memCache.has(k)) return memCache.get(k);
  try {
    const { rows } = await db.query(
      'SELECT translated FROM translations WHERE source_hash = $1 AND target_lang = $2', [hash, lang]);
    if (rows[0]) { memCache.set(k, rows[0].translated); return rows[0].translated; }
  } catch (e) {
    // A missing table must not take the post down with it — the dropdown is an
    // addition to a message that was fine without it.
    console.warn('[translate] cache read failed:', e.message);
  }
  return null;
}

async function cachePut(hash, lang, source, translated, providerName) {
  const k = `${hash}:${lang}`;
  if (memCache.size >= MEM_MAX) memCache.delete(memCache.keys().next().value);
  memCache.set(k, translated);
  try {
    await db.query(
      `INSERT INTO translations (source_hash, target_lang, source_text, translated, provider)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_hash, target_lang) DO UPDATE SET translated = $4, provider = $5`,
      [hash, lang, source, translated, providerName]);
  } catch (e) {
    console.warn('[translate] cache write failed:', e.message);
  }
}

// ─── the translation itself ──────────────────────────────────────────────────
// Chunked on paragraph boundaries: the keyless endpoint carries the text in a
// query string, and a whole Terms of Service does not fit in a URL.
function chunk(text, limit = 1500) {
  const out = [];
  let cur = '';
  for (const para of String(text).split(/\n\n+/)) {
    if (cur && cur.length + para.length + 2 > limit) { out.push(cur); cur = ''; }
    if (para.length > limit) {
      if (cur) { out.push(cur); cur = ''; }
      for (const piece of para.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) || []) out.push(piece);
      continue;
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

// Returns the translated string, or the ORIGINAL if anything at all went wrong.
// Never throws and never returns a partial translation: half a document in
// Spanish reads as a bug in the post, not as a failure of this module.
async function translateText(text, lang, protect) {
  const src = String(text == null ? '' : text);
  if (!src.trim() || lang === DEFAULT_LANG || !LANG_BY_CODE.has(lang)) return src;

  // The protected literals are part of the cache key, not just of the request.
  // The same sentence masked differently is a different translation, and the
  // one already in Postgres from before this existed is the unmasked one — so
  // reusing it by source alone would serve exactly the output being fixed.
  // With no literals the key is unchanged, so every entry cached so far stays
  // valid for the calls that produced it.
  const literals = [...new Set((protect || []).map(s => String(s == null ? '' : s).trim()).filter(s => s.length > 2))].sort();
  const hash = hashOf(literals.length ? `${src} ${literals.join(' ')}` : src);
  const hit = await cacheGet(hash, lang);
  if (hit !== null) return hit;

  const p = provider();
  try {
    const pieces = [];
    for (const part of chunk(src)) {
      const { masked, kept } = mask(part, protect);
      // A chunk with no words left after masking is a divider or a bare URL;
      // sending it wastes a call and sometimes comes back mangled.
      if (!masked.replace(new RegExp(`${MASK_OPEN}\\d+${MASK_CLOSE}`, 'g'), '').trim()) {
        pieces.push(part);
        continue;
      }
      const raw = await p.call(masked, lang);
      const { text: restored, intact } = unmask(raw, kept);
      if (!intact) {
        console.warn(`[translate] ${lang}: a protected token did not survive — keeping the original`);
        return src;
      }
      pieces.push(restored);
    }
    const joined = pieces.join('\n\n');
    await cachePut(hash, lang, src, joined, p.name);
    return joined;
  } catch (e) {
    console.warn(`[translate] ${lang} failed via ${p.name}:`, e.message);
    return src;
  }
}

// ─── embeds ──────────────────────────────────────────────────────────────────
// Read straight off interaction.message, so this works on a post whose builder
// this module has never seen. The footer is left alone on purpose: it is the
// bot name, a page number and a URL, none of which are sentences.
async function translateEmbed(embedJson, lang, protect) {
  const d = JSON.parse(JSON.stringify(embedJson || {}));
  if (d.title) d.title = await translateText(d.title, lang, protect);
  if (d.description) d.description = await translateText(d.description, lang, protect);
  if (Array.isArray(d.fields)) {
    for (const f of d.fields) {
      if (f.name) f.name = await translateText(f.name, lang, protect);
      if (f.value) f.value = await translateText(f.value, lang, protect);
    }
  }
  if (d.author && d.author.name) d.author.name = await translateText(d.author.name, lang, protect);
  // Embed limits are enforced by Discord on the way out and a translation is
  // routinely longer than its English source — German and Russian especially.
  // Trimming here is what stops a 4096-character document coming back as a
  // rejected message the customer reads as "translation is broken".
  if (d.title) d.title = d.title.slice(0, 256);
  if (d.description) d.description = d.description.slice(0, 4096);
  for (const f of d.fields || []) {
    if (f.name) f.name = f.name.slice(0, 256);
    if (f.value) f.value = f.value.slice(0, 1024);
  }
  return EmbedBuilder.from(d);
}

// `protect` is optional and defaults to nothing, so the dropdown path — which
// reads an arbitrary post off interaction.message and cannot know what is in it
// — behaves exactly as before. Only the callers that HOLD the catalogue values
// pass them.
async function translateEmbeds(embeds, lang, protect) {
  const out = [];
  for (const e of embeds || []) out.push(await translateEmbed(e.toJSON ? e.toJSON() : (e.data || e), lang, protect));
  return out;
}

// ─── the dropdown ────────────────────────────────────────────────────────────
// One row, appended to any post that should be translatable. `current` only
// changes the placeholder — the row is on a SHARED message read by everyone, so
// it cannot show one reader's choice as if it were the post's language.
//
// `scope` is for DMs. A DM has no guildId, so a choice made there would be
// remembered under 'dm' while the order-delivery path looks the buyer up under
// the store's guild id — the choice would appear to save and change nothing.
// The delivery DM therefore carries the guild it came from in the customId.
function languageRow(current, scope) {
  const cur = LANG_BY_CODE.get(normalizeLang(current) || DEFAULT_LANG) || LANGS[0];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(scope ? `xlate_lang::${scope}` : 'xlate_lang')
      .setPlaceholder(`${cur.flag} ${cur.native}`)
      .addOptions(LANGS.map(l => ({
        label: l.native,
        description: l.english,
        value: l.code,
        emoji: l.flag,
      })))
  );
}

// ─── remembered choice ───────────────────────────────────────────────────────
// The table is keyed (guild_id, user_id), which was over-keyed from the start:
// what language someone reads is a property of the PERSON, not of the server
// they happened to be standing in when they picked. Being asked twice is a
// nuisance; the real damage was that a choice made in one place silently did
// not apply in another — a buyer who picked Spanish under a server post got
// Spanish order DMs and had no way to undo it, because the DM carried no
// dropdown and /language in a DM writes under 'dm', which the delivery path
// never reads.
//
// So every save now writes a second, guild-independent row under GLOBAL_SCOPE,
// and every read falls back to it. The per-guild row still wins where it
// exists, so nothing anyone already chose changes meaning.
const GLOBAL_SCOPE = '*';

async function getUserLang(guildId, userId) {
  try {
    const { rows } = await db.query(
      `SELECT guild_id, lang FROM user_locales
        WHERE user_id = $2 AND guild_id IN ($1, $3)`,
      [String(guildId), userId, GLOBAL_SCOPE]);
    const exact = rows.find(r => r.guild_id === String(guildId));
    const global_ = rows.find(r => r.guild_id === GLOBAL_SCOPE);
    const hit = exact || global_;
    return hit ? normalizeLang(hit.lang) : null;
  } catch (e) { return null; }
}

async function setUserLang(guildId, userId, lang) {
  const code = normalizeLang(lang);
  if (!code) return false;
  // Both rows, or neither: a global row written without the scoped one would
  // be shadowed by whatever stale scoped row is already there, which is the
  // exact failure this is meant to end.
  const scopes = [...new Set([String(guildId), GLOBAL_SCOPE])];
  try {
    for (const scope of scopes) {
      await db.query(
        `INSERT INTO user_locales (guild_id, user_id, lang, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (guild_id, user_id) DO UPDATE SET lang = $3, updated_at = now()`,
        [scope, userId, code]);
    }
    return true;
  } catch (e) {
    console.warn('[translate] could not remember the language choice:', e.message);
    return false;
  }
}

// What language to show someone who has never chosen: the one their Discord
// client is already in. Most people never touch the dropdown because of this.
async function preferredLang(interaction) {
  const stored = await getUserLang(interaction.guildId || 'dm', interaction.user.id);
  return stored || normalizeLang(interaction.locale) || DEFAULT_LANG;
}

// ─── the handler ─────────────────────────────────────────────────────────────
// Ephemeral, always. The dropdown sits on a message hundreds of people can see;
// editing it in place would rewrite the post in one reader's language for
// everybody, and two readers picking at once would fight over it.
//
// `protectFor` is optional and is how a message declares which of its own words
// are catalogue keys rather than prose. This module cannot tell "H8ED Private
// External" from a sentence and never will — see literalRules() — so whoever
// knows the format of the message says so. Only the delivery DM uses it today.
async function handleLanguageSelect(interaction, { chunkEmbedsIntoMessages, protectFor }) {
  const lang = normalizeLang(interaction.values && interaction.values[0]) || DEFAULT_LANG;
  const meta = LANG_BY_CODE.get(lang);
  await interaction.deferReply({ flags: 64 });

  // A dropdown posted into a DM carries the guild it belongs to — see
  // languageRow(). Without it the choice lands under 'dm' and the order
  // deliveries, which look the buyer up by guild, keep speaking the old
  // language at someone who just asked them not to.
  const scope = (interaction.customId || '').split('::')[1] || interaction.guildId || 'dm';
  await setUserLang(scope, interaction.user.id, lang);

  const source = interaction.message ? interaction.message.embeds : [];
  if (!source.length) {
    // A post made of plain content with no embed. Rare, but it should say why
    // rather than return an empty reply that reads as a dead button.
    const body = interaction.message && interaction.message.content;
    if (!body) return interaction.editReply({ content: '❌ There is nothing on this post to translate.' });
    const t = await translateText(body, lang);
    return interaction.editReply({ content: `${meta.flag} ${t}`.slice(0, 2000) });
  }

  let protect;
  if (typeof protectFor === 'function') {
    try { protect = protectFor(interaction.message); }
    catch (e) { console.warn('[translate] protect list unavailable:', e.message); }
  }

  const translated = await translateEmbeds(source, lang, protect);
  const messages = chunkEmbedsIntoMessages(translated);

  // English IS the original — every message this bot sends is written in it, so
  // there is nothing to call out to a provider for. Saying so is what separates
  // this from a dropdown that appears to do nothing, which is how it read when
  // the delivery DM was going out pre-translated: picking English handed the
  // Spanish back, because translate.js takes its source to be English.
  // The disclaimer rides ON the translation, it does not follow it. Machine
  // translation is good enough to read and not good enough to hold anyone to,
  // and the Terms of Service is one of the documents this dropdown sits under —
  // so it still has to be said. But an ephemeral follow-up is not transient:
  // nothing expires it, so a second message saying "translated automatically"
  // stayed on screen after every single translation until the reader dismissed
  // it by hand. One message, one line at the top of it, nothing left behind.
  await interaction.editReply({
    content: lang === DEFAULT_LANG
      ? '🇬🇧 English — the original.'
      : `-# ${meta.flag} Translated to **${meta.native}** automatically — the English original is the official version.`,
    embeds: messages[0],
  });
  for (const m of messages.slice(1)) await interaction.followUp({ embeds: m, flags: 64 });
}

module.exports = {
  LANGS, LANG_BY_CODE, DEFAULT_LANG,
  normalizeLang, mask, unmask, chunk, hashOf,
  translateText, translateEmbed, translateEmbeds,
  languageRow, handleLanguageSelect,
  getUserLang, setUserLang, preferredLang,
};
