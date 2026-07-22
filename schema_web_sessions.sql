-- ════════════════════════════════════════════════════════════════════════
-- GHOST STORE — WEB SESSIONS  (additive to schema_web.sql)
-- ════════════════════════════════════════════════════════════════════════
-- Bearer-token sessions for real storefront accounts (backend/routes/auth.js).
-- Run against the same shared Railway Postgres as schema.sql + schema_web.sql.
--   node run-sql.js schema_web_sessions.sql   (or psql "$DATABASE_URL" -f ...)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS web_sessions (
  token       TEXT PRIMARY KEY,
  web_user_id BIGINT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  guild_id    TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(web_user_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_exp  ON web_sessions(expires_at);
