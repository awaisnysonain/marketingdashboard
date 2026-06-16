/**
 * Revenue metrics — definitions and TW SQL expressions.
 *
 * order_revenue — Gross Product Sales + Shipping + Taxes − Discounts
 * (Triple Whale "Order Revenue"; before refunds). MER uses this metric.
 *
 * gross_minus_discounts is still computed/stored by ETL but not exposed in the UI.
 */

/** TW amazon fee rates applied to (gross_product_sales − gross_sales) markup. */
const AMAZON_GMD_FEE_RATE = 0.020488286;
const AMAZON_ORD_FEE_RATE = 0.063436047;

const METRICS = {
  order_revenue: {
    key: 'order_revenue',
    label: 'Order Revenue',
    shortLabel: 'Order Revenue',
    formula: 'Gross Product Sales + Shipping + Taxes − Discounts',
    tooltip:
      'Triple Whale Order Revenue — full order value after discounts, before refunds. Includes shipping and taxes. Used for MER and AOV.',
  },
};

/**
 * SQL expression for gross_minus_discounts (single row, alias `ot`).
 * @param {boolean} includeAmazon
 */
function sqlGrossMinusDiscounts(includeAmazon) {
  if (!includeAmazon) {
    return 'ot.gross_product_sales - ot.discount_amount';
  }
  return `CASE WHEN ot.platform = 'amazon'
    THEN ot.gross_product_sales - ot.discount_amount
         - (ot.gross_product_sales - ot.gross_sales) * ${AMAZON_GMD_FEE_RATE}
    ELSE ot.gross_product_sales - ot.discount_amount END`;
}

/**
 * SQL expression for order_revenue (single row, alias `ot`).
 * @param {boolean} includeAmazon
 */
function sqlOrderRevenue(includeAmazon) {
  if (!includeAmazon) {
    return 'ot.gross_product_sales + ot.shipping_price + ot.taxes - ot.discount_amount';
  }
  return `CASE WHEN ot.platform = 'amazon'
    THEN ot.gross_product_sales + ot.taxes - ot.discount_amount
         - (ot.gross_product_sales - ot.gross_sales) * ${AMAZON_ORD_FEE_RATE}
    WHEN ot.platform = 'shopify'
    THEN ot.order_revenue
    ELSE 0 END`;
}

/** WHERE clause for revenue-eligible orders_table rows. */
function sqlOrdersPlatformFilter(includeAmazon) {
  if (includeAmazon) {
    return `(ot.platform = 'shopify'
      OR (ot.platform = 'amazon' AND ot.amazon_fulfillment_status != 'Canceled'))`;
  }
  return `ot.platform = 'shopify'`;
}

module.exports = {
  METRICS,
  AMAZON_GMD_FEE_RATE,
  AMAZON_ORD_FEE_RATE,
  sqlGrossMinusDiscounts,
  sqlOrderRevenue,
  sqlOrdersPlatformFilter,
};
