require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');
const d = '2026-06-14';

async function main() {
  const rows = await twSqlQuery('NOBL', `
    SELECT ot.platform,
      COALESCE(SUM(ot.gross_product_sales),0) g,
      COALESCE(SUM(ot.discount_amount),0) d,
      COALESCE(SUM(ot.taxes),0) t,
      COALESCE(SUM(ot.shipping_price),0) s,
      COALESCE(SUM(ot.handling_fees),0) hf,
      COALESCE(SUM(ot.order_revenue),0) ord,
      COALESCE(SUM(ot.gross_sales),0) gs
    FROM orders_table ot
    WHERE ot.event_date=DATE '${d}'
      AND (ot.platform='shopify' OR (ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'))
    GROUP BY ot.platform`, { period: { startDate: d, endDate: d } });
  console.log(rows);

  const shop = rows.find(r => r.platform === 'shopify') || {};
  const amz = rows.find(r => r.platform === 'amazon') || {};
  const g = Number, hf = g(shop.hf) + g(amz.hf);
  console.log('\nTotal handling_fees:', hf);

  // Unified formulas
  const gmdAll = g(shop.g)-g(shop.d) + g(amz.g)-g(amz.d);
  const ordAll = g(shop.ord) + g(amz.g)+g(amz.t)-g(amz.d)-520.15;
  const gmdTarget = g(shop.g)-g(shop.d) + g(amz.g)-g(amz.d)-168;
  console.log('\nComputed vs targets:');
  console.log(' gmd all g-d:', gmdAll, 'target 783732.88');
  console.log(' gmd shop + amz(g-d-168):', gmdTarget);
  console.log(' ord shop+amz(g+t-d-520.15):', ordAll, 'target 843047');

  // Maybe 168 = amz (g - gs) = gross_product - gross_sales for amazon
  console.log('\namz g-gs:', g(amz.g)-g(amz.gs));
  console.log('gmd if subtract amz(g-gs):', gmdAll - (g(amz.g)-g(amz.gs)));

  // ord if shop ord + amz gs + amz t
  console.log('ord shop+amz gs+t:', g(shop.ord)+g(amz.gs)+g(amz.t));
}

main().catch(console.error);
