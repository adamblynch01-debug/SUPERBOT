-- ─── mod_lists + mod_settings: the moderation lists survive a restart ───────
-- BANNED_LINKS, BANNED_WORDS and the new ALLOWED_LINKS were plain arrays in
-- modules/antiscam.js. `!addlink` / `!addword` mutated them in memory only, so
-- every edit staff made was thrown away by the next deploy and the lists
-- silently reverted to the hardcoded defaults.
--
-- That matters most for the allow-list: it exists so a legitimate link (klipy
-- gifs today, whatever comes next) stops being deleted. An allow-list that
-- forgets itself on redeploy is worse than none, because the link starts
-- getting deleted again with nobody realising why.
--
-- Run in Supabase (Session pooler) BEFORE deploying the bot.

CREATE TABLE IF NOT EXISTS mod_lists (
  guild_id TEXT NOT NULL,
  list     TEXT NOT NULL,          -- 'banned_links' | 'allowed_links' | 'banned_words'
  value    TEXT NOT NULL,          -- stored lowercased
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, list, value)
);

CREATE INDEX IF NOT EXISTS idx_mod_lists_lookup ON mod_lists (guild_id, list);

CREATE TABLE IF NOT EXISTS mod_settings (
  guild_id TEXT PRIMARY KEY,
  word_timeout_minutes INT NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
