require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgRun, pgQuery } = require('../db/postgres');

async function ensureFloAppstleRevenueTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS flo_appstle_billing_attempts (
      subscription_appstle_id TEXT NOT NULL,
      attempt_key TEXT NOT NULL,
      attempt_id TEXT,
      order_id TEXT,
      order_name TEXT,
      attempt_status TEXT,
      attempt_date TIMESTAMPTZ,
      amount NUMERIC(14,4),
      currency_code TEXT,
      is_successful BOOLEAN DEFAULT FALSE,
      is_initial_order BOOLEAN DEFAULT FALSE,
      raw_json JSONB,
      etl_fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (subscription_appstle_id, attempt_key)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_date ON flo_appstle_billing_attempts (attempt_date)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_success ON flo_appstle_billing_attempts (is_successful, is_initial_order, attempt_date)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_order_id ON flo_appstle_billing_attempts (order_id)`);

  await pgRun(`
    CREATE TABLE IF NOT EXISTS flo_appstle_revenue_daily (
      date DATE PRIMARY KEY,
      shopify_sub_gross NUMERIC(14,4) DEFAULT 0,
      shopify_sub_disc NUMERIC(14,4) DEFAULT 0,
      shopify_sub_refunds NUMERIC(14,4) DEFAULT 0,
      rebill_revenue NUMERIC(14,4) DEFAULT 0,
      new_sub_revenue NUMERIC(14,4) DEFAULT 0,
      sub_revenue_actual NUMERIC(14,4) DEFAULT 0,
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getFloAppstleRevenueBounds() {
  await ensureFloAppstleRevenueTable();
  const r = await pgQuery(`
    WITH shopify_bounds AS (
      SELECT
        MIN(o.date_key)::date AS min_date,
        MAX(o.date_key)::date AS max_date
      FROM shopify_orders_raw o
      WHERE o.store_key = 'FLO_MAIN'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(o.line_items) li
          WHERE COALESCE(li->>'sku', '') ILIKE '%AppSubscription%'
             OR COALESCE(li->>'title', '') ILIKE '%Subscription%'
        )
    ), contract_bounds AS (
      SELECT
        MIN(created_at)::date AS min_date,
        MAX(created_at)::date AS max_date
      FROM flo_appstle_subscribers
    ), attempt_bounds AS (
      SELECT
        MIN(attempt_date)::date AS min_date,
        MAX(attempt_date)::date AS max_date
      FROM flo_appstle_billing_attempts
    )
    SELECT
      MIN(d)::text AS start_date,
      MAX(d)::text AS end_date
    FROM (
      SELECT min_date AS d FROM shopify_bounds
      UNION ALL SELECT max_date FROM shopify_bounds
      UNION ALL SELECT min_date FROM contract_bounds
      UNION ALL SELECT max_date FROM contract_bounds
      UNION ALL SELECT min_date FROM attempt_bounds
      UNION ALL SELECT max_date FROM attempt_bounds
    ) q
    WHERE d IS NOT NULL
  `, []);

  return {
    startDate: r.rows[0]?.start_date || null,
    endDate: r.rows[0]?.end_date || null,
  };
}

async function syncFloAppstleRevenue(startDate, endDate) {
  await ensureFloAppstleRevenueTable();
  if (!startDate || !endDate) return { rows: 0, errors: [] };

  await pgRun(`
    WITH parsed AS (
      SELECT *, CASE
        WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object' THEN raw_json->'lastSuccessfulOrder'
        WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string' THEN (raw_json->>'lastSuccessfulOrder')::jsonb
        ELSE NULL
      END AS success_json
      FROM flo_appstle_subscribers
    ), has_attempt_history AS (
      SELECT EXISTS (SELECT 1 FROM flo_appstle_billing_attempts LIMIT 1) AS yes
    ), shopify_app_orders AS (
      SELECT
        o.order_name,
        o.date_key::date AS date,
        MAX(o.total_price) AS total_price,
        SUM(CASE
          WHEN COALESCE(li->>'sku', '') ILIKE '%AppSubscription%'
            OR COALESCE(li->>'title', '') ILIKE '%Subscription%'
          THEN COALESCE((li->'discountedUnitPriceSet'->'shopMoney'->>'amount')::numeric, 0)
             * COALESCE((li->>'quantity')::numeric, 0)
          ELSE 0
        END) AS app_amount,
        SUM(CASE
          WHEN NOT (
            COALESCE(li->>'sku', '') ILIKE '%AppSubscription%'
            OR COALESCE(li->>'title', '') ILIKE '%Subscription%'
          )
          THEN COALESCE((li->'discountedUnitPriceSet'->'shopMoney'->>'amount')::numeric, 0)
             * COALESCE((li->>'quantity')::numeric, 0)
          ELSE 0
        END) AS non_app_amount
      FROM shopify_orders_raw o
      CROSS JOIN LATERAL jsonb_array_elements(o.line_items) li
      WHERE o.store_key = 'FLO_MAIN'
        AND o.date_key BETWEEN $1::date AND $2::date
      GROUP BY o.order_name, o.date_key
    ), shopify_classified AS (
      SELECT
        s.date,
        s.order_name,
        CASE WHEN s.non_app_amount = 0 THEN s.total_price ELSE s.app_amount END AS revenue,
        EXISTS (
          SELECT 1
          FROM flo_appstle_subscribers a
          WHERE a.order_name = s.order_name
        ) AS is_new_sub
      FROM shopify_app_orders s
      WHERE s.app_amount > 0
    ), has_shopify_history AS (
      SELECT EXISTS (SELECT 1 FROM shopify_classified LIMIT 1) AS yes
    ), dates AS (
      SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS date
    ), new_subs AS (
      SELECT date,
             COALESCE(SUM(revenue), 0) AS new_sub_revenue
      FROM shopify_classified
      WHERE is_new_sub
        AND (SELECT yes FROM has_shopify_history)
      GROUP BY date

      UNION ALL

      SELECT DATE(created_at) AS date,
             COALESCE(SUM(order_amount), 0) AS new_sub_revenue
      FROM parsed
      WHERE DATE(created_at) BETWEEN $1::date AND $2::date
        AND NOT (SELECT yes FROM has_shopify_history)
      GROUP BY DATE(created_at)
    ), billing_attempt_rebills AS (
      SELECT attempt_date::date AS date,
             COALESCE(SUM(amount), 0) AS rebill_revenue
      FROM flo_appstle_billing_attempts
      WHERE is_successful = TRUE
        AND COALESCE(is_initial_order, FALSE) = FALSE
        AND amount > 0
        AND attempt_date::date BETWEEN $1::date AND $2::date
      GROUP BY attempt_date::date
    ), shopify_rebills AS (
      SELECT date,
             COALESCE(SUM(revenue), 0) AS rebill_revenue
      FROM shopify_classified
      WHERE NOT is_new_sub
      GROUP BY date
    ), legacy_rebills AS (
      SELECT (success_json->>'orderDate')::timestamptz::date AS date,
             COALESCE(SUM((success_json->>'orderAmount')::numeric), 0) AS rebill_revenue
      FROM parsed
      WHERE success_json ? 'orderDate'
        AND (success_json->>'orderDate')::timestamptz::date BETWEEN $1::date AND $2::date
      GROUP BY (success_json->>'orderDate')::timestamptz::date
    ), rebills AS (
      SELECT date, rebill_revenue
      FROM billing_attempt_rebills
      WHERE (SELECT yes FROM has_attempt_history)

      UNION ALL

      SELECT date, rebill_revenue
      FROM shopify_rebills
      WHERE NOT (SELECT yes FROM has_attempt_history)
        AND (SELECT yes FROM has_shopify_history)

      UNION ALL

      SELECT date, rebill_revenue
      FROM legacy_rebills
      WHERE NOT (SELECT yes FROM has_attempt_history)
        AND NOT (SELECT yes FROM has_shopify_history)
    ), app_refunds AS (
      SELECT (r->>'createdAt')::timestamptz::date AS date,
             COALESCE(SUM((edge->'node'->'subtotalSet'->'shopMoney'->>'amount')::numeric), 0) AS refund_amount
      FROM shopify_orders_raw o
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.refunds, '[]'::jsonb)) r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r->'refundLineItems'->'edges', '[]'::jsonb)) edge
      WHERE o.store_key = 'FLO_MAIN'
        AND (r->>'createdAt')::timestamptz::date BETWEEN $1::date AND $2::date
        AND (
          COALESCE(edge->'node'->'lineItem'->>'sku', '') ILIKE '%AppSubscription%'
          OR COALESCE(edge->'node'->'lineItem'->>'title', '') ILIKE '%Subscription%'
        )
      GROUP BY (r->>'createdAt')::timestamptz::date
    ), final_rows AS (
      SELECT
        d.date,
        COALESCE(n.new_sub_revenue, 0) + COALESCE(r.rebill_revenue, 0) AS shopify_sub_gross,
        0::numeric AS shopify_sub_disc,
        COALESCE(ar.refund_amount, 0) AS shopify_sub_refunds,
        COALESCE(r.rebill_revenue, 0) AS rebill_revenue,
        COALESCE(n.new_sub_revenue, 0) AS new_sub_revenue,
        COALESCE(n.new_sub_revenue, 0) + COALESCE(r.rebill_revenue, 0) AS sub_revenue_actual
      FROM dates d
      LEFT JOIN new_subs n ON n.date = d.date
      LEFT JOIN rebills r ON r.date = d.date
      LEFT JOIN app_refunds ar ON ar.date = d.date
    )
    INSERT INTO flo_appstle_revenue_daily (
      date, shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
      rebill_revenue, new_sub_revenue, sub_revenue_actual,
      computed_at, updated_at
    )
    SELECT
      date, shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
      rebill_revenue, new_sub_revenue, sub_revenue_actual,
      NOW(), NOW()
    FROM final_rows
    ON CONFLICT (date) DO UPDATE SET
      shopify_sub_gross   = EXCLUDED.shopify_sub_gross,
      shopify_sub_disc    = EXCLUDED.shopify_sub_disc,
      shopify_sub_refunds = EXCLUDED.shopify_sub_refunds,
      rebill_revenue      = EXCLUDED.rebill_revenue,
      new_sub_revenue     = EXCLUDED.new_sub_revenue,
      sub_revenue_actual  = EXCLUDED.sub_revenue_actual,
      computed_at         = NOW(),
      updated_at          = NOW()
  `, [startDate, endDate]);

  const dayMs = 24 * 60 * 60 * 1000;
  const rows = Math.floor((new Date(endDate) - new Date(startDate)) / dayMs) + 1;
  return { rows: Math.max(rows, 0), errors: [] };
}

async function syncFloAppstleRevenueFullRange() {
  const { startDate, endDate } = await getFloAppstleRevenueBounds();
  if (!startDate || !endDate) return { rows: 0, errors: [] };
  return syncFloAppstleRevenue(startDate, endDate);
}

module.exports = {
  ensureFloAppstleRevenueTable,
  getFloAppstleRevenueBounds,
  syncFloAppstleRevenue,
  syncFloAppstleRevenueFullRange,
};
