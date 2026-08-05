-- ── Align the moderation column defaults with what the bot actually enforces ──
--
-- guild_settings has carried warnings_before_ban / mute_duration_minutes /
-- spam_message_limit / spam_time_window since the panel was written, with
-- defaults of 3 / 10 / 5 / 10. antiscam.js has always read its own env vars,
-- whose defaults are 3 / 30 / 3 / 10 — and on Railway they are set to exactly
-- that. The two never had to agree, because nothing read the columns.
--
-- Round 33 wires the columns up. That turns the disagreement into a live policy
-- change nobody asked for: on the main server a mute would drop from 30 minutes
-- to 10, and the spam trigger would loosen from 3 messages to 5, on deploy, with
-- no one having touched a setting. So the defaults move to the numbers the bot
-- has been enforcing, and wiring the setting up becomes a no-op until somebody
-- deliberately changes one in the panel.
ALTER TABLE guild_settings ALTER COLUMN warnings_before_ban   SET DEFAULT 3;
ALTER TABLE guild_settings ALTER COLUMN mute_duration_minutes SET DEFAULT 30;
ALTER TABLE guild_settings ALTER COLUMN spam_message_limit    SET DEFAULT 3;
ALTER TABLE guild_settings ALTER COLUMN spam_time_window      SET DEFAULT 10;

-- Existing rows that still hold the OLD column default were never a choice —
-- there was nothing to choose, since no code read the value and the panel
-- simply echoed back whatever the column contained. Only those exact values are
-- moved; a row holding anything else is somebody's decision and is left alone.
-- If a guild genuinely wanted a 10-minute mute, the panel sets it back in one
-- save, and this migration has already run and will not stomp it again.
UPDATE guild_settings SET mute_duration_minutes = 30, updated_at = now()
 WHERE mute_duration_minutes = 10;
UPDATE guild_settings SET spam_message_limit = 3, updated_at = now()
 WHERE spam_message_limit = 5;
