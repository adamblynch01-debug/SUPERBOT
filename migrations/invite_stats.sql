-- ─── invite_stats + invite_joins: the invite tracker survives a restart ──────
-- Invite counts lived only in the in-memory `inviteData` Map. Two consequences,
-- both real:
--
--   1. Every deploy reset every member's invite total to zero, so the reward
--      progress bar in #invites went back to 0/10 for everyone.
--   2. `usedKeys` reset with it. Redeeming is gated on
--      `floor(real / needed) - usedKeys`, so after any restart a member who had
--      already claimed their keys could claim them all over again — a free key
--      per redeploy.
--
-- invite_joins additionally records WHO invited WHOM, which the counters alone
-- cannot answer. It is what lets a leave be attributed back to the right
-- inviter instead of being guessed at, and what the join announcement reads.
--
-- Run in Supabase (Session pooler) BEFORE deploying the bot.

CREATE TABLE IF NOT EXISTS invite_stats (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,            -- the INVITER's Discord snowflake, as TEXT
  total      INT  NOT NULL DEFAULT 0,  -- every join credited to them
  real_count INT  NOT NULL DEFAULT 0,  -- joins still in the server
  left_count INT  NOT NULL DEFAULT 0,  -- joins that have since left
  fake_count INT  NOT NULL DEFAULT 0,  -- accounts too new to count
  used_keys  INT  NOT NULL DEFAULT 0,  -- rewards already claimed
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

-- One row per member who has ever joined. PRIMARY KEY on (guild, member) so a
-- rejoin updates the existing row rather than double-crediting the inviter.
CREATE TABLE IF NOT EXISTS invite_joins (
  guild_id    TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  inviter_id  TEXT,                    -- NULL when the invite could not be resolved
  invite_code TEXT,
  fake        BOOLEAN NOT NULL DEFAULT false,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ,
  PRIMARY KEY (guild_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_invite_joins_inviter
  ON invite_joins (guild_id, inviter_id) WHERE left_at IS NULL;

-- The leaderboard's ORDER BY.
CREATE INDEX IF NOT EXISTS idx_invite_stats_board
  ON invite_stats (guild_id, real_count DESC);
