/**
 * Pre-aggregate NOBL Air × Meta ad metrics by day + ad for fast dashboard reads.
 * Populated after tw_air_order_attribution sync (see syncEngine).
 */
const { pgQuery, pgRun } = require('../db/postgres');

const DAILY_AGG_SQL = `
  WITH attr AS (
    SELECT *
    FROM tw_air_order_attribution
    WHERE brand = 'NOBL'
      AND channel = 'facebook-ads'
      AND model = 'Triple Attribution'
      AND attribution_window = '1_day'
      AND COALESCE(ad_id, '') <> ''
      AND date BETWEEN $1::date AND $2::date
  ), cohort_attr AS (
    SELECT
      a.*,
      s.appstle_id,
      s.customer_id,
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
      s.created_at AS subscriber_created_at
    FROM attr a
    JOIN LATERAL (
      SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
      FROM nobl_air_subscribers
      WHERE order_name = a.order_name
      UNION
      SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
      FROM nobl_air_subscribers
      WHERE graph_order_id = CONCAT('gid://shopify/Order/', a.order_id)
      UNION
      SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
      FROM nobl_air_subscribers
      WHERE graph_order_id = a.order_id
    ) s ON true
    WHERE (s.created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $1::date AND $2::date
  ), air AS (
    SELECT
      a.date,
      a.campaign_id, a.campaign_name, a.adset_id, a.adset_name, a.ad_id, a.ad_name,
      COUNT(DISTINCT a.order_id)::int AS air_orders,
      SUM(a.linear_weight)::numeric(14,2) AS attributed_air_orders,
      SUM(a.order_revenue * a.linear_weight)::numeric(14,2) AS attributed_air_revenue
    FROM attr a
    GROUP BY a.date, a.campaign_id, a.campaign_name, a.adset_id, a.adset_name, a.ad_id, a.ad_name
  ), cohort AS (
    SELECT
      ca.date,
      ca.campaign_id, ca.campaign_name, ca.adset_id, ca.adset_name, ca.ad_id, ca.ad_name,
      SUM(ca.linear_weight)::numeric(14,2) AS ttp_mature_air_orders,
      SUM(ca.linear_weight) FILTER (WHERE ca.paid_billing_date > ca.subscriber_created_at OR EXISTS (
        SELECT 1
        FROM shopify_orders_raw o
        WHERE o.brand = 'NOBL'
          AND o.is_rebill
          AND (
            ca.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
            OR ca.customer_id = o.customer_id
          )
          AND o.created_at > ca.subscriber_created_at
      ))::numeric(14,2) AS ttp_paid_air_orders,
      COUNT(DISTINCT ca.appstle_id)::int AS ttp_mature_subscribers,
      COUNT(DISTINCT ca.appstle_id) FILTER (WHERE ca.paid_billing_date > ca.subscriber_created_at OR EXISTS (
        SELECT 1
        FROM shopify_orders_raw o
        WHERE o.brand = 'NOBL'
          AND o.is_rebill
          AND (
            ca.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
            OR ca.customer_id = o.customer_id
          )
          AND o.created_at > ca.subscriber_created_at
      ))::int AS ttp_paid_subscribers
    FROM cohort_attr ca
    GROUP BY ca.date, ca.campaign_id, ca.campaign_name, ca.adset_id, ca.adset_name, ca.ad_id, ca.ad_name
  ), ads AS (
    SELECT
      date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
      SUM(spend)::numeric(14,2) AS spend,
      SUM(revenue)::numeric(14,2) AS day_1_revenue,
      SUM(purchases)::numeric(14,2) AS purchases
    FROM tw_ads_daily
    WHERE brand = 'NOBL'
      AND platform = 'META'
      AND date BETWEEN $1::date AND $2::date
      AND COALESCE(ad_id, '') <> ''
    GROUP BY date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name
  )
  SELECT
    COALESCE(air.date, ads.date) AS date,
    COALESCE(air.campaign_id, ads.campaign_id, '') AS campaign_id,
    COALESCE(air.campaign_name, ads.campaign_name) AS campaign_name,
    COALESCE(air.adset_id, ads.adset_id, '') AS adset_id,
    COALESCE(air.adset_name, ads.adset_name) AS adset_name,
    COALESCE(air.ad_id, ads.ad_id, '') AS ad_id,
    COALESCE(air.ad_name, ads.ad_name) AS ad_name,
    COALESCE(ads.spend, 0) AS spend,
    COALESCE(ads.day_1_revenue, 0) AS day_1_revenue,
    COALESCE(ads.purchases, 0) AS purchases,
    COALESCE(air.air_orders, 0) AS air_orders,
    COALESCE(air.attributed_air_orders, 0) AS attributed_air_orders,
    COALESCE(air.attributed_air_revenue, 0) AS attributed_air_revenue,
    COALESCE(cohort.ttp_mature_air_orders, 0) AS ttp_mature_air_orders,
    COALESCE(cohort.ttp_paid_air_orders, 0) AS ttp_paid_air_orders,
    COALESCE(cohort.ttp_mature_subscribers, 0) AS ttp_mature_subscribers,
    COALESCE(cohort.ttp_paid_subscribers, 0) AS ttp_paid_subscribers
  FROM air
  FULL OUTER JOIN ads ON air.date = ads.date
    AND COALESCE(air.ad_id, '') = COALESCE(ads.ad_id, '')
    AND COALESCE(air.campaign_id, '') = COALESCE(ads.campaign_id, '')
    AND COALESCE(air.adset_id, '') = COALESCE(ads.adset_id, '')
  LEFT JOIN cohort ON COALESCE(air.date, ads.date) = cohort.date
    AND COALESCE(air.ad_id, ads.ad_id, '') = COALESCE(cohort.ad_id, '')
    AND COALESCE(air.campaign_id, ads.campaign_id, '') = COALESCE(cohort.campaign_id, '')
    AND COALESCE(air.adset_id, ads.adset_id, '') = COALESCE(cohort.adset_id, '')
`;

async function ensureNoblAirMetaAdDailyTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS nobl_air_meta_ad_daily (
      id BIGSERIAL PRIMARY KEY,
      brand TEXT NOT NULL DEFAULT 'NOBL',
      date DATE NOT NULL,
      campaign_id TEXT NOT NULL DEFAULT '',
      campaign_name TEXT,
      adset_id TEXT NOT NULL DEFAULT '',
      adset_name TEXT,
      ad_id TEXT NOT NULL DEFAULT '',
      ad_name TEXT,
      spend NUMERIC(14,2) DEFAULT 0,
      day_1_revenue NUMERIC(14,2) DEFAULT 0,
      purchases NUMERIC(14,2) DEFAULT 0,
      air_orders INT DEFAULT 0,
      attributed_air_orders NUMERIC(14,2) DEFAULT 0,
      attributed_air_revenue NUMERIC(14,2) DEFAULT 0,
      ttp_mature_air_orders NUMERIC(14,2) DEFAULT 0,
      ttp_paid_air_orders NUMERIC(14,2) DEFAULT 0,
      ttp_mature_subscribers INT DEFAULT 0,
      ttp_paid_subscribers INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (brand, date, ad_id)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_nobl_meta_ad_daily_date ON nobl_air_meta_ad_daily (brand, date DESC)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_nobl_meta_ad_daily_ad ON nobl_air_meta_ad_daily (brand, ad_id, date DESC)`);
}

async function refreshNoblAirMetaAdDaily(startDate, endDate) {
  await ensureNoblAirMetaAdDailyTable();
  await pgRun(`DELETE FROM nobl_air_meta_ad_daily WHERE brand = 'NOBL' AND date BETWEEN $1::date AND $2::date`, [startDate, endDate]);
  const rows = await pgQuery(DAILY_AGG_SQL, [startDate, endDate]);
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const slice = rows.rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of slice) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        'NOBL',
        row.date,
        row.campaign_id || '',
        row.campaign_name || null,
        row.adset_id || '',
        row.adset_name || null,
        row.ad_id || '',
        row.ad_name || null,
        row.spend || 0,
        row.day_1_revenue || 0,
        row.purchases || 0,
        row.air_orders || 0,
        row.attributed_air_orders || 0,
        row.attributed_air_revenue || 0,
        row.ttp_mature_air_orders || 0,
        row.ttp_paid_air_orders || 0,
        row.ttp_mature_subscribers || 0,
        row.ttp_paid_subscribers || 0,
      );
    }
    await pgRun(`
      INSERT INTO nobl_air_meta_ad_daily (
        brand, date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        spend, day_1_revenue, purchases,
        air_orders, attributed_air_orders, attributed_air_revenue,
        ttp_mature_air_orders, ttp_paid_air_orders, ttp_mature_subscribers, ttp_paid_subscribers
      ) VALUES ${values.join(',')}
      ON CONFLICT (brand, date, ad_id) DO UPDATE SET
        campaign_name = EXCLUDED.campaign_name,
        adset_name = EXCLUDED.adset_name,
        ad_name = EXCLUDED.ad_name,
        spend = EXCLUDED.spend,
        day_1_revenue = EXCLUDED.day_1_revenue,
        purchases = EXCLUDED.purchases,
        air_orders = EXCLUDED.air_orders,
        attributed_air_orders = EXCLUDED.attributed_air_orders,
        attributed_air_revenue = EXCLUDED.attributed_air_revenue,
        ttp_mature_air_orders = EXCLUDED.ttp_mature_air_orders,
        ttp_paid_air_orders = EXCLUDED.ttp_paid_air_orders,
        ttp_mature_subscribers = EXCLUDED.ttp_mature_subscribers,
        ttp_paid_subscribers = EXCLUDED.ttp_paid_subscribers,
        updated_at = NOW()
    `, params);
    written += slice.length;
  }
  return { rows: written };
}

module.exports = {
  ensureNoblAirMetaAdDailyTable,
  refreshNoblAirMetaAdDaily,
};
