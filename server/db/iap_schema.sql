-- ─────────────────────────────────────────────────────────────────────────
-- In-App Purchases (IAP) schema — NOBL & FLO mobile apps (App Store + Google Play)
--
-- ADDITIVE migration. These are brand-new tables — applying this does NOT touch
-- any existing table or data. Apply with:  node server/db/applySchema.js  (or psql -f).
-- The IAP sync (server/etl/syncIap.js) upserts into these and nothing else.
-- ─────────────────────────────────────────────────────────────────────────

-- Daily IAP sales rollup. product_id='ALL' is the per-day rollup row; individual
-- SKUs are stored alongside it so a product breakdown is available later.
CREATE TABLE IF NOT EXISTS iap_daily (
  brand          TEXT NOT NULL,                 -- 'NOBL' | 'FLO'
  platform       TEXT NOT NULL,                 -- 'apple' | 'google'
  date           DATE NOT NULL,
  product_id     TEXT NOT NULL DEFAULT 'ALL',   -- App Store SKU / Play product id; 'ALL' = rollup
  units          INT DEFAULT 0,                 -- units sold (net of refunds where the report nets them)
  revenue_usd    NUMERIC(14,2) DEFAULT 0,       -- developer proceeds in USD (0 until FX applied for non-USD)
  proceeds_raw   NUMERIC(14,2) DEFAULT 0,       -- proceeds summed in source currency (pre-FX)
  currency       TEXT,                          -- source currency when single-currency, else 'MIXED'
  source         TEXT,                          -- report type / api the row came from
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (brand, platform, date, product_id)
);
CREATE INDEX IF NOT EXISTS idx_iap_daily_date ON iap_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_iap_daily_brand_platform_date ON iap_daily (brand, platform, date DESC);

-- Daily subscription state (active / new / cancelled / trials) per brand+platform.
-- Populated from Apple SUBSCRIPTION/SUBSCRIPTION_EVENT reports and Google
-- subscription data. Round 2 will fill this; the table exists now so the page
-- and endpoint can read it without a later migration.
CREATE TABLE IF NOT EXISTS iap_subscription_daily (
  brand            TEXT NOT NULL,
  platform         TEXT NOT NULL,
  date             DATE NOT NULL,
  active_subs      INT DEFAULT 0,
  new_subs         INT DEFAULT 0,
  cancelled_subs   INT DEFAULT 0,
  trials           INT DEFAULT 0,
  proceeds_usd     NUMERIC(14,2) DEFAULT 0,
  source           TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (brand, platform, date)
);
CREATE INDEX IF NOT EXISTS idx_iap_subscription_daily_date ON iap_subscription_daily (date DESC);
