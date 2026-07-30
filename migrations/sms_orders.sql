-- ─── sms_orders: survive a restart ──────────────────────────────────
-- Active SMS orders lived only in an in-memory Map. A number bought through
-- /gennumber spends REAL provider credit at that instant, and a Railway restart
-- 30 seconds later (a deploy, an OOM from the canvas renderer, any crash) wiped
-- the Map: the 5-minute cancel/refund never fired so the provider kept the
-- charge, the Discord message showed "waiting" forever, and pressing
-- 🚫 Cancel & Refund answered "Order not found" — the refund was unreachable
-- without logging into the provider dashboard by hand.
--
-- Persisted here and rehydrated on boot, so polling and the refund window
-- resume where they left off.
--
-- Run in Supabase (Session pooler) BEFORE deploying the bot.

CREATE TABLE IF NOT EXISTS sms_orders (
  order_id     TEXT PRIMARY KEY,
  guild_id     TEXT,
  provider     TEXT NOT NULL,           -- '5sim' | 'smspool'
  service_name TEXT,
  country      TEXT,
  number       TEXT,
  user_id      TEXT NOT NULL,           -- Discord snowflake, as TEXT
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'waiting',  -- waiting | received | failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

-- Open orders only: what boot needs to rehydrate.
CREATE INDEX IF NOT EXISTS idx_sms_orders_open
  ON sms_orders (created_at DESC) WHERE resolved_at IS NULL;
