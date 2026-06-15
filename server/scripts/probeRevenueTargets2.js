require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');

const d = '2026-06-14';

async function q(label, sql) {
  try {
    const rows = await twSqlQuery('NOBL', sql, { period: { startDate: d, endDate: d } });
    console.log(`${label}:`, rows[0] || rows);
    return rows[0];
  } catch (e) {
    console.log(`${label}: FAIL`, e.message.slice(0, 120));
    return null;
  }
}

async function main() {
  // Amazon field probe
  for (const f of ['gross_sales', 'total_sales', 'gross_product_sales', 'order_revenue', 'discount_amount', 'shipping_price', 'taxes']) {
    await q(`amz ${f}`, `
      SELECT COALESCE(SUM(ot.${f}), 0) AS v FROM orders_table ot
      WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status != 'Canceled'
        AND ot.event_date=DATE '${d}'`);
  }

  // Try gross_sales - discounts
  await q('bst gmd gross_sales-discounts', `
    SELECT COALESCE(SUM(bst.gross_sales - bst.discounts),0) gmd,
           COALESCE(SUM(bst.order_revenue),0) order_revenue,
           COALESCE(SUM(bst.gross_sales),0) gross_sales
    FROM blended_stats_tvf(include_amazon=TRUE) bst WHERE bst.event_date='${d}'`);

  await q('shop bst + amz gross-disc', `
    SELECT
      (SELECT COALESCE(SUM(bst.gross_product_sales - bst.discounts),0)
       FROM blended_stats_tvf(include_amazon=FALSE) bst WHERE bst.event_date='${d}') AS shop_gmd,
      (SELECT COALESCE(SUM(ot.gross_product_sales - ot.discount_amount),0)
       FROM orders_table ot WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'
         AND ot.event_date=DATE '${d}') AS amz_gmd1,
      (SELECT COALESCE(SUM(ot.gross_sales - ot.discount_amount),0)
       FROM orders_table ot WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'
         AND ot.event_date=DATE '${d}') AS amz_gmd2`);

  // Try rounding at order level
  await q('orders round gmd', `
    SELECT
      COALESCE(SUM(ROUND(ot.gross_product_sales - ot.discount_amount, 2)), 0) AS gmd,
      COALESCE(SUM(ROUND(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount, 2)), 0) AS ord_rev
    FROM orders_table ot
    WHERE ot.event_date = DATE '${d}'
      AND (ot.platform='shopify' OR (ot.platform='amazon' AND ot.amazon_fulfillment_status != 'Canceled'))`);

  // financial_status filter?
  await q('orders paid only', `
    SELECT
      COALESCE(SUM(ot.gross_product_sales - ot.discount_amount), 0) AS gmd,
      COALESCE(SUM(ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount), 0) AS formula
    FROM orders_table ot
    WHERE ot.event_date = DATE '${d}'
      AND ot.financial_status IN ('paid','partially_refunded')
      AND (ot.platform='shopify' OR (ot.platform='amazon' AND ot.amazon_fulfillment_status != 'Canceled'))`);

  console.log('\nTargets: gmd=783732.88 ord=843047');
}

main().catch(console.error);
