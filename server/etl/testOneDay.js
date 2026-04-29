require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { refreshSummary } = require('./tripleWhale');

async function main() {
  console.log('Testing refreshSummary for NOBL Apr 28...');
  const result = await refreshSummary('NOBL', '2026-04-28', '2026-04-28');
  console.log('Result:', JSON.stringify(result, null, 2));

  // Check what was written to DB
  const { pgQuery } = require('../db/postgres');
  const r = await pgQuery(`
    SELECT date,
      total_revenue, order_revenue, shopify_revenue, amazon_revenue,
      total_sales, refund_amount, total_spend, total_orders
    FROM tw_summary_daily
    WHERE brand='NOBL' AND date='2026-04-28'
  `, []);
  console.log('\nDB row for NOBL Apr 28:');
  console.log(JSON.stringify(r.rows[0], null, 2));

  const ch = await pgQuery(`
    SELECT channel, spend_1d, revenue_1d, purchases_1d, roas_1d
    FROM tw_channel_daily
    WHERE brand='NOBL' AND date='2026-04-28'
    ORDER BY spend_1d DESC
  `, []);
  console.log('\nChannel rows for NOBL Apr 28:');
  console.log(JSON.stringify(ch.rows, null, 2));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
