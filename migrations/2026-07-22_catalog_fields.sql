-- ─── Catalog fields migration (2026-07-22) ──────────────────────────────
-- Adds the columns the rich storefront catalog needs that the original
-- `products` table lacked. Idempotent — safe to run more than once.
--
-- Run this in the Supabase SQL Editor BEFORE running catalog_seed.sql.

ALTER TABLE products ADD COLUMN IF NOT EXISTS subtitle    TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tab         TEXT;   -- tabbed games (Services / HWID Spoofer / GTA V): the tab name
ALTER TABLE products ADD COLUMN IF NOT EXISTS dropdown    JSONB;  -- {label, options:[{name, price}]} for dropdown products

-- Confirm the columns exist:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'products'
  AND column_name IN ('subtitle', 'description', 'tab', 'dropdown')
ORDER BY column_name;
