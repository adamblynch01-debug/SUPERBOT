// ─── One-time JSON → Postgres migration ─────────────────────────────────────
// Run this ONCE after schema.sql has been applied and DATABASE_URL is set:
//   node migrate.js
//
// Reads your existing DATA_DIR/*.json files and imports them into Postgres,
// scoped to GUILD_ID (your current single-server setup). Safe to re-run —
// everything uses ON CONFLICT / dedup checks, so running it twice won't
// duplicate rows.
'use strict';
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { query, ensureGuild } = require('./db');

const DATA_DIR  = process.env.DATA_DIR || __dirname;
const GUILD_ID  = process.env.GUILD_ID;

function loadJSON(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[migrate] Failed to parse ${file}:`, e.message);
    return fallback;
  }
}

async function migrateUsefulLinks() {
  const links = loadJSON('useful_links.json', []);
  if (!links.length) {
    console.log('[migrate] useful_links.json — nothing to migrate.');
    return;
  }

  const { rows } = await query('SELECT COUNT(*)::int AS n FROM useful_links WHERE guild_id = $1', [GUILD_ID]);
  if (rows[0].n > 0) {
    console.log(`[migrate] useful_links — guild already has ${rows[0].n} rows in Postgres, skipping (avoids duplicates). Delete them manually first if you want to re-import.`);
    return;
  }

  for (let i = 0; i < links.length; i++) {
    await query(
      `INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1, $2, $3, $4)`,
      [GUILD_ID, links[i].label, links[i].url, i]
    );
  }
  console.log(`[migrate] useful_links — imported ${links.length} links.`);
}

async function migrateStock() {
  const stock = loadJSON('stock.json', {});
  const types = Object.keys(stock);
  if (!types.length) {
    console.log('[migrate] stock.json — nothing to migrate.');
    return;
  }

  let total = 0;
  for (const type of types) {
    for (const accountData of stock[type]) {
      await query(
        `INSERT INTO stock (guild_id, type, account_data) VALUES ($1, $2, $3)`,
        [GUILD_ID, type, accountData]
      );
      total++;
    }
  }
  console.log(`[migrate] stock — imported ${total} accounts across ${types.length} type(s). (Not yet read by the bot — Phase 2.)`);
}

async function migrateKeys() {
  const keys = loadJSON('keys.json', {});
  const keyStrings = Object.keys(keys);
  if (!keyStrings.length) {
    console.log('[migrate] keys.json — nothing to migrate.');
    return;
  }

  for (const k of keyStrings) {
    const e = keys[k];
    await query(
      `INSERT INTO keys (key, guild_id, role_id, role_name, duration_ms, status, created_by, created_at, redeemed_by, redeemed_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (key) DO NOTHING`,
      [
        k, e.guildId || GUILD_ID, e.roleId, e.roleName,
        e.durationMs === 'lifetime' ? null : e.durationMs,
        e.status, e.createdBy, e.createdAt, e.redeemedBy, e.redeemedAt, e.expiresAt,
      ]
    );
  }
  console.log(`[migrate] keys — imported ${keyStrings.length} keys. (Not yet read by the bot — Phase 2.)`);
}

async function main() {
  if (!GUILD_ID) {
    console.error('[migrate] GUILD_ID env var is not set — cannot tag migrated rows to a guild. Aborting.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL env var is not set. Aborting.');
    process.exit(1);
  }

  console.log(`[migrate] Starting migration for guild ${GUILD_ID}, reading from ${DATA_DIR}...`);
  await ensureGuild(GUILD_ID, null, null);

  await migrateUsefulLinks();
  await migrateStock();
  await migrateKeys();

  console.log('[migrate] Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[migrate] Fatal error:', e);
  process.exit(1);
});
