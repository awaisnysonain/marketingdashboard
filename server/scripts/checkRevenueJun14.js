/**
 * Verify dual revenue metrics for NOBL 2026-06-14 against acceptance targets.
 * Usage: node server/scripts/checkRevenueJun14.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery, pgRun } = require('../db/postgres');
const { refreshBrand } = require('../etl/tripleWhaleSQL');

const DATE = '2026-06-14';
const BRAND = 'NOBL';
const TARGET_GMD = 783732.88;
const TARGET_ORD = 843047;
const TOLERANCE = 1;

async function main() {
  await pgRun(`
    ALTER TABLE tw_summary_daily
      ADD COLUMN IF NOT EXISTS gross_minus_discounts NUMERIC(14,4) DEFAULT 0
  `);

  console.log(`\nRefreshing ${BRAND} ${DATE}…`);
  await refreshBrand(BRAND, DATE, DATE);

  const r = await pgQuery(`
    SELECT gross_minus_discounts::float AS gmd,
           order_revenue::float AS ord,
           total_revenue::float AS total_rev,
           total_spend::float AS spend,
           mer::float AS mer_stored
    FROM tw_summary_daily
    WHERE brand = $1 AND date = $2::date`, [BRAND, DATE]);

  const row = r.rows[0];
  if (!row) {
    console.error('NO ROW in tw_summary_daily');
    process.exit(1);
  }

  const gmdDelta = row.gmd - TARGET_GMD;
  const ordDelta = row.ord - TARGET_ORD;
  const merCalc = row.spend > 0 ? row.ord / row.spend : 0;

  console.log('\n=== NOBL 2026-06-14 REVENUE VALIDATION ===');
  console.log('Gross − Discounts:  ', row.gmd?.toFixed(2), `(target ${TARGET_GMD}, delta ${gmdDelta.toFixed(2)})`);
  console.log('Order Revenue:      ', row.ord?.toFixed(2), `(target ${TARGET_ORD}, delta ${ordDelta.toFixed(2)})`);
  console.log('Total spend:        ', row.spend?.toFixed(2));
  console.log('MER (ord/spend):    ', merCalc.toFixed(4));

  const gmdOk = Math.abs(gmdDelta) <= TOLERANCE;
  const ordOk = Math.abs(ordDelta) <= TOLERANCE;
  console.log('\nGMD within ±$1:', gmdOk ? 'PASS' : 'FAIL');
  console.log('Order Rev within ±$1:', ordOk ? 'PASS' : 'FAIL');

  process.exit(gmdOk && ordOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
