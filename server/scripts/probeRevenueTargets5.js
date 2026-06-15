require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');
const d = '2026-06-14';

async function tryField(f) {
  try {
    const rows = await twSqlQuery('NOBL', `
      SELECT COALESCE(SUM(ot.${f}), 0) AS v FROM orders_table ot
      WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'
        AND ot.event_date=DATE '${d}'`, { period: { startDate: d, endDate: d } });
    return rows[0].v;
  } catch { return null; }
}

async function main() {
  const fields = [
    'gross_product_sales','discount_amount','order_revenue','gross_sales','taxes','shipping_price',
    'product_quantity_sold_in_order','handling_fees','amazon_handling_fees','cogs','total_price',
  ];
  for (const f of fields) {
    const v = await tryField(f);
    if (v != null) console.log(f, v);
  }

  // Try shopify+amazon split matching targets
  const shop = await twSqlQuery('NOBL', `
    SELECT COALESCE(SUM(gross_product_sales-discount_amount),0) gmd,
           COALESCE(SUM(order_revenue),0) ord
    FROM orders_table WHERE platform='shopify' AND event_date=DATE '${d}'`,
    { period: { startDate: d, endDate: d } });

  console.log('\nShop:', shop[0]);
  console.log('Target amz gmd:', 783732.88 - shop[0].gmd);
  console.log('Target amz ord:', 843047 - shop[0].ord);

  // Maybe amazon uses gross_product_sales - discount_amount - taxes for gmd?
  const amzG = 13542.593203175, amzD = 45.925357295, amzT = 357.01, amzO = 5343.001874505;
  console.log('\nAmazon formula tries:');
  console.log(' g-d:', amzG - amzD);
  console.log(' g-d-t:', amzG - amzD - amzT);
  console.log(' g-d-t+168:', amzG - amzD - amzT + 168);
  console.log(' ord+t-520:', amzO + amzT - 520.15);
  console.log(' g-d-168:', amzG - amzD - 168);
  console.log(' g+t-d-520:', amzG + amzT - amzD - 520.15);
}

main().catch(console.error);
