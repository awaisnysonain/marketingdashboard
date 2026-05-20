/**
 * Pre-compute mature-as-of-end TTP cohort metrics (one row per calendar day).
 * Avoids scanning all subscribers + rebills on every dashboard page load.
 */
const { pgQuery, pgRun } = require('../db/postgres');

const TTP_ASOF_SQL = `
  WITH subscribers AS (
    SELECT
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
      ) AS paid_billing_date
    FROM nobl_air_subscribers s
    WHERE (s.created_at AT TIME ZONE 'UTC')::date <= ($1::date - INTERVAL '14 days')::date
  ), subscriber_rebills AS (
    SELECT DISTINCT s.appstle_id
    FROM subscribers s
    JOIN shopify_orders_raw o ON o.brand = 'NOBL'
      AND o.is_rebill
      AND (
        s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
        OR s.customer_id = o.customer_id
      )
    WHERE o.created_at > s.created_at
  )
  SELECT
    COUNT(*)::int AS mature,
    COUNT(*) FILTER (WHERE s.paid_billing_date > s.created_at OR rb.appstle_id IS NOT NULL)::int AS converted,
    COUNT(*) FILTER (WHERE
      s.cancelled_on IS NOT NULL
      AND s.cancelled_on <= s.created_at + INTERVAL '30 days'
    )::int AS cancelled_30d
  FROM subscribers s
  LEFT JOIN subscriber_rebills rb ON rb.appstle_id = s.appstle_id
`;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRange(startDate, endDate) {
  const out = [];
  let cur = startDate;
  while (cur <= endDate) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

async function ensureNoblAirTtpSnapshotTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS nobl_air_ttp_snapshot (
      as_of_date DATE PRIMARY KEY,
      mature INT NOT NULL DEFAULT 0,
      converted INT NOT NULL DEFAULT 0,
      cancelled_30d INT NOT NULL DEFAULT 0,
      ttp_rate NUMERIC(8,4),
      cancel_rate_30d NUMERIC(8,4),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_nobl_air_ttp_snapshot_date ON nobl_air_ttp_snapshot (as_of_date DESC)`);
}

async function upsertTtpSnapshotForDate(asOfDate) {
  const r = await pgQuery(TTP_ASOF_SQL, [asOfDate]);
  const row = r.rows[0] || {};
  const mature = Number(row.mature || 0);
  const converted = Number(row.converted || 0);
  const cancelled30d = Number(row.cancelled_30d || 0);
  const ttpRate = mature > 0 ? Number((converted / mature).toFixed(4)) : null;
  const cancelRate30d = mature > 0 ? Number((cancelled30d / mature).toFixed(4)) : null;
  await pgRun(`
    INSERT INTO nobl_air_ttp_snapshot (as_of_date, mature, converted, cancelled_30d, ttp_rate, cancel_rate_30d, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (as_of_date) DO UPDATE SET
      mature = EXCLUDED.mature,
      converted = EXCLUDED.converted,
      cancelled_30d = EXCLUDED.cancelled_30d,
      ttp_rate = EXCLUDED.ttp_rate,
      cancel_rate_30d = EXCLUDED.cancel_rate_30d,
      updated_at = NOW()
  `, [asOfDate, mature, converted, cancelled30d, ttpRate, cancelRate30d]);
  return { as_of_date: asOfDate, mature, converted, cancelled_30d: cancelled30d, ttp_rate: ttpRate, cancel_rate_30d: cancelRate30d };
}

async function refreshNoblAirTtpSnapshots(startDate, endDate) {
  await ensureNoblAirTtpSnapshotTable();
  const dates = dateRange(startDate, endDate);
  for (const d of dates) {
    await upsertTtpSnapshotForDate(d);
  }
  return { rows: dates.length };
}

module.exports = {
  ensureNoblAirTtpSnapshotTable,
  refreshNoblAirTtpSnapshots,
  upsertTtpSnapshotForDate,
};
