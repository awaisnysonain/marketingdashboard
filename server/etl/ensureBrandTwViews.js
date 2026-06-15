/**
 * Recreate brand-level TW summary views so they expose all tw_summary_daily columns,
 * including gross_minus_discounts (added after initial view creation).
 */
const { pgRun } = require('../db/postgres');

const SUMMARY_VIEW_SQL = {
  nobl_brand_tw_summary_daily: `
    CREATE OR REPLACE VIEW nobl_brand_tw_summary_daily AS
    SELECT id,
           brand,
           date,
           total_revenue,
           total_spend,
           mer,
           total_orders,
           new_customer_orders,
           returning_customer_orders,
           order_revenue,
           shopify_revenue,
           amazon_revenue,
           total_sales,
           refund_amount,
           refund_count,
           created_at,
           updated_at,
           gross_minus_discounts
    FROM tw_summary_daily
    WHERE brand = 'NOBL'`,
  flo_brand_tw_summary_daily: `
    CREATE OR REPLACE VIEW flo_brand_tw_summary_daily AS
    SELECT id,
           brand,
           date,
           total_revenue,
           total_spend,
           mer,
           total_orders,
           new_customer_orders,
           returning_customer_orders,
           order_revenue,
           shopify_revenue,
           amazon_revenue,
           total_sales,
           refund_amount,
           refund_count,
           created_at,
           updated_at,
           gross_minus_discounts
    FROM tw_summary_daily
    WHERE brand = 'FLO'`,
};

async function ensureBrandTwViews() {
  await pgRun(`
    ALTER TABLE tw_summary_daily
      ADD COLUMN IF NOT EXISTS gross_minus_discounts NUMERIC(14,4) DEFAULT 0
  `).catch(() => {});

  for (const sql of Object.values(SUMMARY_VIEW_SQL)) {
    await pgRun(sql);
  }
}

module.exports = { ensureBrandTwViews, SUMMARY_VIEW_SQL };
