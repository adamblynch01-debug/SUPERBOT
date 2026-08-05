-- Split the invite channel in two.
--
-- There was one setting, invites_channel_id, and two jobs for it: the reward
-- panel (one pinned post, three buttons, meant to be read) and the join/leave
-- log (one line per member, forever). The main server had it pointed at the
-- log, so /setup-invites buried the panel under the tracker. The second server
-- had it unset, so both fell back to the name "invites" and the log filled the
-- panel channel instead.
--
-- Additive and idempotent: an existing invites_channel_id keeps meaning the
-- panel, which is what the operator always meant by it.
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS invite_log_channel_name TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS invite_log_channel_id   TEXT;
