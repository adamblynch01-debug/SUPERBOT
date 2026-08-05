-- Mirror hardening: what happens when the SOURCE server is taken over.
--
-- The original design answered "can a stranger point a firehose at my server"
-- (no — /mirror add needs admin in the destination). It did not answer "what
-- if the server that already has a route gets stolen", which is the case that
-- actually happens: the attacker inherits a live, authorised relay into
-- somebody else's server and nothing in the code disagrees with them.
--
-- Three columns and one table, each closing one part of that.

-- 1. `bot_only` never meant what it says. The check was `author.bot`, and
--    EVERY webhook message has author.bot = true — so anyone with Manage
--    Webhooks in the source channel could make their own webhook and ride the
--    route. The route now carries only THIS bot's own posts, which is what
--    was asked for in the first place ("everything the bot posts"), and
--    carrying other bots and webhooks is an explicit opt-in.
ALTER TABLE mirror_routes
  ADD COLUMN IF NOT EXISTS include_other_bots boolean NOT NULL DEFAULT false;

-- 2. Why a route stopped. `enabled = false` alone is indistinguishable from
--    someone turning it off on purpose, and the difference is the whole point
--    when a destination admin wakes up to a dead relay: "you paused this" and
--    "I paused this because 300 messages arrived in a minute" need different
--    responses.
ALTER TABLE mirror_routes
  ADD COLUMN IF NOT EXISTS paused_reason text;
ALTER TABLE mirror_routes
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- 3. A per-route override for the flood threshold, in messages per minute.
--    NULL means the global default. A restock feed that legitimately bursts
--    should be able to say so rather than forcing the global limit up for
--    everyone.
ALTER TABLE mirror_routes
  ADD COLUMN IF NOT EXISTS rate_per_min integer;

-- 4. Removing a route is not enough on its own: /mirror add UPSERTs on
--    (src_channel_id, dst_channel_id) and sets enabled = true, so an attacker
--    who still holds admin at both ends can re-add what you just removed. A
--    block is the durable "no, and stop asking" — it is keyed on the GUILD,
--    not the channel, because the channel is the thing they can trivially
--    change.
CREATE TABLE IF NOT EXISTS mirror_blocks (
  guild_id         text        NOT NULL,   -- the server doing the blocking
  blocked_guild_id text        NOT NULL,   -- the source it will not accept from
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, blocked_guild_id)
);

-- Asked on every /mirror add, which is rare — but also on the panic path,
-- which is not the moment to be doing a sequential scan.
CREATE INDEX IF NOT EXISTS idx_mirror_blocks_guild ON mirror_blocks (guild_id);
