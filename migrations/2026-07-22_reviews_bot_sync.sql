-- Adds bot-sync fields to reviews so SUPERBOT can push Discord vouches into
-- the storefront reviews feed (POST /api/reviews/bot):
--   external_id — the Discord message id of the vouch, for idempotent re-sync
--   discord_id  — the voucher's Discord user id (display/attribution)
-- Idempotent: safe to run more than once.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS discord_id  TEXT;

-- One vouch message = one review; guards against double-inserts on re-sync.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_discord_external
  ON reviews(guild_id, source, external_id)
  WHERE external_id IS NOT NULL;
