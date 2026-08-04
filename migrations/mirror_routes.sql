-- Round 30: mirror what the bot posts in one server into another.
--
-- A route is one channel → one channel. Deliberately not "one guild → one
-- guild": the useful shape is #restocks → #restocks and #status → #status,
-- and a guild-level route would have to invent the channel mapping anyway.
--
-- NOT foreign-keyed to guilds(guild_id). A route spans two servers and the
-- destination is frequently one this bot has no guilds row for — a partner's
-- server, a customer's server. A foreign key here would make the cross-server
-- case, which is the entire feature, the one that fails.
CREATE TABLE IF NOT EXISTS mirror_routes (
  id             bigserial   PRIMARY KEY,
  src_guild_id   text        NOT NULL,
  src_channel_id text        NOT NULL,
  dst_guild_id   text        NOT NULL,
  dst_channel_id text        NOT NULL,

  -- What was asked for: everything the BOT posts. Set false and the route
  -- carries human messages too, which is a shared channel rather than a
  -- mirror — same plumbing, different feature, so it is a flag and not a
  -- second table.
  bot_only       boolean     NOT NULL DEFAULT true,

  -- Off by default. A post that pings one server by design should not ping a
  -- second server that never opted into it, every single time.
  allow_pings    boolean     NOT NULL DEFAULT false,

  enabled        boolean     NOT NULL DEFAULT true,

  -- The webhook the relay posts through, so it wears the source server's name
  -- and icon. ID ONLY — never the token. The bot re-resolves the object via
  -- the destination channel, which it can do because it needs Manage Webhooks
  -- there regardless; storing the token would be putting a credential that
  -- can post to someone else's server at rest for no gain.
  webhook_id     text,

  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- One route per channel pair. Adding the same mirror twice is a duplicate
  -- post for every message, forever, and it looks like the bot has gone wrong.
  UNIQUE (src_channel_id, dst_channel_id)
);

-- The hot path: every message in every guild asks "is this channel a source?"
CREATE INDEX IF NOT EXISTS idx_mirror_routes_src
  ON mirror_routes (src_channel_id) WHERE enabled;

-- Which mirrored copy belongs to which original, so an edit or a delete in the
-- source can follow. Without this a corrected post stays wrong in the other
-- server, which is worse than not mirroring it — the second server is then
-- reading something the first one has already retracted.
CREATE TABLE IF NOT EXISTS mirror_messages (
  src_message_id text        NOT NULL,
  route_id       bigint      NOT NULL REFERENCES mirror_routes(id) ON DELETE CASCADE,
  dst_message_id text        NOT NULL,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (src_message_id, route_id)
);

-- Used only to age rows out; an edit to a month-old post is not worth an
-- unbounded table.
CREATE INDEX IF NOT EXISTS idx_mirror_messages_posted
  ON mirror_messages (posted_at);
