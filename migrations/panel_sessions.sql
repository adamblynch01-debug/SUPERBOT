-- ─── Web panel sessions ──────────────────────────────────────────────────────
-- The panel kept its logins in a `new Map()` in modules/panel.js. That is fine
-- until the process restarts — and this service redeploys on every push, so in
-- practice every deploy silently logged out everyone who was mid-edit. It also
-- meant the panel could never run on more than one Railway replica: the second
-- instance would not recognise a cookie the first one issued.
--
-- The cookie value is NOT what is stored here. `session_id` holds a SHA-256 of
-- the cookie, so a read of this table does not hand anyone a usable session
-- the way a leaked plaintext token would.
--
-- `guilds` is the snapshot of what the user could manage AT LOGIN, exactly as
-- the Map held it — the panel re-checks the guild on every request against
-- this list, and the list only refreshes on a new login.
--
-- No FK to guilds(guild_id): a session also lists servers the bot is NOT in
-- yet (the "Invite" cards), and those have no row there by definition.
--
--   node run-sql.js migrations/panel_sessions.sql
--   -- or: psql "$DATABASE_URL" -f migrations/panel_sessions.sql

CREATE TABLE IF NOT EXISTS panel_sessions (
  session_id      TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  username        TEXT,
  avatar          TEXT,
  csrf            TEXT NOT NULL,
  guilds          JSONB NOT NULL DEFAULT '{"manageable":[],"installable":[]}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_panel_sessions_exp  ON panel_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_panel_sessions_user ON panel_sessions(discord_user_id);
