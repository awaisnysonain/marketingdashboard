require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery, testTwSql } = require('./twSqlApi');

async function main() {
  console.log('=== TW SQL API Test ===');
  console.log('NOBL shop:', process.env.NOBL_TW_SHOP_ID);
  console.log('TW SQL URL:', process.env.TW_SQL_URL || 'https://api.triplewhale.com/api/v2/willy/run-query');
  console.log('API key set:', !!process.env.NOBL_TW_API_KEY);

  // Test 1: Basic ping
  console.log('\n--- Test 1: Basic ping ---');
  const ping = await testTwSql('NOBL');
  console.log('Result:', JSON.stringify(ping));

  // Test 2: Simple orders_table query
  console.log('\n--- Test 2: orders_table ---');
  try {
    const rows = await twSqlQuery('NOBL', `
      SELECT order_date, COUNT(*) as cnt, SUM(total_price) as revenue
      FROM orders_table
      WHERE order_date >= toDate('2026-04-28') AND order_date < toDate('2026-04-30')
      GROUP BY order_date
      ORDER BY order_date
    `);
    console.log('orders_table rows:', JSON.stringify(rows));
  } catch (e) {
    console.error('orders_table FAILED:', e.message);
  }

  // Test 3: blended_stats_tvf with positional dates
  console.log('\n--- Test 3: blended_stats_tvf(start, end) ---');
  try {
    const rows = await twSqlQuery('NOBL', `
      SELECT *
      FROM blended_stats_tvf('2026-04-28', '2026-04-28')
      LIMIT 3
    `);
    console.log('blended_stats_tvf positional rows:', JSON.stringify(rows));
  } catch (e) {
    console.error('blended_stats_tvf positional FAILED:', e.message);
  }

  // Test 4: blended_stats_tvf with named include_amazon
  console.log('\n--- Test 4: blended_stats_tvf(include_amazon=TRUE) ---');
  try {
    const rows = await twSqlQuery('NOBL', `
      SELECT bst.event_date, SUM(bst.order_revenue) as rev, SUM(bst.spend) as spend
      FROM blended_stats_tvf(include_amazon=TRUE) AS bst
      WHERE bst.event_date >= '2026-04-28' AND bst.event_date <= '2026-04-28'
      GROUP BY bst.event_date
    `);
    console.log('blended_stats_tvf named rows:', JSON.stringify(rows));
  } catch (e) {
    console.error('blended_stats_tvf named FAILED:', e.message);
  }

  // Test 5: refunds_table
  console.log('\n--- Test 5: refunds_table ---');
  try {
    const rows = await twSqlQuery('NOBL', `
      SELECT refund_date, COUNT(*) as cnt, SUM(refund_amount) as amount
      FROM refunds_table
      WHERE refund_date >= toDate('2026-04-01') AND refund_date < toDate('2026-04-29')
      GROUP BY refund_date
      ORDER BY refund_date DESC
      LIMIT 5
    `);
    console.log('refunds_table rows:', JSON.stringify(rows));
  } catch (e) {
    console.error('refunds_table FAILED:', e.message);
  }
}

main().catch(console.error);
