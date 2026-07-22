// ─── Postgres connection ─────────────────────────────────────────────────────
// Railway: add a Postgres plugin to your project — it injects DATABASE_URL
// automatically, this file just needs that env var to exist.
'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set — anything using db.js will fail until it is.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal DATABASE_URL doesn't need SSL. If you ever connect to
  // an external Postgres that requires it, set PGSSL=true in your env vars.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected Postgres client error:', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Every guild-scoped table has a foreign key back to guilds(guild_id), so
// call this before writing anything for a guild you haven't seen yet —
// it's a no-op (ON CONFLICT) if the row already exists.
async function ensureGuild(guildId, guildName, ownerDiscordId) {
  await query(
    `INSERT INTO guilds (guild_id, guild_name, owner_discord_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name`,
    [guildId, guildName || null, ownerDiscordId || null]
  );
}

module.exports = { pool, query, ensureGuild };
