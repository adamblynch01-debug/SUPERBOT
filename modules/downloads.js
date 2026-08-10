// ─── Product Download Store ───────────────────────────────────────────────────
'use strict';
//
// This used to be a hardcoded list of 62 products plus a download_urls.json
// file written next to the code. Two things were wrong with that.
//
//   1. The website had its OWN link table (app_state 'ghostDownloads', written
//      by the admin panel's Downloads Manager). A link updated on the site
//      never reached /downloads here, and /setdownload never reached the site —
//      same product, two answers, no way to tell which was current.
//   2. download_urls.json lives on the container filesystem. Railway replaces
//      that on every deploy, so unless DATA_DIR points at a mounted volume,
//      every link ever set with /setdownload was silently lost at the next
//      push. Nobody would notice until a customer asked why the button was
//      dead.
//
// The backend's table is the single source of truth now. The product list is
// the live catalog (so a product added to the store appears in the Discord
// dropdown with no code change), and the JSON file is demoted to a local cache
// so a backend outage degrades the panel to "last known links" instead of
// breaking it.

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (DATA_DIR !== path.join(__dirname, '..') && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, 'download_urls.json');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const REFRESH_MS  = Number(process.env.DOWNLOADS_REFRESH_MS) || 5 * 60 * 1000;

// Kept as a floor, not as the list. These are the products the panel offered
// before the catalog became the source, and dropping them would blank the
// dropdown for anyone whose backend is unreachable at boot. Anything the
// catalog also names wins on casing and spelling.
//
// The three HWID entries said "WOOFER" — the same typo the store carried until
// the catalog was corrected — and abbreviated PERM/TEMP where the catalog now
// spells out PERMANENT/TEMPORARY. Renaming them changes their slug, which is
// normally the one thing not to do here (see slugify below): a link is stored
// against the name, so a changed id orphans it. It was safe in these cases only
// because the link table had no rows at all, so there was nothing to orphan.
// Check that before touching any other name in this list.
const LEGACY_PRODUCTS = [
  'ARC RAIDERS - ANCIENT', 'ARC RAIDERS - ARCANE', "ARC RAIDERS - HEAVEN'S BLINDSPOT",
  'ARC RAIDERS - FULL', 'APEX LEGENDS - ANCIENT', 'APEX LEGENDS - ARCANE',
  'APEX LEGENDS - FULL', 'APEX LEGENDS - EXODUS', 'ARK ASCENDED - ARCANE',
  'ACTIVE MATTER - ARCANE', 'ARENA BREAKOUT INFINITE - FULL', 'BATTLEFIELD - ANCIENT',
  'BATTLEFIELD - ARCANE', 'CALL OF DUTY - BLITZ EXTERNAL', 'CALL OF DUTY - ZENITH V3 (BO7)',
  'CALL OF DUTY - ZENITH BO6 INTERNAL', 'CALL OF DUTY - GHOST INTERNAL MW3',
  'CALL OF DUTY - GHOST INTERNAL MW19', 'CALL OF DUTY - ONTOP.EXE', 'CS2 / CSGO - PREDATOR',
  'DARK & DARKER - ARCANE', 'DAYZ - EXTERNAL', 'DAYZ - CHEVRON', 'DEAD BY DAYLIGHT - ARCANE',
  'DEADSIDE - ARCANE', 'DELTA FORCE - FULL', 'DELTA FORCE - EXODUS EXTERNAL',
  'DUNE AWAKENING - ARCANE', 'ESCAPE FROM TARKOV - ANCIENT CHAMS',
  'ESCAPE FROM TARKOV - COFFEE CHEAT', 'ESCAPE FROM TARKOV - COFFEE CHAMS',
  'FARLIGHT 84 - ARCANE', 'FORTNITE - ANCIENT EXTERNAL', 'FORTNITE - FULL',
  'FORTNITE - EXODUS EXTERNAL', 'FORTNITE - VENOM EXTERNAL', 'FORTNITE - ULTIMATE EXTERNAL',
  'FORTNITE - ARCANE', 'GRAY ZONE WARFARE - ARCANE', 'GTA - ARCANE V (GTAV)',
  'GTA - ARCANE V (FIVEM)', 'HELL LET LOOSE - ARCANE', 'HUNT SHOWDOWN - ARCANE',
  'MARVEL RIVALS - PREDATOR', 'MARVEL RIVALS - ARCANE', 'OFF THE GRID - ARCANE',
  'PUBG - FULL', 'RUST - MEK EXTERNAL', 'RUST - DIVISION EXTERNAL', 'RUST - COFFEE RUST',
  'SCUM - ARCANE', 'SEA OF THIEVES - ARCANE', 'SQUAD - ARCANE', 'VALORANT - COLORBOT',
  'VALORANT - VIP', 'WAR THUNDER - ARCANE', 'HWID SPOOFER - EXODUS TEMPORARY',
  'HWID SPOOFER - VERSE PERMANENT', 'HWID SPOOFER - RANKED TPM TEMPORARY',
];

// Categories whose products are not files.
//
// A service — ACCOUNT RECOVERY, RANK BOOSTING, COINS, BLUEPRINTS — is carried
// out by a person, so listing one in a download panel offers the customer a
// button that can never do anything: it sat there reading "Coming soon"
// forever, because there is nothing that would ever arrive. Excluded by
// CATEGORY rather than by name, so a service added to the store later is left
// out without another code change.
//
// DOWNLOADS_EXCLUDE_CATEGORIES overrides the list (comma-separated); set it to
// a single space to exclude nothing.
const NON_DOWNLOADABLE = new Set(
  String(process.env.DOWNLOADS_EXCLUDE_CATEGORIES == null ? 'Services' : process.env.DOWNLOADS_EXCLUDE_CATEGORIES)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// A select-menu option value is capped at 100 characters and must be stable
// across restarts — the panel message stays in #downloads between deploys, so
// an id that changed shape would make every existing dropdown dead. Slugging
// the name gives both, and the name is the key in the backend table too, so
// one row per name means one id per row.
function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || 'product').slice(0, 90);
}

// What the dropdown SHOWS, which is not what the table is keyed by.
//
// The panel listed the product name alone, and a product name on its own is
// often unidentifiable: the catalog has an "Ancient" (Arc Raiders), an
// "ARCANE" (Arc Raiders), a "PREDATOR" (Marvel Rivals) and an "ACCOUNT
// RECOVERY" (Services), and nothing in the dropdown said which game any of
// them was for.
//
// The game cannot simply be folded into `name`, though: the backend link table
// is keyed by the catalog product NAME, and the website resolves an
// entitlement by matching that same name against the order's items snapshot
// (backend routes/downloads.js). Rename the key and the one link that is
// already saved — "ONTOP Private External" — stops resolving. So the game rides
// along as a separate display field.
function displayLabel(name, game) {
  const n = String(name || '').trim();
  const g = String(game || '').trim();
  // No game to prefix with: the legacy floor already reads "GAME - PRODUCT",
  // and prefixing it again would give "Arc Raiders - ARC RAIDERS - ANCIENT".
  if (!g) return n;

  // Half the catalog already says the game inside the product name, at one end
  // or the other — "APEX LEGENDS: FULL", "VALORANT COLORBOT", "ARCANE: ACTIVE
  // MATTER". Prefixing those verbatim reads as a stutter, so the repeat comes
  // off first and every row ends up in the same shape.
  //
  // Only a WHOLE-title match is stripped: "ARENA BREAKOUT: FULL" under the game
  // "Arena Breakout Infinite" keeps its name, because "Arena Breakout" is a
  // different product line and chopping a partial title would rewrite meaning
  // rather than remove a repeat.
  const esc = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const SEP = '[\\s:\u2013\u2014-]+';
  let bare = n
    .replace(new RegExp(`^${esc}${SEP}`, 'i'), '')
    .replace(new RegExp(`${SEP}${esc}$`, 'i'), '')
    .trim();
  // A name that was nothing but the game title leaves the game standing alone
  // rather than "Rust - Rust".
  if (!bare) return g;
  return `${g} - ${bare}`;
}

// id → { id, name, label, game, url, version, updated, instructions, vault }
let byId = new Map();
let byName = new Map();
let lastRefresh = 0;
let refreshing = null;

function put(name, extra = {}) {
  const clean = String(name || '').trim();
  if (!clean) return;
  const id = slugify(clean);
  const existing = byId.get(id) || { id, name: clean, url: '', vault: false };
  const merged = { ...existing, ...extra, id, name: extra.name || existing.name || clean };
  // The link table carries no game — it is keyed by product name only — so an
  // entry arriving from there must not blank the game the catalog supplied.
  merged.game = extra.game || existing.game || '';
  merged.label = displayLabel(merged.name, merged.game);
  byId.set(id, merged);
  byName.set(merged.name.toUpperCase(), merged);
}

// The cache is the LAST KNOWN table, not an override of it — the backend wins
// on every successful refresh. Writing it back on each refresh is what lets a
// cold start with a dead backend still show real links.
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Tolerate the OLD file shape (id → url string) so an upgrade does not
    // throw away links that were set before this change.
    for (const [k, v] of Object.entries(raw || {})) {
      if (typeof v === 'string') put(k.replace(/_/g, ' ').toUpperCase(), { url: v });
      else if (v && typeof v === 'object') put(v.name || k, v);
    }
    console.log(`✅ Loaded ${byId.size} cached download entries`);
  } catch (err) {
    console.error('Failed to load download cache:', err.message);
  }
}

function saveCache() {
  try {
    const out = {};
    for (const p of byId.values()) out[p.id] = p;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (_) { /* the cache is an optimisation; losing it costs one refresh */ }
}

async function fetchFromBackend() {
  const secret = process.env.API_SECRET;
  if (!secret) throw new Error('API_SECRET is not set on the bot');

  // The link table first — it is the authoritative answer for URLs.
  const links = await axios.get(`${BACKEND_URL}/api/downloads/bot/all`, {
    params: { secret }, timeout: 10000,
  });

  // …then the catalog, so a product that exists in the store but has no link
  // yet still appears in the dropdown as "Coming soon" rather than being
  // invisible until someone remembers to add it here.
  let catalog = [];
  try {
    const res = await axios.get(`${BACKEND_URL}/api/products`, { timeout: 10000 });
    catalog = Array.isArray(res.data) ? res.data : (res.data && res.data.products) || [];
  } catch (err) {
    console.warn('[Downloads] catalog unavailable, using the link table only:', err.message);
  }

  const prevById = byId, prevByName = byName;
  byId = new Map(); byName = new Map();

  try {
    // /api/products is a FLAT LIST OF TIERS, so the same product appears once
    // per price. put() is idempotent on the name, which collapses them.
    //
    // `category` is the game title on this API — there is no game_name field,
    // whatever the DB column is called.
    //
    // Anything in a non-downloadable category is left out entirely — see
    // NON_DOWNLOADABLE. Their names are collected so an entry arriving from the
    // link table cannot put them back.
    const excluded = new Set();
    for (const row of catalog) {
      const name = row && (row.product_name || row.name);
      if (!name) continue;
      const game = String(row.category || row.game_name || '').trim();
      if (NON_DOWNLOADABLE.has(game.toLowerCase())) {
        excluded.add(String(name).trim().toUpperCase());
        continue;
      }
      put(name, { vault: false, game });
    }
    // The floor applies ONLY when the catalog could not be read. Once it can,
    // the legacy names are duplicates of catalog products under a different
    // spelling — "ARC RAIDERS - ANCIENT" beside the catalog's "Ancient" — and
    // they are duplicates that cannot work: a link saved against a legacy name
    // is not a key the website's entitlement check will ever match, so it
    // would show a download in Discord that the site refuses to serve. 60 of
    // them beside 74 real products also overflowed the 125-slot panel, which
    // is where the "9 products do not fit" warning came from.
    if (!catalog.length) for (const name of LEGACY_PRODUCTS) put(name);
    for (const d of (links.data && links.data.downloads) || []) {
      if (excluded.has(String(d.name || '').trim().toUpperCase())) continue;
      put(d.name, {
        url: d.link || '',
        version: d.version || null,
        updated: d.updated || null,
        instructions: d.instructions || null,
        vault: !!d.vault,
      });
    }
    lastRefresh = Date.now();
    saveCache();
  } catch (err) {
    // Never leave the maps half-built — a partially applied refresh reads as
    // "half the products vanished".
    byId = prevById; byName = prevByName;
    throw err;
  }
}

// Callers are interaction handlers on a 3-second Discord deadline, so this is
// never awaited on the hot path: it refreshes in the background and the
// dropdown shows the previous table until it lands. Concurrent calls share one
// in-flight request.
function refresh(force = false) {
  if (!force && Date.now() - lastRefresh < REFRESH_MS) return refreshing || Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = fetchFromBackend()
    .catch(err => { console.error('[Downloads] refresh failed:', err.message); })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Seed the floor BEFORE the cache, and before the first refresh has had a
// chance to land. Without this a cold start with no cache file and an
// unreachable backend leaves the panel with zero options — and an empty
// dropdown is not a valid Discord component, so /setupdownloads would throw
// rather than degrade.
for (const name of LEGACY_PRODUCTS) put(name);
loadCache();

// Sorted by what the dropdown shows, so the alphabetical order the customer
// reads is the order they were promised — sorting by `name` while displaying
// `label` would look shuffled.
function getAllProducts() {
  refresh();
  return [...byId.values()].sort((a, b) =>
    (a.label || a.name).localeCompare(b.label || b.name, 'en', { sensitivity: 'base' })
  );
}

function getProduct(id) {
  refresh();
  return byId.get(String(id)) || null;
}

function getProductByName(name) {
  refresh();
  return byName.get(String(name || '').toUpperCase().trim()) || null;
}

// Writes THROUGH to the backend, so the site and the bot cannot disagree and
// the link survives the next deploy. Throws on failure — the caller must say
// so rather than reporting a save that did not happen, which is how the old
// file-only write looked successful right up until the container was replaced.
async function setProductUrl(id, url) {
  const product = byId.get(String(id));
  const name = product ? product.name : String(id);
  if (!process.env.API_SECRET) throw new Error('API_SECRET is not set on the bot — cannot save the link');

  const res = await axios.post(`${BACKEND_URL}/api/downloads/bot/set`, {
    secret: process.env.API_SECRET, name, link: url, vault: !!(product && product.vault),
  }, { timeout: 10000 });

  const entry = (res.data && res.data.entry) || {};
  put(name, {
    url: entry.link != null ? entry.link : url,
    version: entry.version || (product && product.version) || null,
    updated: entry.updated || null,
    instructions: entry.instructions || (product && product.instructions) || null,
  });
  saveCache();
  return byId.get(slugify(name));
}

// Discord allows 5 action rows per message and 25 options per select, so the
// panel can carry 125 products. The old code hardcoded exactly 3 pages, which
// silently dropped everything past the 75th the moment the catalog grew.
const MAX_PAGES = 5;

function getProductChunks() {
  const all = getAllProducts();
  const chunks = [];
  for (let i = 0; i < all.length && chunks.length < MAX_PAGES; i += 25) chunks.push(all.slice(i, i + 25));
  const dropped = all.length - chunks.reduce((n, c) => n + c.length, 0);
  if (dropped > 0) {
    console.warn(`[Downloads] ${dropped} products do not fit the ${MAX_PAGES}-page panel and are not listed`);
  }
  return chunks;
}

module.exports = {
  getAllProducts, getProduct, setProductUrl, getProductByName, getProductChunks,
  refresh, slugify,
};
