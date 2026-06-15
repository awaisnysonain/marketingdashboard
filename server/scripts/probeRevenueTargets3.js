require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');

const d = '2026-06-14';

async function q(label, sql) {
  try {
    const rows = await twSqlQuery('NOBL', sql, { period: { startDate: d, endDate: d } });
    console.log(`${label}:`, rows[0]);
    return rows[0];
  } catch (e) {
    console.log(`${label}: FAIL`, e.message.slice(0, 100));
    return null;
  }
}

async function main() {
  // order_date vs event_date
  await q('event_date gmd', `
    SELECT COALESCE(SUM(ot.gross_product_sales - ot.discount_amount),0) gmd,
           COALESCE(SUM(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount),0) ord
    FROM orders_table ot WHERE ot.event_date=DATE '${d}'
      AND (ot.platform='shopify' OR (ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'))`);

  await q('order_date gmd', `
    SELECT COALESCE(SUM(ot.gross_product_sales - ot.discount_amount),0) gmd,
           COALESCE(SUM(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount),0) ord
    FROM orders_table ot WHERE ot.order_date=DATE '${d}'
      AND (ot.platform='shopify' OR (ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'))`);

  // shopify bst gmd + amazon order_revenue for order rev?
  await q('shop gmd bst + amz order_rev', `
    SELECT
      (SELECT COALESCE(SUM(bst.gross_product_sales-bst.discounts),0) FROM blended_stats_tvf(include_amazon=FALSE) bst WHERE bst.event_date='${d}') +
      (SELECT COALESCE(SUM(ot.order_revenue),0) FROM orders_table ot WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled' AND ot.event_date=DATE '${d}') AS ord_rev`);

  // shop order_rev + amz gross_product-discount for gmd components
  const shop = await q('shop only components', `
    SELECT COALESCE(SUM(ot.gross_product_sales),0) g, COALESCE(SUM(ot.discount_amount),0) d,
           COALESCE(SUM(ot.order_revenue),0) ord
    FROM orders_table ot WHERE ot.platform='shopify' AND ot.event_date=DATE '${d}'`);

  const amz = await q('amz components', `
    SELECT COALESCE(SUM(ot.gross_product_sales),0) g, COALESCE(SUM(ot.discount_amount),0) d,
           COALESCE(SUM(ot.order_revenue),0) ord, COALESCE(SUM(ot.gross_sales),0) gs
    FROM orders_table ot WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled' AND ot.event_date=DATE '${d}'`);

  if (shop && amz) {
    console.log('\nManual combos:');
    console.log('  gmd shop+amz g-d:', shop.g - shop.d + amz.g - amz.d);
    console.log('  gmd shop+amz g only amz:', shop.g - shop.d + amz.g);
    console.log('  ord shop ord + amz ord:', shop.ord + amz.ord);
    console.log('  ord shop ord + amz g-d+s+t:', shop.ord + amz.g - amz.d + 357.01);
    console.log('  ord bst shop + amz gs:', 829713.47 + amz.gs);
  }

  // Summary API skipped — use SQL only

  console.log('\nTargets: gmd=783732.88 ord=843047');
}

main().catch(console.error);
