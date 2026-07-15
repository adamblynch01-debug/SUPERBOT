-- SUPERBOT multi-tenant schema
-- Every table below is scoped by guild_id so the bot (and eventually the web
-- panel) can serve any number of Discord servers without their data mixing.
--
-- Run this once against a fresh Postgres database (Railway: add a Postgres
-- plugin to your project, it gives you a DATABASE_URL automatically — point
-- this bot's DATABASE_URL env var at the same value).
--
--   psql "$DATABASE_URL" -f schema.sql

CREATE TABLE IF NOT EXISTS guilds (
  guild_id          TEXT PRIMARY KEY,
  guild_name        TEXT,
  owner_discord_id  TEXT,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-guild config that today lives in Railway env vars (VERIFIED_ROLE_NAME,
-- GEN_ROLE_ID, etc). Migrated feature-by-feature in Phase 2 — for now the
-- bot still reads env vars for anything not yet moved here.
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id                TEXT PRIMARY KEY REFERENCES guilds(guild_id) ON DELETE CASCADE,
  verified_role_name      TEXT DEFAULT 'Verified',
  welcome_channel_name    TEXT,
  verify_channel_name     TEXT,
  invites_channel_name    TEXT,
  invites_needed          INTEGER DEFAULT 0,
  log_channel_id          TEXT,
  staff_role_id           TEXT,
  ticket_log_channel      TEXT,
  gen_role_id             TEXT,
  overseer_role_id        TEXT,
  counting_channel_id     TEXT,
  warnings_before_ban     INTEGER DEFAULT 3,
  mute_duration_minutes   INTEGER DEFAULT 10,
  spam_message_limit      INTEGER DEFAULT 5,
  spam_time_window        INTEGER DEFAULT 10,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Useful links — fully migrated in Phase 1 (bot + panel both use this) ───
CREATE TABLE IF NOT EXISTS useful_links (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  url         TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_useful_links_guild ON useful_links(guild_id, sort_order);

-- ── Below: schema for Phase 2 features. Tables exist now so migrate.js can
-- populate them from your existing JSON files, but the bot keeps reading
-- the JSON files for these until each one is migrated in code.

CREATE TABLE IF NOT EXISTS stock (
  id            SERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  account_data  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_guild_type ON stock(guild_id, type);

CREATE TABLE IF NOT EXISTS stock_cooldowns (
  guild_id          TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  type              TEXT NOT NULL,
  last_claimed_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, user_id, type)
);

CREATE TABLE IF NOT EXISTS keys (
  key           TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL,
  role_name     TEXT NOT NULL,
  duration_ms   BIGINT,                 -- NULL = lifetime, never expires
  status        TEXT NOT NULL DEFAULT 'unredeemed',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_by   TEXT,
  redeemed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_keys_guild_status ON keys(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_keys_active_expiry ON keys(status, expires_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS tickets (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  channel_id  TEXT,
  category    TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vouches (
  id            SERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  from_user_id  TEXT NOT NULL,
  to_user_id    TEXT NOT NULL,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who's allowed into a given guild's web panel, independent of their Discord
-- roles — checked alongside "has Manage Server on Discord" at login time.
CREATE TABLE IF NOT EXISTS panel_admins (
  guild_id          TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  discord_user_id   TEXT NOT NULL,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id)
);
