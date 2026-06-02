require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { fetchFloProductDaily } = require('../etl/tripleWhaleSQL');

(async () => {
  const rows = await fetchFloProductDaily('FLO', '2026-05-01', '2026-05-31');
  const agg = {};
  for (const r of rows) {
    const pl = r.product_line;
    if (!agg[pl]) agg[pl] = { spend: 0, revenue: 0, units: 0 };
    agg[pl].spend += Number(r.spend || 0);
    agg[pl].revenue += Number(r.revenue || 0);
    agg[pl].units += Number(r.new_customer_orders || 0);
  }
  console.log('Live TW fetchFloProductDaily May 2026:');
  for (const [pl, v] of Object.entries(agg).sort()) {
    console.log(`  ${pl}: spend=${v.spend.toFixed(2)} rev=${v.revenue.toFixed(2)} units=${v.units}`);
  }
  const totalSpend = Object.values(agg).reduce((s, v) => s + v.spend, 0);
  console.log(`  TOTAL spend: ${totalSpend.toFixed(2)} (${rows.length} daily rows)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
