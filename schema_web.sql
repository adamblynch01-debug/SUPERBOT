-- ════════════════════════════════════════════════════════════════════════
-- GHOST STORE — WEBSITE ⇄ BOT SHARED SCHEMA  (additive to schema.sql)
-- ════════════════════════════════════════════════════════════════════════
-- Run AFTER schema.sql against the SAME Supabase Postgres database
-- (project owipuvrggatxdcdlbdkq). Point both the payment backend and
-- SUPERBOT's DATABASE_URL at this database so all data lives in one place.
--
--   psql "$DATABASE_URL" -f schema.sql        (base bot tables — run first)
--   psql "$DATABASE_URL" -f schema_web.sql     (this file — website tables)
--
-- Design notes:
--  * Every table is guild-scoped (guild_id) to match schema.sql's multi-tenant
--    model, so one Discord server == one storefront. The website always sends a
--    fixed GUILD_ID; the bot already knows its guild.
--  * The website NEVER holds the Supabase service key. It talks to the payment
--    backend (Express), which is the only thing with the service key / DB creds.
--  * These tables replace the browser-localStorage stores the site uses today:
--    ghostUsers, ghostCurrentUser, ghostTx_*, ghostOrders_*, ghostCustomProducts,
--    ghostStatuses, ghostCheatHidden, reviews.
-- ════════════════════════════════════════════════════════════════════════


-- ── WEB USERS ───────────────────────────────────────────────────────────
-- Storefront accounts (was localStorage 'ghostUsers'). Discord link enables
-- "Login with Discord" 2FA and /web-balance lookups by Discord ID.
CREATE TABLE IF NOT EXISTS web_users (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  username          TEXT NOT NULL,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,              -- bcrypt/argon2, NEVER plaintext
  discord_id        TEXT,                       -- linked Discord user (2FA + /web-balance)
  discord_verified  BOOLEAN NOT NULL DEFAULT false,
  avatar            TEXT,
  role              TEXT NOT NULL DEFAULT 'member',  -- member | staff | admin | reseller
  banned            BOOLEAN NOT NULL DEFAULT false,
  browser_token     TEXT,                       -- IP/device ban token from the site
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ,
  UNIQUE (guild_id, username),
  UNIQUE (guild_id, email)
);
CREATE INDEX IF NOT EXISTS idx_web_users_guild      ON web_users(guild_id);
CREATE INDEX IF NOT EXISTS idx_web_users_discord    ON web_users(guild_id, discord_id);


-- ── BALANCES ────────────────────────────────────────────────────────────
-- Store-credit wallet per web user (was user.balance in localStorage). Kept in
-- its own row so the bot can read/adjust it (/web-balance) without loading the
-- whole user record, and so a ledger can reconstruct it.
CREATE TABLE IF NOT EXISTS balances (
  web_user_id   BIGINT PRIMARY KEY REFERENCES web_users(id) ON DELETE CASCADE,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0,       -- store money in integer cents
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balances_guild ON balances(guild_id);


-- ── TRANSACTIONS (balance ledger) ───────────────────────────────────────
-- Every credit/debit against a wallet (was localStorage 'ghostTx_<userId>').
-- The balances table is the running total; this is the audit trail.
CREATE TABLE IF NOT EXISTS transactions (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  web_user_id   BIGINT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- 'credit' | 'debit'
  amount_cents  BIGINT NOT NULL,
  description   TEXT,
  order_id      BIGINT,                          -- set when tied to an order
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_user  ON transactions(web_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_guild ON transactions(guild_id, created_at DESC);


-- ── PRODUCTS ────────────────────────────────────────────────────────────
-- The catalog (was the in-file `gameProducts` object + 'ghostCustomProducts').
-- One row per cheat/product; pricing tiers live in product_tiers. `hidden`
-- replaces the localStorage 'ghostCheatHidden' map; `sort_order` gives the
-- "new products go to the TOP" behavior (higher = shown first).
CREATE TABLE IF NOT EXISTS products (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  game_name     TEXT NOT NULL,
  name          TEXT NOT NULL,
  tag           TEXT,
  specs         TEXT,
  platforms     TEXT[],                          -- e.g. {'Windows','Steam'}
  spoofer       BOOLEAN NOT NULL DEFAULT false,
  sections      JSONB NOT NULL DEFAULT '[]',     -- [{title, features:[...]}]
  media         JSONB NOT NULL DEFAULT '{}',     -- {youtube, video, screenshot, screenshot2, gif}
  status        TEXT NOT NULL DEFAULT 'undetected', -- undetected | updating | detected
  hidden        BOOLEAN NOT NULL DEFAULT false,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, game_name, name)
);
CREATE INDEX IF NOT EXISTS idx_products_guild ON products(guild_id, game_name, sort_order DESC);


-- ── PRODUCT TIERS ───────────────────────────────────────────────────────
-- Pricing tiers per product (was cheat.pricing[]). Stock lives in `keys`
-- (schema.sql) keyed by tier so IN/OUT OF STOCK is derivable.
CREATE TABLE IF NOT EXISTS product_tiers (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                   -- 'Day' | 'Week' | 'Month' | 'Lifetime'
  price_cents   BIGINT NOT NULL,
  period        TEXT,                            -- '24 hours', '30 days', 'lifetime'
  duration_ms   BIGINT,                          -- NULL = lifetime (matches keys.duration_ms)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (product_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tiers_product ON product_tiers(product_id, sort_order);


-- ── ORDERS ──────────────────────────────────────────────────────────────
-- Checkout orders (was localStorage 'ghostOrders_<userId>' + the payment
-- backend's own order rows). Unifies both so admin purchase history and the
-- bot's order-lookup-by-id read one table. Lifecycle mirrors the payment
-- backend: waiting -> paid -> delivered (or expired/cancelled).
CREATE TABLE IF NOT EXISTS orders (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  web_user_id       BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  email             TEXT,                        -- for guest / delivery
  discord_id        TEXT,                        -- for Discord DM delivery
  status            TEXT NOT NULL DEFAULT 'waiting', -- waiting|paid|delivered|expired|cancelled
  payment_method    TEXT,                        -- cashapp|paypal|btc|ltc|balance
  payment_info      JSONB,                       -- {address|cashtag|email|note, qr...}
  subtotal_cents    BIGINT NOT NULL DEFAULT 0,
  fee_cents         BIGINT NOT NULL DEFAULT 0,
  total_cents       BIGINT NOT NULL DEFAULT 0,
  paid_from_balance BOOLEAN NOT NULL DEFAULT false,
  external_ref      TEXT,                        -- payment backend / BlockCypher tx ref
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_guild  ON orders(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(web_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(guild_id, status);


-- ── ORDER ITEMS ─────────────────────────────────────────────────────────
-- Line items per order. Snapshots name/price at purchase time so later catalog
-- edits don't rewrite history. delivered_key links the fulfilled key from
-- `keys` (schema.sql).
CREATE TABLE IF NOT EXISTS order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  product_id    BIGINT REFERENCES products(id) ON DELETE SET NULL,
  tier_id       BIGINT REFERENCES product_tiers(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,                   -- snapshot at purchase time
  tier_label    TEXT,                            -- snapshot
  unit_cents    BIGINT NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  delivered_key TEXT REFERENCES keys(key) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);


-- ── REVIEWS / VOUCHES (website side) ────────────────────────────────────
-- Customer reviews shown on the store. Distinct from schema.sql `vouches`
-- (Discord user->user vouches); this pipeline: bot posts a vouch in Discord ->
-- synced here -> rendered on the website. `discord_vouch_id` links back.
CREATE TABLE IF NOT EXISTS reviews (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  web_user_id       BIGINT REFERENCES web_users(id) ON DELETE SET NULL,
  display_name      TEXT NOT NULL,               -- shown on the store
  product_id        BIGINT REFERENCES products(id) ON DELETE SET NULL,
  rating            SMALLINT NOT NULL DEFAULT 5, -- 1..5
  body              TEXT,
  source            TEXT NOT NULL DEFAULT 'website', -- 'website' | 'discord'
  discord_vouch_id  BIGINT REFERENCES vouches(id) ON DELETE SET NULL,
  approved          BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_guild   ON reviews(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);


-- ── PRODUCT STATUS (status page) ────────────────────────────────────────
-- Backs the /status page (was 'ghostStatuses' localStorage). Usually derived
-- from products.status, but this table lets the bot override via /post-status
-- and keeps a history-free current snapshot the status page reads directly.
CREATE TABLE IF NOT EXISTS product_status (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  product_id    BIGINT REFERENCES products(id) ON DELETE CASCADE,
  game_name     TEXT NOT NULL,                   -- denormalized for display grouping
  product_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'undetected', -- undetected | updating | detected
  note          TEXT,
  updated_by    TEXT,                            -- discord id or 'website'
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, game_name, product_name)
);
CREATE INDEX IF NOT EXISTS idx_product_status_guild ON product_status(guild_id);


-- ── DISCORD AUTH CHALLENGES (2FA login) ─────────────────────────────────
-- Short-lived challenges for "Login with Discord". Website creates a pending
-- row, bot DMs the user an "Authenticate" button, click flips it approved, the
-- website polls this row and logs the user in. Expire quickly.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  web_user_id   BIGINT REFERENCES web_users(id) ON DELETE CASCADE,
  discord_id    TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,            -- opaque token the site polls on
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_token ON auth_challenges(token);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_gc    ON auth_challenges(guild_id, discord_id);


-- ── PAYMENT-BACKEND MERGE (2026-07-22) ──────────────────────────────────
-- p-bot's backend (captivating-happiness-production, source: P-BOT-main)
-- turned out to be the real thing wired into the site's checkout. Its own
-- SUPABASE_SCHEMA.sql (flat, non-guild-scoped `products`/`stock`/`orders`/
-- `config` tables) is retired in favor of this schema. These are the
-- additions needed to carry over its exact behavior:
--   * payment_note / crypto_address — the email watcher & crypto webhook
--     look orders up by these, so they're real indexed columns, not JSONB.
--   * amount_received_cents / delivered_goods — set by /confirm + delivery.
--   * items_snapshot — the raw cart items array as received from checkout
--     (synthetic `id` slugs like "GameName-CheatName-Tier", not real
--     product_tier ids yet — the website still drives actual key delivery
--     client-side via localStorage, so this is bookkeeping/audit only for
--     now, same role p-bot's own `items JSON` column played).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note          TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_address        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_received_cents BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_goods       JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_snapshot        JSONB NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_orders_payment_note   ON orders(guild_id, payment_method, payment_note);
CREATE INDEX IF NOT EXISTS idx_orders_crypto_address ON orders(crypto_address);

-- Guild-scoped key/value store — replaces p-bot's flat `config` table.
-- Backs GET/POST /api/config and the bot's /config set|view commands.
CREATE TABLE IF NOT EXISTS config (
  guild_id   TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, key)
);

-- Serial-value stock (license keys / account strings) per pricing tier —
-- the guild-scoped equivalent of p-bot's flat `stock` table, keyed to
-- product_tiers instead of the flat products table. Backs /stock add|check
-- and POST /api/stock/add|claim.
CREATE TABLE IF NOT EXISTS product_stock (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  tier_id    BIGINT NOT NULL REFERENCES product_tiers(id) ON DELETE CASCADE,
  value      TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  order_id   BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_product_stock_tier ON product_stock(tier_id, used);

-- p-bot's cryptoUtils.js derives one fresh HD address per order (per coin)
-- and tracks the next derivation index via MAX(address_index). Guild-scoped
-- so the same derivation-index sequence survives the merge unchanged.
CREATE TABLE IF NOT EXISTS crypto_addresses (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  order_id      BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  coin          TEXT NOT NULL,                  -- 'BTC' | 'LTC'
  address_index INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crypto_addresses_coin ON crypto_addresses(guild_id, coin, address_index DESC);

-- p-bot's flat products distinguished auto-delivered stock (claim a
-- product_stock row) from manually-fulfilled tiers (admin DMs it by hand).
-- Carried onto product_tiers so delivery.js can keep that distinction.
ALTER TABLE product_tiers ADD COLUMN IF NOT EXISTS stock_type    TEXT NOT NULL DEFAULT 'auto';   -- 'auto' | 'manual'
ALTER TABLE product_tiers ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'auto';   -- 'auto' | 'manual'


-- ════════════════════════════════════════════════════════════════════════
-- NOTES FOR THE BACKEND WIRE-UP (once the payment-backend source is on disk):
--  * money is stored in integer *cents* everywhere — convert at the edges only.
--  * keys.duration_ms + product_tiers.duration_ms use the same convention
--    (NULL = lifetime) so a purchased tier maps cleanly to an issued key.
--  * order lifecycle strings match the payment backend: waiting->paid->delivered.
--  * to add the "Customer role claim" flow (invoice id + email -> @Customer),
--    look up orders by id + web_users.email, then have the bot assign the role.
-- ════════════════════════════════════════════════════════════════════════
