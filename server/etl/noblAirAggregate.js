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
 *   - TTP rate       = mature converted / mature (cohort over the date range)
 *   - same-day cancels = sub orders cancelled within 24h
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pgQuery } = require('../db/postgres');

/**
 * Aggregate NOBL Air metrics for a date range and upsert nobl_air_daily.
 * @param {string} startDate YYYY-MM-DD inclusive
 * @param {string} endDate   YYYY-MM-DD inclusive
 */
async function aggregateNoblAir(startDate, endDate) {
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
    -- TTP cohort metrics: for subs created on date X, what fraction matured & converted by today?
    ttp_cohorts AS (
      SELECT
        DATE(s.created_at) AS date,
        SUM(CASE WHEN s.is_mature THEN 1 ELSE 0 END)::int                        AS mature_count,
        SUM(CASE WHEN s.is_mature AND s.is_converted THEN 1 ELSE 0 END)::int     AS converted_count,
        SUM(CASE WHEN s.is_same_day_cancel THEN 1 ELSE 0 END)::int               AS same_day_cancels
      FROM nobl_air_subscribers s
      WHERE DATE(s.created_at) BETWEEN $1::date AND $2::date
      GROUP BY DATE(s.created_at)
    )
    SELECT
      d.date,
      d.total_orders, d.air_orders, d.paid_air_orders, d.zero_air_orders, d.rebill_orders,
      COALESCE(t.same_day_cancels, 0) AS same_day_cancels,
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
        WHEN d.air_orders > 0
          THEN ROUND(d.paid_air_orders::numeric / d.air_orders, 4)
        ELSE NULL
      END AS ttp_rate,
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
    LEFT JOIN new_tiers_pivot    np ON np.date = d.date
    LEFT JOIN rebill_tiers_pivot rp ON rp.date = d.date
    ORDER BY d.date`;
  const r = await pgQuery(sql, [startDate, endDate]);
  let written = 0;
  for (const row of r.rows) {
    const activation = (row.attach_rate != null && row.ttp_rate != null)
      ? Math.round(parseFloat(row.attach_rate) * parseFloat(row.ttp_rate) * 10000) / 10000
      : null;
    await pgRun(`
      INSERT INTO nobl_air_daily (
        date,
        total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders, same_day_cancels,
        attach_rate, ttp_rate, activation_rate,
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
        $19,$20,
        $21,$22,$23,
        $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,
        $34,$35,$36,$37,$38,$39,$40,$41,$42,$43,
        NOW()
      )
      ON CONFLICT (date) DO UPDATE SET
        total_orders=EXCLUDED.total_orders, air_orders=EXCLUDED.air_orders,
        paid_air_orders=EXCLUDED.paid_air_orders, zero_air_orders=EXCLUDED.zero_air_orders,
        rebill_orders=EXCLUDED.rebill_orders, same_day_cancels=EXCLUDED.same_day_cancels,
        attach_rate=EXCLUDED.attach_rate, ttp_rate=EXCLUDED.ttp_rate, activation_rate=EXCLUDED.activation_rate,
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
      row.tag_gross, row.tag_discounts, row.tag_net_sales, row.tag_refunds,
      row.sub_gross, row.sub_discounts, row.sub_net_sales, row.sub_refunds,
      row.rebill_revenue, row.new_sub_revenue,
      row.combined_gross, row.combined_net_sales, row.combined_net_revenue,
      row.new_49, row.new_79, row.new_89, row.new_99, row.new_109, row.new_119, row.new_129, row.new_139, row.new_149, row.new_159,
      row.rebill_49, row.rebill_79, row.rebill_89, row.rebill_99, row.rebill_109, row.rebill_119, row.rebill_129, row.rebill_139, row.rebill_149, row.rebill_159,
    ]);
    written++;
  }
  return { rows: written };
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

module.exports = { aggregateNoblAir, aggregateProductDaily };
