require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');

const d = '2026-06-14';
const TARGET_GMD = 783732.88;
const TARGET_ORD = 843047;

async function q(label, sql) {
  try {
    const rows = await twSqlQuery('NOBL', sql, { period: { startDate: d, endDate: d } });
    const row = rows[0] || {};
    console.log(`\n${label}:`, row);
    return row;
  } catch (e) {
    console.log(`\n${label}: FAIL`, e.message.slice(0, 100));
    return null;
  }
}

async function main() {
  // blended_stats variants
  await q('bst include_amazon=TRUE sums', `
    SELECT
      COALESCE(SUM(bst.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(bst.gross_product_sales), 0) AS gross_product_sales,
      COALESCE(SUM(bst.gross_sales), 0) AS gross_sales,
      COALESCE(SUM(bst.discounts), 0) AS discounts,
      COALESCE(SUM(bst.shipping_price), 0) AS shipping,
      COALESCE(SUM(bst.taxes), 0) AS taxes,
      COALESCE(SUM(bst.gross_product_sales + bst.shipping_price + bst.taxes - bst.discounts), 0) AS formula
    FROM blended_stats_tvf(include_amazon=TRUE) bst WHERE bst.event_date = '${d}'`);

  await q('bst include_amazon=FALSE sums', `
    SELECT
      COALESCE(SUM(bst.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(bst.gross_product_sales), 0) AS gross_product_sales,
      COALESCE(SUM(bst.discounts), 0) AS discounts,
      COALESCE(SUM(bst.gross_product_sales - bst.discounts), 0) AS gmd
    FROM blended_stats_tvf(include_amazon=FALSE) bst WHERE bst.event_date = '${d}'`);

  // orders_table combined
  await q('orders_table all platforms', `
    SELECT
      COALESCE(SUM(ot.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(ot.gross_product_sales), 0) AS gross_product_sales,
      COALESCE(SUM(ot.discount_amount), 0) AS discount_amount,
      COALESCE(SUM(ot.gross_product_sales - ot.discount_amount), 0) AS gmd,
      COALESCE(SUM(ot.shipping_price), 0) AS shipping,
      COALESCE(SUM(ot.taxes), 0) AS taxes,
      COALESCE(SUM(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount), 0) AS formula
    FROM orders_table ot
    WHERE ot.event_date = DATE '${d}'
      AND (ot.platform = 'shopify' OR (ot.platform = 'amazon' AND ot.amazon_fulfillment_status != 'Canceled'))`);

  await q('orders_table shopify only', `
    SELECT
      COALESCE(SUM(ot.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(ot.gross_product_sales - ot.discount_amount), 0) AS gmd,
      COALESCE(SUM(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount), 0) AS formula
    FROM orders_table ot WHERE ot.platform = 'shopify' AND ot.event_date = DATE '${d}'`);

  await q('orders_table amazon only', `
    SELECT
      COALESCE(SUM(ot.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(ot.gross_product_sales - ot.discount_amount), 0) AS gmd
    FROM orders_table ot
    WHERE ot.platform = 'amazon' AND ot.amazon_fulfillment_status != 'Canceled'
      AND ot.event_date = DATE '${d}'`);

  console.log('\n=== TARGETS ===');
  console.log('Gross-Discounts target:', TARGET_GMD);
  console.log('Order Revenue target:', TARGET_ORD);
}

main().catch(console.error);
