// ─── Product Download Store ───────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const SAVE_FILE = path.join(__dirname, '..', 'download_urls.json');

const products = [
  { id: 'arc_raiders_ancient',           name: 'ARC RAIDERS - ANCIENT',                    url: '' },
  { id: 'arc_raiders_arcane',            name: 'ARC RAIDERS - ARCANE',                     url: '' },
  { id: 'arc_raiders_heavens_blindspot', name: "ARC RAIDERS - HEAVEN'S BLINDSPOT",          url: '' },
  { id: 'arc_raiders_full',              name: 'ARC RAIDERS - FULL',                        url: '' },
  { id: 'apex_ancient',                  name: 'APEX LEGENDS - ANCIENT',                    url: '' },
  { id: 'apex_arcane',                   name: 'APEX LEGENDS - ARCANE',                     url: '' },
  { id: 'apex_full',                     name: 'APEX LEGENDS - FULL',                       url: '' },
  { id: 'apex_exodus',                   name: 'APEX LEGENDS - EXODUS',                     url: '' },
  { id: 'ark_arcane',                    name: 'ARK ASCENDED - ARCANE',                     url: '' },
  { id: 'active_matter_arcane',          name: 'ACTIVE MATTER - ARCANE',                    url: '' },
  { id: 'arena_breakout_full',           name: 'ARENA BREAKOUT INFINITE - FULL',            url: '' },
  { id: 'battlefield_ancient',           name: 'BATTLEFIELD - ANCIENT',                     url: '' },
  { id: 'battlefield_arcane',            name: 'BATTLEFIELD - ARCANE',                      url: '' },
  { id: 'cod_blitz',                     name: 'CALL OF DUTY - BLITZ EXTERNAL',             url: '' },
  { id: 'cod_zenith_v3',                 name: 'CALL OF DUTY - ZENITH V3 (BO7)',            url: '' },
  { id: 'cod_zenith_bo6',                name: 'CALL OF DUTY - ZENITH BO6 INTERNAL',        url: '' },
  { id: 'cod_ghost_mw3',                 name: 'CALL OF DUTY - GHOST INTERNAL MW3',         url: '' },
  { id: 'cod_ghost_mw19',                name: 'CALL OF DUTY - GHOST INTERNAL MW19',        url: '' },
  { id: 'cod_h8ed',                      name: 'CALL OF DUTY - H8ED.EXE',                   url: '' },
  { id: 'cs2_predator',                  name: 'CS2 / CSGO - PREDATOR',                     url: '' },
  { id: 'dark_darker_arcane',            name: 'DARK & DARKER - ARCANE',                    url: '' },
  { id: 'dayz_external',                 name: 'DAYZ - EXTERNAL',                           url: '' },
  { id: 'dayz_chevron',                  name: 'DAYZ - CHEVRON',                            url: '' },
  { id: 'dbd_arcane',                    name: 'DEAD BY DAYLIGHT - ARCANE',                 url: '' },
  { id: 'deadside_arcane',               name: 'DEADSIDE - ARCANE',                         url: '' },
  { id: 'delta_force_full',              name: 'DELTA FORCE - FULL',                        url: '' },
  { id: 'delta_force_exodus',            name: 'DELTA FORCE - EXODUS EXTERNAL',             url: '' },
  { id: 'dune_arcane',                   name: 'DUNE AWAKENING - ARCANE',                   url: '' },
  { id: 'tarkov_ancient_chams',          name: 'ESCAPE FROM TARKOV - ANCIENT CHAMS',        url: '' },
  { id: 'tarkov_coffee',                 name: 'ESCAPE FROM TARKOV - COFFEE CHEAT',         url: '' },
  { id: 'tarkov_coffee_chams',           name: 'ESCAPE FROM TARKOV - COFFEE CHAMS',         url: '' },
  { id: 'farlight_arcane',               name: 'FARLIGHT 84 - ARCANE',                      url: '' },
  { id: 'fortnite_ancient',              name: 'FORTNITE - ANCIENT EXTERNAL',               url: '' },
  { id: 'fortnite_full',                 name: 'FORTNITE - FULL',                           url: '' },
  { id: 'fortnite_exodus',               name: 'FORTNITE - EXODUS EXTERNAL',                url: '' },
  { id: 'fortnite_venom',                name: 'FORTNITE - VENOM EXTERNAL',                 url: '' },
  { id: 'fortnite_ultimate',             name: 'FORTNITE - ULTIMATE EXTERNAL',              url: '' },
  { id: 'fortnite_arcane',               name: 'FORTNITE - ARCANE',                         url: '' },
  { id: 'grayzone_arcane',               name: 'GRAY ZONE WARFARE - ARCANE',                url: '' },
  { id: 'gta_arcane_gtav',               name: 'GTA - ARCANE V (GTAV)',                     url: '' },
  { id: 'gta_arcane_fivem',              name: 'GTA - ARCANE V (FIVEM)',                    url: '' },
  { id: 'hll_arcane',                    name: 'HELL LET LOOSE - ARCANE',                   url: '' },
  { id: 'hunt_arcane',                   name: 'HUNT SHOWDOWN - ARCANE',                    url: '' },
  { id: 'marvel_predator',               name: 'MARVEL RIVALS - PREDATOR',                  url: '' },
  { id: 'marvel_arcane',                 name: 'MARVEL RIVALS - ARCANE',                    url: '' },
  { id: 'otg_arcane',                    name: 'OFF THE GRID - ARCANE',                     url: '' },
  { id: 'pubg_full',                     name: 'PUBG - FULL',                               url: '' },
  { id: 'rust_mek',                      name: 'RUST - MEK EXTERNAL',                       url: '' },
  { id: 'rust_division',                 name: 'RUST - DIVISION EXTERNAL',                  url: '' },
  { id: 'rust_coffee',                   name: 'RUST - COFFEE RUST',                        url: '' },
  { id: 'scum_arcane',                   name: 'SCUM - ARCANE',                             url: '' },
  { id: 'sot_arcane',                    name: 'SEA OF THIEVES - ARCANE',                   url: '' },
  { id: 'squad_arcane',                  name: 'SQUAD - ARCANE',                            url: '' },
  { id: 'valorant_colorbot',             name: 'VALORANT - COLORBOT',                       url: '' },
  { id: 'valorant_vip',                  name: 'VALORANT - VIP',                            url: '' },
  { id: 'war_thunder_arcane',            name: 'WAR THUNDER - ARCANE',                      url: '' },
  { id: 'hwid_exodus_temp',              name: 'HWID WOOFER - EXODUS TEMP',                 url: '' },
  { id: 'hwid_verse_perm',               name: 'HWID WOOFER - VERSE PERM',                  url: '' },
  { id: 'ranked_tpm_woofer',             name: 'HWID WOOFER - RANKED TPM TEMP',             url: '' },
];

let urlOverrides = {};
try {
  if (fs.existsSync(SAVE_FILE)) {
    urlOverrides = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    console.log(`✅ Loaded ${Object.keys(urlOverrides).length} saved download URLs`);
  }
} catch (err) {
  console.error('Failed to load download_urls.json:', err.message);
}

function saveUrls() {
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(urlOverrides, null, 2), 'utf8'); } catch (e) {}
}

function getProduct(id) {
  const p = products.find(p => p.id === id);
  return p ? { ...p, url: urlOverrides[id] ?? p.url } : null;
}
function getAllProducts() {
  return products.map(p => ({ ...p, url: urlOverrides[p.id] ?? p.url }));
}
function setProductUrl(id, url) {
  urlOverrides[id] = url;
  saveUrls();
}
function getProductByName(name) {
  return products.find(p => p.name === name.toUpperCase().trim());
}
function getProductChunks() {
  const all = getAllProducts();
  const chunks = [];
  for (let i = 0; i < all.length; i += 25) chunks.push(all.slice(i, i + 25));
  return chunks;
}

module.exports = { getAllProducts, getProduct, setProductUrl, getProductByName, getProductChunks };
