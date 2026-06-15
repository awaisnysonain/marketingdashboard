require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');
const d = '2026-06-14';

async function main() {
  const row = await twSqlQuery('NOBL', `
    SELECT * FROM blended_stats_tvf(include_amazon=TRUE) bst WHERE bst.event_date='${d}' LIMIT 1`,
    { period: { startDate: d, endDate: d } });
  const b = row[0] || {};
  const amz = await twSqlQuery('NOBL', `
    SELECT COALESCE(SUM(gross_product_sales),0) g, COALESCE(SUM(discount_amount),0) d,
           COALESCE(SUM(taxes),0) t, COALESCE(SUM(shipping_price),0) s,
           COALESCE(SUM(order_revenue),0) ord
    FROM orders_table WHERE platform='amazon' AND amazon_fulfillment_status!='Canceled'
      AND event_date=DATE '${d}'`, { period: { startDate: d, endDate: d } });
  const a = amz[0];
  console.log('Amazon orders:', a);
  console.log('Blended amazon fields:', {
    total_amazon_product_item_price: b.total_amazon_product_item_price,
    amazon_handling_fees: b.amazon_handling_fees,
    amazon_spend: b.amazon_spend,
  });

  const shopGmd = 770404.21;
  const targetGmd = 783732.88;
  const targetOrd = 843047;
  const shopOrd = 829713.47;
  console.log('\nRequired amazon gmd contrib:', targetGmd - shopGmd);
  console.log('Required amazon ord contrib:', targetOrd - shopOrd);

  // Try amazon gross - discount - handling
  const amzGmd1 = a.g - a.d - Number(b.amazon_handling_fees || 0);
  const amzOrd1 = a.g - a.d + a.t - Number(b.amazon_handling_fees || 0);
  console.log('\nWith amazon_handling_fees:', b.amazon_handling_fees);
  console.log('  gmd total:', shopGmd + amzGmd1);
  console.log('  ord total:', shopOrd + amzOrd1);

  const amzGmd2 = a.g - a.d - Number(b.total_amazon_product_item_price || 0);
  console.log('\nWith total_amazon_product_item_price subtract:', shopGmd + amzGmd2);
}

main().catch(console.error);
