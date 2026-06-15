require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');

const d = '2026-06-14';

async function q(sql) {
  const rows = await twSqlQuery('NOBL', sql, { period: { startDate: d, endDate: d } });
  return rows[0] || {};
}

async function main() {
  const shop = await q(`
    SELECT
      COALESCE(SUM(ot.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(ot.gross_product_sales), 0) AS gross_product_sales,
      COALESCE(SUM(ot.discount_amount), 0) AS discount_amount,
      COALESCE(SUM(ot.gross_product_sales - ot.discount_amount), 0) AS gross_minus_discounts,
      COALESCE(SUM(ot.shipping_price), 0) AS shipping_price
    FROM orders_table AS ot
    WHERE ot.platform = 'shopify' AND ot.event_date = DATE '${d}'`);

  const amz = await q(`
    SELECT
      COALESCE(SUM(ot.order_revenue), 0) AS order_revenue,
      COALESCE(SUM(ot.gross_product_sales), 0) AS gross_product_sales,
      COALESCE(SUM(ot.discount_amount), 0) AS discount_amount
    FROM orders_table AS ot
    WHERE ot.platform = 'amazon' AND ot.amazon_fulfillment_status != 'Canceled'
      AND ot.event_date = DATE '${d}'`);

  for (const f of ['taxes', 'tax', 'total_taxes']) {
    try {
      const t = await q(`SELECT COALESCE(SUM(ot.${f}), 0) AS v FROM orders_table ot WHERE ot.platform='shopify' AND ot.event_date=DATE '${d}'`);
      console.log(f, t.v);
    } catch (e) { console.log(f, 'FAIL'); }
  }

  const bstShop = await q(`
    SELECT COALESCE(SUM(bst.order_revenue),0) order_revenue,
           COALESCE(SUM(bst.gross_product_sales),0) gross_product_sales,
           COALESCE(SUM(bst.discounts),0) discounts,
           COALESCE(SUM(bst.shipping_price),0) shipping,
           COALESCE(SUM(bst.taxes),0) taxes
    FROM blended_stats_tvf(include_amazon=FALSE) bst WHERE bst.event_date='${d}'`);

  const bstAll = await q(`
    SELECT COALESCE(SUM(bst.order_revenue),0) order_revenue,
           COALESCE(SUM(bst.gross_product_sales),0) gross_product_sales,
           COALESCE(SUM(bst.discounts),0) discounts
    FROM blended_stats_tvf(include_amazon=TRUE) bst WHERE bst.event_date='${d}'`);

  console.log('\nShopify orders_table:', shop);
  console.log('Amazon orders_table:', amz);
  console.log('Blended shopify-only:', bstShop);
  console.log('Blended with amazon:', bstAll);

  const gmd = Number(shop.gross_minus_discounts) + Number(amz.gross_product_sales) - Number(amz.discount_amount);
  const ordRev = Number(shop.order_revenue) + Number(amz.order_revenue);
  console.log('\nCombined gross_minus_discounts:', gmd.toFixed(2));
  console.log('Combined order_revenue:', ordRev.toFixed(2));
  console.log('User ref ~783732 gross-disc, ~843k order rev');
}

main().catch(console.error);
