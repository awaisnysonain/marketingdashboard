/**
 * NOBL Air daily aggregator. Runs SQL against shopify_orders_raw + nobl_air_subscribers
 * to populate nobl_air_daily — the central NOBL Air metric table that mirrors the
 * "Daily Input" tab in the technical doc's workbook.
 *
 * Idempotent: re-running for a date range overwrites those rows.
 *
 * Per the doc:
 *   - total_orders   = NOBL orders excluding rebills (NOBLAIR with no luggage)
 *   - air_orders     = orders with NOBLAIR + luggage
 *   - rebill_orders  = NOBLAIR with no luggage SKU
 *   - tag_*          = NOBLAIR line items where origPx < $15
 *   - sub_*          = NOBLAIR line items where origPx >= $15
 *   - new_sub_revenue = sub_net_sales from non-rebill orders
 *   - rebill_revenue  = Appstle lastSuccessfulOrder.orderAmount by billing date
 *   - tier counts    = via Appstle.contractAmount join on order_name
 *   - TTP rate       = converted / mature for the cohort that reached day 14
 *   - same-day cancels = sub orders cancelled within 24h
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pgQuery } = require('../db/postgres');
const { refreshNoblAirTtpSnapshots } = require('./noblAirTtpSnapshot');

const REGION_BUCKETS = [
  { key: 'US', codes: ['US'], includeBlank: false },
  { key: 'CA', codes: ['CA'], includeBlank: false },
  { key: 'AUS', codes: ['AU'], includeBlank: false },
  { key: 'DUBAI', codes: ['AE'], includeBlank: false },
  { key: 'HK', codes: ['HK'], includeBlank: false },
  { key: 'INTL', codes: [], includeBlank: true },
];

function regionCombos() {
  const out = [];
  const n = REGION_BUCKETS.length;
  for (let mask = 1; mask < (1 << n); mask += 1) {
    const buckets = REGION_BUCKETS.filter((_, i) => mask & (1 << i));
    out.push({
      key: buckets.map(b => b.key).join('_'),
      codes: Array.from(new Set(buckets.flatMap(b => b.codes))),
      includeBlank: buckets.some(b => b.includeBlank),
    });
  }
  return out;
}

const REGION_COMBOS = regionCombos();

async function ensureNoblAirRegionDailyTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS nobl_air_region_daily (
      region_key TEXT NOT NULL,
      country_codes TEXT[] NOT NULL,
      date DATE NOT NULL,
      total_orders INT DEFAULT 0,
      air_orders INT DEFAULT 0,
      paid_air_orders INT DEFAULT 0,
      zero_air_orders INT DEFAULT 0,
      rebill_orders INT DEFAULT 0,
      same_day_cancels INT DEFAULT 0,
      mature_count INT DEFAULT 0,
      converted_count INT DEFAULT 0,
      cancelled_30d_count INT DEFAULT 0,
      attach_rate NUMERIC(8,4),
      ttp_rate NUMERIC(8,4),
      activation_rate NUMERIC(8,4),
      cancel_rate_30d NUMERIC(8,4),
      tag_gross NUMERIC(14,2) DEFAULT 0,
      tag_discounts NUMERIC(14,2) DEFAULT 0,
      tag_net_sales NUMERIC(14,2) DEFAULT 0,
      tag_refunds NUMERIC(14,2) DEFAULT 0,
      sub_gross NUMERIC(14,2) DEFAULT 0,
      sub_discounts NUMERIC(14,2) DEFAULT 0,
      sub_net_sales NUMERIC(14,2) DEFAULT 0,
      sub_refunds NUMERIC(14,2) DEFAULT 0,
      rebill_revenue NUMERIC(14,2) DEFAULT 0,
      new_sub_revenue NUMERIC(14,2) DEFAULT 0,
      combined_gross NUMERIC(14,2) DEFAULT 0,
      combined_net_sales NUMERIC(14,2) DEFAULT 0,
      combined_net_revenue NUMERIC(14,2) DEFAULT 0,
      new_49 INT DEFAULT 0,
      new_79 INT DEFAULT 0,
      new_89 INT DEFAULT 0,
      new_99 INT DEFAULT 0,
      new_109 INT DEFAULT 0,
      new_119 INT DEFAULT 0,
      new_129 INT DEFAULT 0,
      new_139 INT DEFAULT 0,
      new_149 INT DEFAULT 0,
      new_159 INT DEFAULT 0,
      rebill_49 INT DEFAULT 0,
      rebill_79 INT DEFAULT 0,
      rebill_89 INT DEFAULT 0,
      rebill_99 INT DEFAULT 0,
      rebill_109 INT DEFAULT 0,
      rebill_119 INT DEFAULT 0,
      rebill_129 INT DEFAULT 0,
      rebill_139 INT DEFAULT 0,
      rebill_149 INT DEFAULT 0,
      rebill_159 INT DEFAULT 0,
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(region_key, date)
    )
  `);
  await pgRun(`ALTER TABLE nobl_air_region_daily ADD COLUMN IF NOT EXISTS mature_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_region_daily ADD COLUMN IF NOT EXISTS converted_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_region_daily ADD COLUMN IF NOT EXISTS cancelled_30d_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_region_daily ADD COLUMN IF NOT EXISTS cancel_rate_30d NUMERIC(8,4)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_nobl_air_region_daily_date ON nobl_air_region_daily (date DESC)`);
}

async function ensureNoblAirDailyCohortColumns() {
  await pgRun(`ALTER TABLE nobl_air_daily ADD COLUMN IF NOT EXISTS mature_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_daily ADD COLUMN IF NOT EXISTS converted_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_daily ADD COLUMN IF NOT EXISTS cancelled_30d_count INT DEFAULT 0`);
  await pgRun(`ALTER TABLE nobl_air_daily ADD COLUMN IF NOT EXISTS cancel_rate_30d NUMERIC(8,4)`);
}

/**
 * Aggregate NOBL Air metrics for a date range and upsert nobl_air_daily.
 * @param {string} startDate YYYY-MM-DD inclusive
 * @param {string} endDate   YYYY-MM-DD inclusive
 */
async function aggregateNoblAir(startDate, endDate) {
  await ensureNoblAirDailyCohortColumns();

  // The big "build everything for this range" CTE.
  // We compute per-date metrics, then upsert each row.
  const sql = `
    WITH
    -- Base orders (NOBL only, in window). Daily Input aligns to UTC order dates,
    -- not the Shopify-local date_key stored during ingestion.
    o AS (
      SELECT *, (created_at AT TIME ZONE 'UTC')::date AS report_date
      FROM shopify_orders_raw
      WHERE brand='NOBL'
        AND (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
    ),
    -- Per-date order/revenue aggregates
    daily_orders AS (
      SELECT
        report_date AS date,
        COUNT(*) FILTER (WHERE NOT is_rebill)                         AS total_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage)               AS air_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_paid_air) AS paid_air_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_zero_air) AS zero_air_orders,
        COUNT(*) FILTER (WHERE is_rebill)                             AS rebill_orders,
        COALESCE(SUM(tag_gross)     FILTER (WHERE NOT is_rebill), 0)  AS tag_gross,
        COALESCE(SUM(tag_discounts) FILTER (WHERE NOT is_rebill), 0)  AS tag_discounts,
        COALESCE(SUM(tag_refunds)   FILTER (WHERE NOT is_rebill), 0)  AS tag_refunds,
        COALESCE(SUM(sub_gross)     FILTER (WHERE NOT is_rebill), 0)  AS sub_gross,
        COALESCE(SUM(sub_discounts) FILTER (WHERE NOT is_rebill), 0)  AS sub_discounts,
        COALESCE(SUM(sub_refunds)   FILTER (WHERE NOT is_rebill), 0)  AS sub_refunds
      FROM o
      GROUP BY report_date
    ),
    -- Appstle is the source of truth for subscription billing revenue. Shopify
    -- rebill orders can differ from the Appstle successful-billing amounts.
    appstle_success AS (
      SELECT
        (success_json->>'orderDate')::timestamptz::date AS date,
        COALESCE(SUM((success_json->>'orderAmount')::numeric), 0) AS rebill_revenue
      FROM (
        SELECT CASE
          WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object' THEN raw_json->'lastSuccessfulOrder'
          WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string' THEN (raw_json->>'lastSuccessfulOrder')::jsonb
          ELSE NULL
        END AS success_json
        FROM nobl_air_subscribers
      ) s
      WHERE success_json ? 'orderDate'
        AND (success_json->>'orderDate')::timestamptz::date BETWEEN $1::date AND $2::date
      GROUP BY (success_json->>'orderDate')::timestamptz::date
    ),
    -- Tier breakdown of NEW subs (join via order_name to Appstle)
    new_tiers AS (
      SELECT
        o.report_date AS date,
        s.contract_amount,
        COUNT(*)::int AS n
      FROM o
      JOIN nobl_air_subscribers s ON s.order_name = o.order_name
      WHERE o.has_air AND o.has_luggage
      GROUP BY o.report_date, s.contract_amount
    ),
    -- Tier breakdown of REBILL orders (rebill orders are tied back to the
    -- customer's original subscription contract; we infer tier via contract_amount
    -- of any contract whose customer matches.
    -- Shopify stores customer_id as "gid://shopify/Customer/<num>"; Appstle stores
    -- just the numeric value. We normalize by stripping the GID prefix.
    rebill_tiers AS (
      SELECT
        o.report_date AS date,
        s.contract_amount,
        COUNT(*)::int AS n
      FROM o
      LEFT JOIN nobl_air_subscribers s ON
        s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
        OR s.customer_id = o.customer_id
      WHERE o.is_rebill
      GROUP BY o.report_date, s.contract_amount
    ),
    -- Pivot tier counts to columns
    new_tiers_pivot AS (
      SELECT
        date,
        SUM(CASE WHEN ROUND(contract_amount) =  49 THEN n ELSE 0 END)::int AS new_49,
        SUM(CASE WHEN ROUND(contract_amount) =  79 THEN n ELSE 0 END)::int AS new_79,
        SUM(CASE WHEN ROUND(contract_amount) =  89 THEN n ELSE 0 END)::int AS new_89,
        SUM(CASE WHEN ROUND(contract_amount) =  99 THEN n ELSE 0 END)::int AS new_99,
        SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS new_109,
        SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS new_119,
        SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS new_129,
        SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS new_139,
        SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS new_149,
        SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS new_159
      FROM new_tiers
      GROUP BY date
    ),
    rebill_tiers_pivot AS (
      SELECT
        date,
        SUM(CASE WHEN ROUND(contract_amount) =  49 THEN n ELSE 0 END)::int AS rebill_49,
        SUM(CASE WHEN ROUND(contract_amount) =  79 THEN n ELSE 0 END)::int AS rebill_79,
        SUM(CASE WHEN ROUND(contract_amount) =  89 THEN n ELSE 0 END)::int AS rebill_89,
        SUM(CASE WHEN ROUND(contract_amount) =  99 THEN n ELSE 0 END)::int AS rebill_99,
        SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS rebill_109,
        SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS rebill_119,
        SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS rebill_129,
        SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS rebill_139,
        SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS rebill_149,
        SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS rebill_159
      FROM rebill_tiers
      GROUP BY date
    ),
    subs_base AS (
      SELECT
        appstle_id,
        customer_id,
        order_name,
        graph_order_id,
        created_at,
        cancelled_on,
        is_same_day_cancel,
        COALESCE(
          last_billing_date,
          (CASE
            WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object'
              THEN (raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
            WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string'
              THEN ((raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
            ELSE NULL
          END)
        ) AS paid_billing_date
      FROM nobl_air_subscribers
      WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN ($1::date - INTERVAL '14 days')::date AND $2::date
    ),
    subscriber_rebills AS (
      SELECT DISTINCT s.appstle_id
      FROM subs_base s
      JOIN shopify_orders_raw o ON o.brand = 'NOBL'
        AND o.is_rebill
        AND (
          s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
          OR s.customer_id = o.customer_id
        )
      WHERE o.created_at > s.created_at
    ),
    same_day_cancel_cohorts AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS date,
        SUM(CASE WHEN is_same_day_cancel THEN 1 ELSE 0 END)::int               AS same_day_cancels
      FROM subs_base
      WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
      GROUP BY (created_at AT TIME ZONE 'UTC')::date
    ),
    ttp_cohorts AS (
      SELECT
        (s.created_at AT TIME ZONE 'UTC')::date + 14 AS date,
        COUNT(*)::int AS mature_count,
        COUNT(*) FILTER (WHERE
          s.paid_billing_date > s.created_at OR rb.appstle_id IS NOT NULL
        )::int AS converted_count,
        COUNT(*) FILTER (WHERE
          s.cancelled_on IS NOT NULL AND s.cancelled_on <= s.created_at + INTERVAL '30 days'
        )::int AS cancelled_30d_count
      FROM subs_base s
      LEFT JOIN subscriber_rebills rb ON rb.appstle_id = s.appstle_id
      WHERE (s.created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $1::date AND $2::date
      GROUP BY (s.created_at AT TIME ZONE 'UTC')::date + 14
    ),
    lag_attach AS (
      SELECT
        d.date,
        CASE
          WHEN COUNT(*) FILTER (WHERE NOT so.is_rebill) > 0
            THEN ROUND(
              COUNT(*) FILTER (WHERE so.has_air AND so.has_luggage)::numeric
              / COUNT(*) FILTER (WHERE NOT so.is_rebill),
              4
            )
          ELSE NULL
        END AS attach_rate_14d_prior
      FROM daily_orders d
      LEFT JOIN shopify_orders_raw so ON so.brand = 'NOBL'
        AND (so.created_at AT TIME ZONE 'UTC')::date = d.date - INTERVAL '14 days'
      GROUP BY d.date
    )
    SELECT
      d.date,
      d.total_orders, d.air_orders, d.paid_air_orders, d.zero_air_orders, d.rebill_orders,
      COALESCE(sc.same_day_cancels, 0) AS same_day_cancels,
      d.tag_gross, d.tag_discounts, (d.tag_gross - d.tag_discounts) AS tag_net_sales, d.tag_refunds,
      d.sub_gross, d.sub_discounts, (d.sub_gross - d.sub_discounts) AS sub_net_sales, d.sub_refunds,
      COALESCE(a.rebill_revenue, 0) AS rebill_revenue,
      (d.sub_gross - d.sub_discounts) AS new_sub_revenue,
      -- combined = new tag + new sub + rebills (= what the doc calls "Combined Gross/Net Revenue")
      (d.tag_gross + d.sub_gross + COALESCE(a.rebill_revenue, 0)) AS combined_gross,
      (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts + COALESCE(a.rebill_revenue, 0)) AS combined_net_sales,
      (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts - d.tag_refunds - d.sub_refunds + COALESCE(a.rebill_revenue, 0)) AS combined_net_revenue,
      -- Rates
      CASE WHEN d.total_orders > 0
           THEN ROUND(d.air_orders::numeric / d.total_orders, 4)
           ELSE NULL END AS attach_rate,
      CASE
        WHEN COALESCE(t.mature_count, 0) > 0
          THEN ROUND(t.converted_count::numeric / t.mature_count, 4)
        ELSE NULL
      END AS ttp_rate,
      COALESCE(t.mature_count, 0) AS mature_count,
      COALESCE(t.converted_count, 0) AS converted_count,
      COALESCE(t.cancelled_30d_count, 0) AS cancelled_30d_count,
      CASE
        WHEN COALESCE(t.mature_count, 0) > 0
          THEN ROUND(t.cancelled_30d_count::numeric / t.mature_count, 4)
        ELSE NULL
      END AS cancel_rate_30d,
      la.attach_rate_14d_prior,
      -- New tier columns
      COALESCE(np.new_49, 0)  AS new_49,
      COALESCE(np.new_79, 0)  AS new_79,
      COALESCE(np.new_89, 0)  AS new_89,
      COALESCE(np.new_99, 0)  AS new_99,
      COALESCE(np.new_109, 0) AS new_109,
      COALESCE(np.new_119, 0) AS new_119,
      COALESCE(np.new_129, 0) AS new_129,
      COALESCE(np.new_139, 0) AS new_139,
      COALESCE(np.new_149, 0) AS new_149,
      COALESCE(np.new_159, 0) AS new_159,
      -- Rebill tier columns
      COALESCE(rp.rebill_49, 0)  AS rebill_49,
      COALESCE(rp.rebill_79, 0)  AS rebill_79,
      COALESCE(rp.rebill_89, 0)  AS rebill_89,
      COALESCE(rp.rebill_99, 0)  AS rebill_99,
      COALESCE(rp.rebill_109, 0) AS rebill_109,
      COALESCE(rp.rebill_119, 0) AS rebill_119,
      COALESCE(rp.rebill_129, 0) AS rebill_129,
      COALESCE(rp.rebill_139, 0) AS rebill_139,
      COALESCE(rp.rebill_149, 0) AS rebill_149,
      COALESCE(rp.rebill_159, 0) AS rebill_159
    FROM daily_orders d
    LEFT JOIN appstle_success     a  ON a.date = d.date
    LEFT JOIN ttp_cohorts        t  ON t.date = d.date
    LEFT JOIN same_day_cancel_cohorts sc ON sc.date = d.date
    LEFT JOIN lag_attach la ON la.date = d.date
    LEFT JOIN new_tiers_pivot    np ON np.date = d.date
    LEFT JOIN rebill_tiers_pivot rp ON rp.date = d.date
    ORDER BY d.date`;
  const r = await pgQuery(sql, [startDate, endDate]);
  let written = 0;
  for (const row of r.rows) {
    const activation = (row.attach_rate_14d_prior != null && row.ttp_rate != null)
      ? Math.round(parseFloat(row.attach_rate_14d_prior) * parseFloat(row.ttp_rate) * 10000) / 10000
      : null;
    await pgRun(`
      INSERT INTO nobl_air_daily (
        date,
        total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders, same_day_cancels,
        attach_rate, ttp_rate, activation_rate,
        mature_count, converted_count, cancelled_30d_count, cancel_rate_30d,
        tag_gross, tag_discounts, tag_net_sales, tag_refunds,
        sub_gross, sub_discounts, sub_net_sales, sub_refunds,
        rebill_revenue, new_sub_revenue,
        combined_gross, combined_net_sales, combined_net_revenue,
        new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
        rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159,
        computed_at
      ) VALUES (
        $1,
        $2,$3,$4,$5,$6,$7,
        $8,$9,$10,
        $11,$12,$13,$14,
        $15,$16,$17,$18,
        $19,$20,$21,$22,
        $23,$24,
        $25,$26,$27,
        $28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
        $38,$39,$40,$41,$42,$43,$44,$45,$46,$47,
        NOW()
      )
      ON CONFLICT (date) DO UPDATE SET
        total_orders=EXCLUDED.total_orders, air_orders=EXCLUDED.air_orders,
        paid_air_orders=EXCLUDED.paid_air_orders, zero_air_orders=EXCLUDED.zero_air_orders,
        rebill_orders=EXCLUDED.rebill_orders, same_day_cancels=EXCLUDED.same_day_cancels,
        attach_rate=EXCLUDED.attach_rate, ttp_rate=EXCLUDED.ttp_rate, activation_rate=EXCLUDED.activation_rate,
        mature_count=EXCLUDED.mature_count, converted_count=EXCLUDED.converted_count,
        cancelled_30d_count=EXCLUDED.cancelled_30d_count, cancel_rate_30d=EXCLUDED.cancel_rate_30d,
        tag_gross=EXCLUDED.tag_gross, tag_discounts=EXCLUDED.tag_discounts,
        tag_net_sales=EXCLUDED.tag_net_sales, tag_refunds=EXCLUDED.tag_refunds,
        sub_gross=EXCLUDED.sub_gross, sub_discounts=EXCLUDED.sub_discounts,
        sub_net_sales=EXCLUDED.sub_net_sales, sub_refunds=EXCLUDED.sub_refunds,
        rebill_revenue=EXCLUDED.rebill_revenue, new_sub_revenue=EXCLUDED.new_sub_revenue,
        combined_gross=EXCLUDED.combined_gross, combined_net_sales=EXCLUDED.combined_net_sales,
        combined_net_revenue=EXCLUDED.combined_net_revenue,
        new_49=EXCLUDED.new_49, new_79=EXCLUDED.new_79, new_89=EXCLUDED.new_89, new_99=EXCLUDED.new_99,
        new_109=EXCLUDED.new_109, new_119=EXCLUDED.new_119, new_129=EXCLUDED.new_129,
        new_139=EXCLUDED.new_139, new_149=EXCLUDED.new_149, new_159=EXCLUDED.new_159,
        rebill_49=EXCLUDED.rebill_49, rebill_79=EXCLUDED.rebill_79, rebill_89=EXCLUDED.rebill_89,
        rebill_99=EXCLUDED.rebill_99, rebill_109=EXCLUDED.rebill_109, rebill_119=EXCLUDED.rebill_119,
        rebill_129=EXCLUDED.rebill_129, rebill_139=EXCLUDED.rebill_139,
        rebill_149=EXCLUDED.rebill_149, rebill_159=EXCLUDED.rebill_159,
        computed_at = NOW()
    `, [
      row.date,
      row.total_orders, row.air_orders, row.paid_air_orders, row.zero_air_orders, row.rebill_orders, row.same_day_cancels,
      row.attach_rate, row.ttp_rate, activation,
      row.mature_count, row.converted_count, row.cancelled_30d_count, row.cancel_rate_30d,
      row.tag_gross, row.tag_discounts, row.tag_net_sales, row.tag_refunds,
      row.sub_gross, row.sub_discounts, row.sub_net_sales, row.sub_refunds,
      row.rebill_revenue, row.new_sub_revenue,
      row.combined_gross, row.combined_net_sales, row.combined_net_revenue,
      row.new_49, row.new_79, row.new_89, row.new_99, row.new_109, row.new_119, row.new_129, row.new_139, row.new_149, row.new_159,
      row.rebill_49, row.rebill_79, row.rebill_89, row.rebill_99, row.rebill_109, row.rebill_119, row.rebill_129, row.rebill_139, row.rebill_149, row.rebill_159,
    ]);
    written++;
  }
  const regional = await aggregateNoblAirRegionalCombos(startDate, endDate);
  let snapshotRows = 0;
  try {
    const snap = await refreshNoblAirTtpSnapshots(startDate, endDate);
    snapshotRows = snap.rows;
  } catch (e) {
    console.error('[noblAirAggregate] TTP snapshot refresh failed:', e.message);
  }
  return { rows: written + regional.rows, all_rows: written, regional_rows: regional.rows, ttp_snapshot_rows: snapshotRows };
}

async function aggregateNoblAirRegionalCombos(startDate, endDate) {
  await ensureNoblAirRegionDailyTable();
  let totalRows = 0;

  // First compute the six base buckets from raw Shopify/Appstle rows.
  for (const combo of REGION_BUCKETS) {
    await pgRun(`
      DELETE FROM nobl_air_region_daily
      WHERE region_key = $1 AND date BETWEEN $2::date AND $3::date
    `, [combo.key, startDate, endDate]);

    const r = await pgRun(`
      INSERT INTO nobl_air_region_daily (
        region_key, country_codes, date,
        total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders, same_day_cancels,
        mature_count, converted_count, cancelled_30d_count,
        attach_rate, ttp_rate, activation_rate, cancel_rate_30d,
        tag_gross, tag_discounts, tag_net_sales, tag_refunds,
        sub_gross, sub_discounts, sub_net_sales, sub_refunds,
        rebill_revenue, new_sub_revenue,
        combined_gross, combined_net_sales, combined_net_revenue,
        new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
        rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159,
        computed_at
      )
      WITH o AS (
        SELECT *, (created_at AT TIME ZONE 'UTC')::date AS report_date
        FROM shopify_orders_raw
        WHERE brand = 'NOBL'
          AND (created_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
          AND (
            shipping_country = ANY($2::text[])
            OR ($5::boolean AND COALESCE(NULLIF(shipping_country, ''), '') = '')
          )
      ),
      daily_orders AS (
        SELECT
          report_date AS date,
          COUNT(*) FILTER (WHERE NOT is_rebill) AS total_orders,
          COUNT(*) FILTER (WHERE has_air AND has_luggage) AS air_orders,
          COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_paid_air) AS paid_air_orders,
          COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_zero_air) AS zero_air_orders,
          COUNT(*) FILTER (WHERE is_rebill) AS rebill_orders,
          COALESCE(SUM(tag_gross) FILTER (WHERE NOT is_rebill), 0) AS tag_gross,
          COALESCE(SUM(tag_discounts) FILTER (WHERE NOT is_rebill), 0) AS tag_discounts,
          COALESCE(SUM(tag_refunds) FILTER (WHERE NOT is_rebill), 0) AS tag_refunds,
          COALESCE(SUM(sub_gross) FILTER (WHERE NOT is_rebill), 0) AS sub_gross,
          COALESCE(SUM(sub_discounts) FILTER (WHERE NOT is_rebill), 0) AS sub_discounts,
          COALESCE(SUM(sub_refunds) FILTER (WHERE NOT is_rebill), 0) AS sub_refunds,
          COALESCE(SUM(total_price) FILTER (WHERE is_rebill), 0) AS rebill_revenue
        FROM o
        GROUP BY report_date
      ),
      new_tiers AS (
        SELECT o.report_date AS date, s.contract_amount, COUNT(*)::int AS n
        FROM o
        JOIN nobl_air_subscribers s ON s.order_name = o.order_name
        WHERE o.has_air AND o.has_luggage
        GROUP BY o.report_date, s.contract_amount
      ),
      rebill_tiers AS (
        SELECT o.report_date AS date, s.contract_amount, COUNT(*)::int AS n
        FROM o
        LEFT JOIN nobl_air_subscribers s ON
          s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
          OR s.customer_id = o.customer_id
        WHERE o.is_rebill
        GROUP BY o.report_date, s.contract_amount
      ),
      new_tiers_pivot AS (
        SELECT
          date,
          SUM(CASE WHEN ROUND(contract_amount) = 49 THEN n ELSE 0 END)::int AS new_49,
          SUM(CASE WHEN ROUND(contract_amount) = 79 THEN n ELSE 0 END)::int AS new_79,
          SUM(CASE WHEN ROUND(contract_amount) = 89 THEN n ELSE 0 END)::int AS new_89,
          SUM(CASE WHEN ROUND(contract_amount) = 99 THEN n ELSE 0 END)::int AS new_99,
          SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS new_109,
          SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS new_119,
          SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS new_129,
          SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS new_139,
          SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS new_149,
          SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS new_159
        FROM new_tiers
        GROUP BY date
      ),
      rebill_tiers_pivot AS (
        SELECT
          date,
          SUM(CASE WHEN ROUND(contract_amount) = 49 THEN n ELSE 0 END)::int AS rebill_49,
          SUM(CASE WHEN ROUND(contract_amount) = 79 THEN n ELSE 0 END)::int AS rebill_79,
          SUM(CASE WHEN ROUND(contract_amount) = 89 THEN n ELSE 0 END)::int AS rebill_89,
          SUM(CASE WHEN ROUND(contract_amount) = 99 THEN n ELSE 0 END)::int AS rebill_99,
          SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS rebill_109,
          SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS rebill_119,
          SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS rebill_129,
          SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS rebill_139,
          SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS rebill_149,
          SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS rebill_159
        FROM rebill_tiers
        GROUP BY date
      ),
      regional_subscribers AS (
        SELECT DISTINCT
          s.appstle_id,
          s.customer_id,
          s.created_at,
          s.cancelled_on,
          COALESCE(
            s.last_billing_date,
            (CASE
              WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'object'
                THEN (s.raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
              WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'string'
                THEN ((s.raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
              ELSE NULL
            END)
          ) AS paid_billing_date,
          s.is_same_day_cancel
        FROM nobl_air_subscribers s
        JOIN shopify_orders_raw so ON so.brand = 'NOBL'
          AND so.has_air
          AND so.has_luggage
          AND (
            so.shipping_country = ANY($2::text[])
            OR ($5::boolean AND COALESCE(NULLIF(so.shipping_country, ''), '') = '')
          )
          AND (
            so.order_name = s.order_name
            OR so.order_id = s.graph_order_id
            OR so.order_id = CONCAT('gid://shopify/Order/', s.graph_order_id)
            OR CONCAT('gid://shopify/Order/', so.order_id) = s.graph_order_id
          )
        WHERE (s.created_at AT TIME ZONE 'UTC')::date BETWEEN ($3::date - INTERVAL '14 days')::date AND $4::date
      ),
      regional_rebills AS (
        SELECT DISTINCT s.appstle_id
        FROM regional_subscribers s
        JOIN shopify_orders_raw o ON o.brand = 'NOBL'
          AND o.is_rebill
          AND (
            s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
            OR s.customer_id = o.customer_id
          )
        WHERE o.created_at > s.created_at
      ),
      same_day_cancel_cohorts AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS date, COUNT(*) FILTER (WHERE is_same_day_cancel)::int AS same_day_cancels
        FROM regional_subscribers
        WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
        GROUP BY (created_at AT TIME ZONE 'UTC')::date
      ),
      ttp_cohorts AS (
        SELECT
          (created_at AT TIME ZONE 'UTC')::date + 14 AS date,
          COUNT(*)::int AS mature_count,
          COUNT(*) FILTER (WHERE paid_billing_date > created_at OR rb.appstle_id IS NOT NULL)::int AS converted_count,
          COUNT(*) FILTER (WHERE cancelled_on IS NOT NULL AND cancelled_on <= created_at + INTERVAL '30 days')::int AS cancelled_30d_count
        FROM regional_subscribers
        LEFT JOIN regional_rebills rb USING (appstle_id)
        WHERE (created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $3::date AND $4::date
        GROUP BY (created_at AT TIME ZONE 'UTC')::date + 14
      ),
      lag_attach AS (
        SELECT
          d.date,
          CASE
            WHEN COUNT(*) FILTER (WHERE NOT so.is_rebill) > 0
              THEN ROUND(
                COUNT(*) FILTER (WHERE so.has_air AND so.has_luggage)::numeric
                / COUNT(*) FILTER (WHERE NOT so.is_rebill),
                4
              )
            ELSE NULL
          END AS attach_rate_14d_prior
        FROM daily_orders d
        LEFT JOIN shopify_orders_raw so ON so.brand = 'NOBL'
          AND (so.created_at AT TIME ZONE 'UTC')::date = (d.date - INTERVAL '14 days')::date
          AND (
            so.shipping_country = ANY($2::text[])
            OR ($5::boolean AND COALESCE(NULLIF(so.shipping_country, ''), '') = '')
          )
        GROUP BY d.date
      )
      SELECT
        $1 AS region_key,
        $2::text[] AS country_codes,
        d.date,
        d.total_orders,
        d.air_orders,
        d.paid_air_orders,
        d.zero_air_orders,
        d.rebill_orders,
        COALESCE(sc.same_day_cancels, 0) AS same_day_cancels,
        COALESCE(t.mature_count, 0) AS mature_count,
        COALESCE(t.converted_count, 0) AS converted_count,
        COALESCE(t.cancelled_30d_count, 0) AS cancelled_30d_count,
        CASE WHEN d.total_orders > 0 THEN ROUND(d.air_orders::numeric / d.total_orders, 4) ELSE NULL END AS attach_rate,
        CASE WHEN COALESCE(t.mature_count, 0) > 0 THEN ROUND(t.converted_count::numeric / t.mature_count, 4) ELSE NULL END AS ttp_rate,
        CASE WHEN la.attach_rate_14d_prior IS NOT NULL AND COALESCE(t.mature_count, 0) > 0
          THEN ROUND(la.attach_rate_14d_prior * (t.converted_count::numeric / NULLIF(t.mature_count, 0)), 4)
          ELSE NULL
        END AS activation_rate,
        CASE WHEN COALESCE(t.mature_count, 0) > 0 THEN ROUND(t.cancelled_30d_count::numeric / t.mature_count, 4) ELSE NULL END AS cancel_rate_30d,
        d.tag_gross,
        d.tag_discounts,
        (d.tag_gross - d.tag_discounts) AS tag_net_sales,
        d.tag_refunds,
        d.sub_gross,
        d.sub_discounts,
        (d.sub_gross - d.sub_discounts) AS sub_net_sales,
        d.sub_refunds,
        d.rebill_revenue,
        (d.sub_gross - d.sub_discounts) AS new_sub_revenue,
        (d.tag_gross + d.sub_gross + d.rebill_revenue) AS combined_gross,
        (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts + d.rebill_revenue) AS combined_net_sales,
        (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts - d.tag_refunds - d.sub_refunds + d.rebill_revenue) AS combined_net_revenue,
        COALESCE(np.new_49, 0) AS new_49,
        COALESCE(np.new_79, 0) AS new_79,
        COALESCE(np.new_89, 0) AS new_89,
        COALESCE(np.new_99, 0) AS new_99,
        COALESCE(np.new_109, 0) AS new_109,
        COALESCE(np.new_119, 0) AS new_119,
        COALESCE(np.new_129, 0) AS new_129,
        COALESCE(np.new_139, 0) AS new_139,
        COALESCE(np.new_149, 0) AS new_149,
        COALESCE(np.new_159, 0) AS new_159,
        COALESCE(rp.rebill_49, 0) AS rebill_49,
        COALESCE(rp.rebill_79, 0) AS rebill_79,
        COALESCE(rp.rebill_89, 0) AS rebill_89,
        COALESCE(rp.rebill_99, 0) AS rebill_99,
        COALESCE(rp.rebill_109, 0) AS rebill_109,
        COALESCE(rp.rebill_119, 0) AS rebill_119,
        COALESCE(rp.rebill_129, 0) AS rebill_129,
        COALESCE(rp.rebill_139, 0) AS rebill_139,
        COALESCE(rp.rebill_149, 0) AS rebill_149,
        COALESCE(rp.rebill_159, 0) AS rebill_159,
        NOW()
      FROM daily_orders d
      LEFT JOIN ttp_cohorts t ON t.date = d.date
      LEFT JOIN same_day_cancel_cohorts sc ON sc.date = d.date
      LEFT JOIN lag_attach la ON la.date = d.date
      LEFT JOIN new_tiers_pivot np ON np.date = d.date
      LEFT JOIN rebill_tiers_pivot rp ON rp.date = d.date
    `, [combo.key, combo.codes, startDate, endDate, combo.includeBlank]);
    totalRows += r.rowCount || 0;
  }

  // Then derive every multi-region combination by summing the base bucket rows.
  // This avoids re-running the expensive raw Shopify/subscriber joins 57 more times.
  for (const combo of REGION_COMBOS.filter(c => !REGION_BUCKETS.some(b => b.key === c.key))) {
    const parts = combo.key.split('_');
    await pgRun(`
      DELETE FROM nobl_air_region_daily
      WHERE region_key = $1 AND date BETWEEN $2::date AND $3::date
    `, [combo.key, startDate, endDate]);

    const r = await pgRun(`
      INSERT INTO nobl_air_region_daily (
        region_key, country_codes, date,
        total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders, same_day_cancels,
        mature_count, converted_count, cancelled_30d_count,
        attach_rate, ttp_rate, activation_rate, cancel_rate_30d,
        tag_gross, tag_discounts, tag_net_sales, tag_refunds,
        sub_gross, sub_discounts, sub_net_sales, sub_refunds,
        rebill_revenue, new_sub_revenue,
        combined_gross, combined_net_sales, combined_net_revenue,
        new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
        rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159,
        computed_at
      )
      WITH daily AS (
        SELECT
          date,
          SUM(total_orders)::int AS total_orders,
          SUM(air_orders)::int AS air_orders,
          SUM(paid_air_orders)::int AS paid_air_orders,
          SUM(zero_air_orders)::int AS zero_air_orders,
          SUM(rebill_orders)::int AS rebill_orders,
          SUM(same_day_cancels)::int AS same_day_cancels,
          SUM(mature_count)::int AS mature_count,
          SUM(converted_count)::int AS converted_count,
          SUM(cancelled_30d_count)::int AS cancelled_30d_count,
          SUM(tag_gross) AS tag_gross,
          SUM(tag_discounts) AS tag_discounts,
          SUM(tag_net_sales) AS tag_net_sales,
          SUM(tag_refunds) AS tag_refunds,
          SUM(sub_gross) AS sub_gross,
          SUM(sub_discounts) AS sub_discounts,
          SUM(sub_net_sales) AS sub_net_sales,
          SUM(sub_refunds) AS sub_refunds,
          SUM(rebill_revenue) AS rebill_revenue,
          SUM(new_sub_revenue) AS new_sub_revenue,
          SUM(combined_gross) AS combined_gross,
          SUM(combined_net_sales) AS combined_net_sales,
          SUM(combined_net_revenue) AS combined_net_revenue,
          SUM(new_49)::int AS new_49,
          SUM(new_79)::int AS new_79,
          SUM(new_89)::int AS new_89,
          SUM(new_99)::int AS new_99,
          SUM(new_109)::int AS new_109,
          SUM(new_119)::int AS new_119,
          SUM(new_129)::int AS new_129,
          SUM(new_139)::int AS new_139,
          SUM(new_149)::int AS new_149,
          SUM(new_159)::int AS new_159,
          SUM(rebill_49)::int AS rebill_49,
          SUM(rebill_79)::int AS rebill_79,
          SUM(rebill_89)::int AS rebill_89,
          SUM(rebill_99)::int AS rebill_99,
          SUM(rebill_109)::int AS rebill_109,
          SUM(rebill_119)::int AS rebill_119,
          SUM(rebill_129)::int AS rebill_129,
          SUM(rebill_139)::int AS rebill_139,
          SUM(rebill_149)::int AS rebill_149,
          SUM(rebill_159)::int AS rebill_159
        FROM nobl_air_region_daily
        WHERE region_key = ANY($3::text[])
          AND date BETWEEN ($4::date - INTERVAL '14 days')::date AND $5::date
        GROUP BY date
      )
      SELECT
        $1 AS region_key,
        $2::text[] AS country_codes,
        d.date,
        d.total_orders,
        d.air_orders,
        d.paid_air_orders,
        d.zero_air_orders,
        d.rebill_orders,
        d.same_day_cancels,
        d.mature_count,
        d.converted_count,
        d.cancelled_30d_count,
        CASE WHEN d.total_orders > 0 THEN ROUND(d.air_orders::numeric / d.total_orders, 4) ELSE NULL END,
        CASE WHEN d.mature_count > 0 THEN ROUND(d.converted_count::numeric / d.mature_count, 4) ELSE NULL END,
        CASE WHEN p.total_orders > 0 AND d.mature_count > 0
          THEN ROUND((p.air_orders::numeric / p.total_orders) * (d.converted_count::numeric / d.mature_count), 4)
          ELSE NULL
        END,
        CASE WHEN d.mature_count > 0 THEN ROUND(d.cancelled_30d_count::numeric / d.mature_count, 4) ELSE NULL END,
        d.tag_gross,
        d.tag_discounts,
        d.tag_net_sales,
        d.tag_refunds,
        d.sub_gross,
        d.sub_discounts,
        d.sub_net_sales,
        d.sub_refunds,
        d.rebill_revenue,
        d.new_sub_revenue,
        d.combined_gross,
        d.combined_net_sales,
        d.combined_net_revenue,
        d.new_49,
        d.new_79,
        d.new_89,
        d.new_99,
        d.new_109,
        d.new_119,
        d.new_129,
        d.new_139,
        d.new_149,
        d.new_159,
        d.rebill_49,
        d.rebill_79,
        d.rebill_89,
        d.rebill_99,
        d.rebill_109,
        d.rebill_119,
        d.rebill_129,
        d.rebill_139,
        d.rebill_149,
        d.rebill_159,
        NOW()
      FROM daily d
      LEFT JOIN daily p ON p.date = (d.date - INTERVAL '14 days')::date
      WHERE d.date BETWEEN $4::date AND $5::date
    `, [combo.key, combo.codes, parts, startDate, endDate]);
    totalRows += r.rowCount || 0;
  }

  return { rows: totalRows };
}

/**
 * Aggregate Shopify line items into shopify_product_daily for a brand+date range.
 */
async function aggregateProductDaily(brand, startDate, endDate) {
  // Wipe and rebuild the affected dates for this brand
  await pgRun(`
    DELETE FROM shopify_product_daily
    WHERE brand=$1 AND date BETWEEN $2::date AND $3::date`,
    [brand, startDate, endDate]);

  // Group by (brand, date, product_title) to match the UNIQUE constraint;
  // pick a representative sku_prefix via MIN.
  const insert = `
    INSERT INTO shopify_product_daily
      (brand, date, product_title, sku_prefix, units_sold, order_count, gross_revenue, discounts, net_revenue)
    SELECT
      o.brand,
      o.date_key AS date,
      COALESCE(NULLIF(li ->> 'title', ''), '(unknown)') AS product_title,
      MIN(UPPER(SPLIT_PART(COALESCE(li ->> 'sku', ''), '-', 1))) AS sku_prefix,
      SUM(COALESCE((li ->> 'quantity')::int, 0))::int AS units_sold,
      COUNT(DISTINCT o.order_id)::int AS order_count,
      SUM(
        COALESCE((li -> 'originalUnitPriceSet' -> 'shopMoney' ->> 'amount')::numeric, 0)
        * COALESCE((li ->> 'quantity')::int, 0)
      )::numeric(14,2) AS gross_revenue,
      SUM(COALESCE((li -> 'totalDiscountSet' -> 'shopMoney' ->> 'amount')::numeric, 0))::numeric(14,2) AS discounts,
      SUM(
        COALESCE((li -> 'discountedUnitPriceSet' -> 'shopMoney' ->> 'amount')::numeric, 0)
        * COALESCE((li ->> 'quantity')::int, 0)
      )::numeric(14,2) AS net_revenue
    FROM shopify_orders_raw o,
         jsonb_array_elements(o.line_items) li
    WHERE o.brand=$1 AND o.date_key BETWEEN $2::date AND $3::date
    GROUP BY o.brand, o.date_key, COALESCE(NULLIF(li ->> 'title', ''), '(unknown)')
  `;
  const r = await pgRun(insert, [brand, startDate, endDate]);
  return { rows: r.rowCount };
}

module.exports = { aggregateNoblAir, aggregateNoblAirRegionalCombos, aggregateProductDaily, ensureNoblAirRegionDailyTable };
