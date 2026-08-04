-- Round 29 item 1: a language dropdown under every post.
--
-- Two tables, both caches in the strict sense — losing either costs a round
-- trip to the translation provider or one dropdown click, never data.

-- Keyed on the hash of the SOURCE text, not on a post id, and that is the
-- point: the documents behind /post-tos and friends are edited by staff, and a
-- cache keyed on the post would keep serving the translation of the version
-- before the edit. A hash simply stops matching.
CREATE TABLE IF NOT EXISTS translations (
  source_hash  text        NOT NULL,
  target_lang  text        NOT NULL,
  source_text  text        NOT NULL,
  translated   text        NOT NULL,
  provider     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, target_lang)
);

-- Which language to show someone before they ask. Seeded from the language
-- their Discord client is already in, so most readers never open the dropdown.
CREATE TABLE IF NOT EXISTS user_locales (
  guild_id   text        NOT NULL,
  user_id    text        NOT NULL,
  lang       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

-- Old entries are worth reaping one day, but not automatically: the whole
-- value of this table is that a document translated a year ago is still
-- instant. Reap by created_at only if it ever grows enough to matter.
CREATE INDEX IF NOT EXISTS idx_translations_created ON translations (created_at);
