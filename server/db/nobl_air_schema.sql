-- ═══════════════════════════════════════════════════════════════════
--  NOBL Air + Shopify-direct ETL schema (replaces dead TW SQL ETL)
--  Idempotent — safe to re-run.
--  Mirrors the metric definitions in the NOBL Air Report Technical Doc.
-- ═══════════════════════════════════════════════════════════════════

-- ─── Raw Shopify orders (one row per Shopify order, both brands) ────────
CREATE TABLE IF NOT EXISTS shopify_orders_raw (
  id              BIGSERIAL PRIMARY KEY,
  brand           TEXT          NOT NULL,             -- NOBL | FLO
  store_key       TEXT          NOT NULL,             -- NOBL_MAIN | FLO_MAIN | FLO_EU
  shop_id         TEXT          NOT NULL,
  order_id        TEXT          NOT NULL,             -- Shopify GID or numeric
  order_name      TEXT,                               -- "#56242"
  created_at      TIMESTAMPTZ   NOT NULL,
  date_key        DATE          NOT NULL,             -- UTC YYYY-MM-DD per doc
  customer_id     TEXT,
  customer_email  TEXT,
  customer_name   TEXT,
  total_price     NUMERIC(14,2) DEFAULT 0,
  subtotal_price  NUMERIC(14,2) DEFAULT 0,
  total_discounts NUMERIC(14,2) DEFAULT 0,
  total_tax       NUMERIC(14,2) DEFAULT 0,
  shipping_country TEXT,
  shipping_state  TEXT,
  shipping_city   TEXT,
  financial_status TEXT,
  fulfillment_status TEXT,
  -- NOBL Air detection flags (cached at fetch time per the doc's rules)
  has_air         BOOLEAN       DEFAULT FALSE,        -- any NOBLAIR* SKU
  has_luggage     BOOLEAN       DEFAULT FALSE,        -- any ALL/DUO/METAL/FD/WB/EP SKU
  is_rebill       BOOLEAN       DEFAULT FALSE,        -- has_air AND NOT has_luggage (NOBL only)
  has_paid_air    BOOLEAN       DEFAULT FALSE,        -- NOBLAIR with origPx > 0
  has_zero_air    BOOLEAN       DEFAULT FALSE,        -- NOBLAIR with origPx = 0
  -- Aggregated revenue per type (computed at fetch time)
  tag_gross       NUMERIC(14,2) DEFAULT 0,            -- NOBLAIR < $15 originalUnitPrice * qty
  tag_discounts   NUMERIC(14,2) DEFAULT 0,
  tag_refunds     NUMERIC(14,2) DEFAULT 0,
  sub_gross       NUMERIC(14,2) DEFAULT 0,            -- NOBLAIR >= $15 originalUnitPrice * qty
  sub_discounts   NUMERIC(14,2) DEFAULT 0,
  sub_refunds     NUMERIC(14,2) DEFAULT 0,
  line_items      JSONB         NOT NULL,             -- full line_items with pricing
  refunds         JSONB         DEFAULT '[]'::jsonb,
  raw_json        JSONB,                              -- full GraphQL node (for replay)
  fetched_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(brand, order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_brand_date    ON shopify_orders_raw (brand, date_key DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_air           ON shopify_orders_raw (brand, date_key, has_air) WHERE has_air;
CREATE INDEX IF NOT EXISTS idx_shopify_orders_rebill        ON shopify_orders_raw (brand, date_key) WHERE is_rebill;
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer      ON shopify_orders_raw (brand, customer_id);

-- ─── NOBL Air subscribers (Appstle contracts, one row per subscription) ─
CREATE TABLE IF NOT EXISTS nobl_air_subscribers (
  id                            BIGSERIAL PRIMARY KEY,
  appstle_id                    TEXT UNIQUE NOT NULL, -- Appstle contract id
  graph_subscription_contract_id TEXT,
  subscription_contract_id      TEXT,
  customer_id                   TEXT,
  customer_email                TEXT,
  customer_name                 TEXT,
  order_name                    TEXT,                 -- join key to shopify_orders_raw
  graph_order_id                TEXT,
  status                        TEXT,                 -- active | cancelled | paused | etc
  contract_amount               NUMERIC(8,2),         -- TIER value: 79, 99, 119, 129, 139, 149...
  order_amount                  NUMERIC(8,2),
  billing_policy_interval       TEXT,                 -- DAY | WEEK | MONTH | YEAR
  billing_policy_interval_count INT,
  currency_code                 TEXT,
  created_at                    TIMESTAMPTZ NOT NULL,
  updated_at                    TIMESTAMPTZ,
  starts_at                     TIMESTAMPTZ,
  ends_at                       TIMESTAMPTZ,
  next_billing_date             TIMESTAMPTZ,
  last_billing_date             TIMESTAMPTZ,
  cancelled_on                  TIMESTAMPTZ,
  -- TTP / activation flags (computed at write time, refreshed each sync)
  is_mature                     BOOLEAN DEFAULT FALSE, -- created_at <= today - 14d
  is_converted                  BOOLEAN DEFAULT FALSE, -- last_billing_date > created_at
  is_same_day_cancel            BOOLEAN DEFAULT FALSE, -- cancelled within 24h of create
  raw_json                      JSONB,
  etl_fetched_at                TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nobl_subs_status        ON nobl_air_subscribers (status);
CREATE INDEX IF NOT EXISTS idx_nobl_subs_tier          ON nobl_air_subscribers (contract_amount);
CREATE INDEX IF NOT EXISTS idx_nobl_subs_created       ON nobl_air_subscribers (created_at);
CREATE INDEX IF NOT EXISTS idx_nobl_subs_order_name    ON nobl_air_subscribers (order_name);

-- ─── NOBL Air daily — the "Daily Input" tab equivalent from the doc ────
CREATE TABLE IF NOT EXISTS nobl_air_daily (
  date                  DATE PRIMARY KEY,
  -- Core counts
  total_orders          INT DEFAULT 0,                -- new-customer orders (rebills excluded)
  air_orders            INT DEFAULT 0,                -- orders with NOBLAIR SKU + luggage
  paid_air_orders       INT DEFAULT 0,
  zero_air_orders       INT DEFAULT 0,
  rebill_orders         INT DEFAULT 0,                -- NOBLAIR with no luggage
  same_day_cancels      INT DEFAULT 0,                -- new subs cancelled within 24h
  -- Rates (precomputed)
  attach_rate           NUMERIC(8,4),                 -- air_orders / total_orders
  ttp_rate              NUMERIC(8,4),                 -- mature converted / mature
  activation_rate       NUMERIC(8,4),                 -- attach * ttp
  -- Revenue per the doc (all amounts in USD)
  tag_gross             NUMERIC(14,2) DEFAULT 0,
  tag_discounts         NUMERIC(14,2) DEFAULT 0,
  tag_net_sales         NUMERIC(14,2) DEFAULT 0,
  tag_refunds           NUMERIC(14,2) DEFAULT 0,
  sub_gross             NUMERIC(14,2) DEFAULT 0,
  sub_discounts         NUMERIC(14,2) DEFAULT 0,
  sub_net_sales         NUMERIC(14,2) DEFAULT 0,
  sub_refunds           NUMERIC(14,2) DEFAULT 0,
  rebill_revenue        NUMERIC(14,2) DEFAULT 0,
  new_sub_revenue       NUMERIC(14,2) DEFAULT 0,
  combined_gross        NUMERIC(14,2) DEFAULT 0,      -- tag + sub gross
  combined_net_sales    NUMERIC(14,2) DEFAULT 0,      -- gross - discounts
  combined_net_revenue  NUMERIC(14,2) DEFAULT 0,      -- net sales - refunds
  -- Tier counts (NEW SUB orders, by contractAmount tier)
  new_49                INT DEFAULT 0,
  new_79                INT DEFAULT 0,
  new_89                INT DEFAULT 0,
  new_99                INT DEFAULT 0,
  new_109               INT DEFAULT 0,
  new_119               INT DEFAULT 0,
  new_129               INT DEFAULT 0,
  new_139               INT DEFAULT 0,
  new_149               INT DEFAULT 0,
  new_159               INT DEFAULT 0,
  -- Tier counts (REBILL orders)
  rebill_49             INT DEFAULT 0,
  rebill_79             INT DEFAULT 0,
  rebill_89             INT DEFAULT 0,
  rebill_99             INT DEFAULT 0,
  rebill_109            INT DEFAULT 0,
  rebill_119            INT DEFAULT 0,
  rebill_129            INT DEFAULT 0,
  rebill_139            INT DEFAULT 0,
  rebill_149            INT DEFAULT 0,
  rebill_159            INT DEFAULT 0,
  computed_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Precomputed NOBL Air daily metrics for selectable region combinations.
-- region_key examples: US, CA, AUS, US_CA, US_AUS, CA_AUS, US_CA_AUS.
CREATE TABLE IF NOT EXISTS nobl_air_region_daily (
  region_key            TEXT NOT NULL,
  country_codes         TEXT[] NOT NULL,
  date                  DATE NOT NULL,
  total_orders          INT DEFAULT 0,
  air_orders            INT DEFAULT 0,
  paid_air_orders       INT DEFAULT 0,
  zero_air_orders       INT DEFAULT 0,
  rebill_orders         INT DEFAULT 0,
  same_day_cancels      INT DEFAULT 0,
  mature_count          INT DEFAULT 0,
  converted_count       INT DEFAULT 0,
  cancelled_30d_count   INT DEFAULT 0,
  attach_rate           NUMERIC(8,4),
  ttp_rate              NUMERIC(8,4),
  activation_rate       NUMERIC(8,4),
  cancel_rate_30d       NUMERIC(8,4),
  tag_gross             NUMERIC(14,2) DEFAULT 0,
  tag_discounts         NUMERIC(14,2) DEFAULT 0,
  tag_net_sales         NUMERIC(14,2) DEFAULT 0,
  tag_refunds           NUMERIC(14,2) DEFAULT 0,
  sub_gross             NUMERIC(14,2) DEFAULT 0,
  sub_discounts         NUMERIC(14,2) DEFAULT 0,
  sub_net_sales         NUMERIC(14,2) DEFAULT 0,
  sub_refunds           NUMERIC(14,2) DEFAULT 0,
  rebill_revenue        NUMERIC(14,2) DEFAULT 0,
  new_sub_revenue       NUMERIC(14,2) DEFAULT 0,
  combined_gross        NUMERIC(14,2) DEFAULT 0,
  combined_net_sales    NUMERIC(14,2) DEFAULT 0,
  combined_net_revenue  NUMERIC(14,2) DEFAULT 0,
  new_49                INT DEFAULT 0,
  new_79                INT DEFAULT 0,
  new_89                INT DEFAULT 0,
  new_99                INT DEFAULT 0,
  new_109               INT DEFAULT 0,
  new_119               INT DEFAULT 0,
  new_129               INT DEFAULT 0,
  new_139               INT DEFAULT 0,
  new_149               INT DEFAULT 0,
  new_159               INT DEFAULT 0,
  rebill_49             INT DEFAULT 0,
  rebill_79             INT DEFAULT 0,
  rebill_89             INT DEFAULT 0,
  rebill_99             INT DEFAULT 0,
  rebill_109            INT DEFAULT 0,
  rebill_119            INT DEFAULT 0,
  rebill_129            INT DEFAULT 0,
  rebill_139            INT DEFAULT 0,
  rebill_149            INT DEFAULT 0,
  rebill_159            INT DEFAULT 0,
  computed_at           TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(region_key, date)
);
CREATE INDEX IF NOT EXISTS idx_nobl_air_region_daily_date ON nobl_air_region_daily (date DESC);

-- ─── NOBL Air channel daily (attach rate by channel; placeholder until TW attribution wired) ─
CREATE TABLE IF NOT EXISTS nobl_air_channel_daily (
  id              BIGSERIAL PRIMARY KEY,
  date            DATE NOT NULL,
  channel         TEXT NOT NULL,                       -- Facebook Ads, Google Ads, Klaviyo, ...
  total_orders    INT DEFAULT 0,
  air_orders      INT DEFAULT 0,
  attach_rate     NUMERIC(8,4),
  attributed_revenue NUMERIC(14,2) DEFAULT 0,
  computed_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, channel)
);
CREATE INDEX IF NOT EXISTS idx_nobl_ch_date ON nobl_air_channel_daily (date DESC);

-- ─── Per-product daily (BOTH brands) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopify_product_daily (
  id              BIGSERIAL PRIMARY KEY,
  brand           TEXT NOT NULL,                       -- NOBL | FLO
  date            DATE NOT NULL,
  product_title   TEXT NOT NULL,                       -- normalized title
  sku_prefix      TEXT,                                -- e.g. ALL, NOBLAIR, FLO_PORT
  units_sold      INT DEFAULT 0,
  order_count     INT DEFAULT 0,                       -- distinct orders containing this product
  gross_revenue   NUMERIC(14,2) DEFAULT 0,
  discounts       NUMERIC(14,2) DEFAULT 0,
  net_revenue     NUMERIC(14,2) DEFAULT 0,
  refunds         NUMERIC(14,2) DEFAULT 0,
  computed_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brand, date, product_title)
);
CREATE INDEX IF NOT EXISTS idx_prod_brand_date ON shopify_product_daily (brand, date DESC);
CREATE INDEX IF NOT EXISTS idx_prod_title       ON shopify_product_daily (brand, product_title);

-- ─── FLO Appstle subscription revenue daily ────────────────────────────────
CREATE TABLE IF NOT EXISTS flo_appstle_revenue_daily (
  date                DATE PRIMARY KEY,
  shopify_sub_gross   NUMERIC(14,4) DEFAULT 0,
  shopify_sub_disc    NUMERIC(14,4) DEFAULT 0,
  shopify_sub_refunds NUMERIC(14,4) DEFAULT 0,
  rebill_revenue      NUMERIC(14,4) DEFAULT 0,
  new_sub_revenue     NUMERIC(14,4) DEFAULT 0,
  sub_revenue_actual  NUMERIC(14,4) DEFAULT 0,
  computed_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Backfill watermark — track which dates have been computed ──────────
CREATE TABLE IF NOT EXISTS etl_watermarks (
  task_name       TEXT PRIMARY KEY,
  last_complete_date DATE,
  last_run_at     TIMESTAMPTZ,
  notes           TEXT
);
