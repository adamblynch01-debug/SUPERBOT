-- Round 30: clone a whole server, and put it back later.
--
-- One row is one point-in-time capture of a server's SHAPE — roles, channels,
-- categories, permission overwrites, emojis, and the guild's own settings.
-- Not its messages: Discord offers no supported bulk export of history, and a
-- restore that re-posted years of chat through a webhook wearing other
-- people's names would be a forgery rather than a backup.
--
-- Deliberately NOT foreign-keyed to guilds(guild_id). The case this exists for
-- is the server being gone — deleted, or the bot removed from it — and a
-- foreign key would make the snapshot of a dead guild the one thing you cannot
-- keep. It is also what makes restoring INTO A DIFFERENT server work: the
-- snapshot is a document, not a child of the thing it describes.
CREATE TABLE IF NOT EXISTS guild_snapshots (
  id          bigserial   PRIMARY KEY,
  guild_id    text        NOT NULL,          -- where it was taken FROM
  guild_name  text,                          -- kept separately: the guild may
                                             -- be unreachable when it is read
  label       text,                          -- what the operator called it
  taken_by    text,                          -- Discord user id
  taken_at    timestamptz NOT NULL DEFAULT now(),

  -- Denormalised headline numbers so /serverbackup list can render without
  -- pulling several hundred KB of jsonb per row across the wire.
  counts      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The snapshot itself. jsonb rather than text so a future migration can
  -- reach into it; `version` inside it is what a reader checks first.
  data        jsonb       NOT NULL
);

-- The only access pattern: newest snapshots for one guild.
CREATE INDEX IF NOT EXISTS idx_guild_snapshots_guild
  ON guild_snapshots (guild_id, taken_at DESC);
