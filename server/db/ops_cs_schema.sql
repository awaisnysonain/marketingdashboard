-- ═══════════════════════════════════════════════════════════════════
--  Ops + CS daily metrics schema
--  Idempotent. Safe to re-run.
--
--  ops_metrics_daily — populated from ERP Postgres (erp_maindb) via
--    server/etl/syncOpsMetrics.js. Mirrors the logic in the reference
--    Python script daily_ops_metrics_corrected_join.py:
--      - shipment-level fulfillment hours, averaged per order, then per brand
--      - per-order shipping cost from shipping labels, then averaged
--      - UPS ship-to-door hours from the carrier API
--      - CA/AU time-to-fulfillment from Shopify (CA/AU stores)
--    Plus:
--      - orders_unfulfilled / orders_unfulfilled_over_24h from
--        store.shiphero_live_orders.fulfillment_status (NOT in Python).
--
--  cs_tickets_daily — populated from MongoDB CS DBs (crmdb + flodb) via
--    server/etl/syncCsTickets.js. Mirrors the logic in the reference JS
--    script may20_region_counts_uk_fallback.js:
--      - conversations created in the UTC day window
--      - Shopify cascade matching (orderNo → email → phone) for region
--      - effective / attempted closes from hourly_agent_performance_conversations
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops_metrics_daily (
  brand                          TEXT          NOT NULL,
  date                           DATE          NOT NULL,
  -- shipment-derived counters
  shipments_count                INT           DEFAULT 0,
  orders_count                   INT           DEFAULT 0,
  orders_with_ups_delivery       INT           DEFAULT 0,
  -- unfulfilled counts (snapshot at run time, by created_at::date)
  orders_unfulfilled             INT           DEFAULT 0,
  us_orders_unfulfilled          INT           DEFAULT 0,
  ca_orders_unfulfilled          INT           DEFAULT 0,
  au_orders_unfulfilled          INT           DEFAULT 0,
  uk_orders_unfulfilled          INT           DEFAULT 0,
  orders_unfulfilled_over_24h    INT           DEFAULT 0,
  us_orders_unfulfilled_over_24h INT           DEFAULT 0,
  uk_orders_unfulfilled_over_24h INT           DEFAULT 0,
  -- averages (NULL when no data)
  avg_fulfillment_hours          NUMERIC(10,2),
  avg_ship_to_door_hours         NUMERIC(10,2),
  avg_shipping_cost_per_order    NUMERIC(10,2),
  -- per-country TTF from Shopify (NULL when no data)
  ca_avg_ttf_days                NUMERIC(10,4),
  ca_orders_count                INT           DEFAULT 0,
  au_avg_ttf_days                NUMERIC(10,4),
  au_orders_count                INT           DEFAULT 0,
  uk_avg_ttf_days                NUMERIC(10,4),
  uk_orders_count                INT           DEFAULT 0,
  -- diagnostics
  ups_status_counts              JSONB         DEFAULT '{}'::jsonb,
  source                         TEXT          DEFAULT 'erp_maindb',
  computed_at                    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (brand, date)
);
CREATE INDEX IF NOT EXISTS idx_ops_metrics_daily_date  ON ops_metrics_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_ops_metrics_daily_brand ON ops_metrics_daily (brand, date DESC);

CREATE TABLE IF NOT EXISTS cs_tickets_daily (
  brand                          TEXT          NOT NULL,
  date                           DATE          NOT NULL,
  total_tickets                  INT           DEFAULT 0,
  shopify_matched                INT           DEFAULT 0,
  -- match-method breakdown (useful for ops audits)
  order_matched                  INT           DEFAULT 0,
  email_fallback_matched         INT           DEFAULT 0,
  email_customer_matched         INT           DEFAULT 0,
  phone_order_matched            INT           DEFAULT 0,
  phone_order_low_confidence     INT           DEFAULT 0,
  phone_customer_matched         INT           DEFAULT 0,
  -- region split
  us_tickets                     INT           DEFAULT 0,
  ca_tickets                     INT           DEFAULT 0,
  au_tickets                     INT           DEFAULT 0,
  uk_tickets                     INT           DEFAULT 0,
  other_tickets                  INT           DEFAULT 0,
  unmatched_tickets              INT           DEFAULT 0,
  -- closes (from hourly_agent_performance_conversations)
  effective_closed_tickets       INT           DEFAULT 0,
  attempted_closed_tickets       INT           DEFAULT 0,
  -- diagnostics
  source                         TEXT          DEFAULT 'mongo:crmdb+flodb',
  source_error                   TEXT,
  computed_at                    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (brand, date)
);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_daily_date  ON cs_tickets_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_cs_tickets_daily_brand ON cs_tickets_daily (brand, date DESC);
