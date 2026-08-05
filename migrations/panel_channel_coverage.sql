-- ── The settings that only ever existed as env vars ──────────────────────────
--
-- "everyhting on web panel does not cover evrything , all the channel id
-- setting etc.. second server has all the same channels but ofc different
-- channel id as is a different server."
--
-- Exactly right, and the reason is structural rather than an oversight: an env
-- var is one value for the whole process. The bot is in two servers. Every
-- channel below was a single id shared by both, which on the second server
-- meant one of two things — the message went to the first server's channel
-- (orders, restocks, gen logs; client.channels.fetch is bot-wide and resolves
-- happily across guilds), or it went nowhere at all.
--
-- Twelve columns, all nullable, all TEXT. NULL is meaningful: it says "this
-- guild has not configured this", and every consumer falls back to its env var
-- when it reads null — so the original server behaves exactly as it does today
-- until somebody deliberately fills a field in.
--
-- TEXT and not BIGINT. A Discord snowflake is 19 digits, past
-- Number.MAX_SAFE_INTEGER, and the moment one round-trips through a JS number
-- it comes back subtly wrong (…341396 → …341400) and every lookup silently
-- misses. That has already cost this codebase one round.
--
-- ORDER_LOG_CHANNEL_ID is deliberately NOT here. The owner settled in July that
-- it is a Railway variable and the DB is never consulted while it is set; a
-- panel field for it would be a second source of truth for the one channel that
-- carries customer emails.
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS orders_channel_id          TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS restock_channel_id         TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS vault_restock_channel_id   TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS manual_delivery_channel_id TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS sms_gen_channel_id         TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS gen_log_channel_id         TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS alerts_channel_id          TEXT;
-- No support_channel_id. /panel posts the ticket panel into the channel it is
-- run in, so there is nothing to read the setting — and a column with no reader
-- is a field that saves, reports success and changes nothing.
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS rank_boost_log_channel     TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS rank_boost_role_id         TEXT;
-- Separate from staff_role_id on purpose. staff_role_id is the money gate —
-- index.js hasAccess() reads it and it covers /web-balance, /addstock,
-- /clearstock and /giveaway. The ticket team needs to press Reply and Close,
-- not to move money. Collapsing the two would hand the till to everyone on the
-- ticket rota, which is the mistake the env split was created to avoid.
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS ticket_staff_role_id       TEXT;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS customer_role_id           TEXT;
