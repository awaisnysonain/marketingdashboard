/**
 * ETL task catalog — metadata used to build detailed, actionable alert emails.
 * For every cron task: which script runs it, which tables it writes, and what
 * breaks downstream if it fails. Keep in sync with ALL_DAILY_TASKS (server/index.js).
 */
const TASK_CATALOG = {
  klaviyo: {
    label: 'Klaviyo email/SMS metrics',
    script: 'server/etl/klaviyo.js',
    populates: ['klaviyo metrics'],
    impact: 'Email/SMS channel metrics on the Channels page will be stale for the affected day(s).',
  },
  tw_refresh: {
    label: 'Triple Whale brand summary + geo + channel rollup',
    script: 'server/etl/tripleWhaleSQL.js → refreshBrand()',
    populates: ['tw_summary_daily', 'tw_geo_daily', 'tw_channel_daily'],
    impact: 'Core revenue, ad spend, MER, regional (incl. UK) and channel breakdowns will be STALE or MISSING on Overview, NOBL/FLO Topline, Channels, and Live. This is the most important task.',
  },
  tw_order_revenue: {
    label: 'Canonical order-revenue split (Shopify + Amazon)',
    script: 'server/etl/twFullSync.js (order revenue)',
    populates: ['tw_summary_daily.order_revenue', 'shopify_revenue', 'amazon_revenue'],
    impact: 'Headline Order Revenue and blended MER could be wrong/stale; the Shopify-vs-Amazon split will be missing.',
  },
  meta_ads: {
    label: 'Meta Marketing API ad spend (NOBL + FLO)',
    script: 'server/etl/metaAdsSync.js',
    populates: ['meta_ads_daily'],
    impact: 'The Meta Ads page and per-brand Meta ad spend will be stale for the affected day(s).',
  },
  tw_ads: {
    label: 'Triple Whale campaign/adset/ad performance',
    script: 'server/etl/tripleWhaleSQL.js (ads)',
    populates: ['ad-level performance'],
    impact: 'Campaign/adset/ad-level breakdowns on the Meta Ads page will be stale.',
  },
  tw_air_attribution: {
    label: 'NOBL Air order-level attribution',
    script: 'server/etl/noblAirMetaAdDaily.js',
    populates: ['nobl_air_meta_ad_daily'],
    impact: 'NOBL Air per-ad attribution will be stale.',
  },
  shopify_orders: {
    label: 'Shopify per-order detail + line items',
    script: 'server/etl/shopifyOrders.js',
    populates: ['shopify_orders_raw', 'shopify_product_daily'],
    impact: 'Order-level detail and product-line breakdowns (FLO products) will be missing for the affected day(s).',
  },
  appstle_contracts: {
    label: 'Appstle subscription contracts (NOBL + FLO)',
    script: 'server/etl/appstleContracts.js',
    populates: ['subscription contracts'],
    impact: 'The Subscriptions page (active / converted / cancelled) will be stale.',
  },
  nobl_air_aggregate: {
    label: 'NOBL Air daily aggregation',
    script: 'server/etl/noblAirAggregate.js',
    populates: ['nobl_air_daily', 'nobl_air_region_daily'],
    impact: 'NOBL Air Performance (attach rate, trial-to-paid, activation, combined revenue) will be stale or missing.',
  },
  forecast_sheet: {
    label: 'NOBL forecast plan-calendar import',
    script: 'server/etl/forecastImport.js',
    populates: ['forecast_plan_daily'],
    impact: 'The forecast-vs-actuals overlay (plan revenue/spend/MER targets) on Overview, Forecast, and daily tables will be stale.',
  },
  performance_dashboard: {
    label: 'NOBL + FLO performance workbook import',
    script: 'server/etl/performanceDashboardImport.js',
    populates: ['brand_performance_daily'],
    impact: 'The performance dashboard (CPMR, weekly/rolling actual-vs-forecast) will be stale.',
  },
  product_daily: {
    label: 'Shopify product-line daily aggregation',
    script: 'server/etl/shopifyOrders.js (product_daily)',
    populates: ['shopify_product_daily'],
    impact: 'FLO product-line breakdowns (portable / wooden / metal) will be stale.',
  },
  iap: {
    label: 'In-app purchases — App Store + Google Play',
    script: 'server/etl/syncIap.js',
    populates: ['iap_daily', 'iap_subscription_daily'],
    impact: 'The NOBL/FLO App pages (IAP revenue, units, active subscribers) will be stale or missing.',
  },
  ops_metrics: {
    label: 'Ops metrics (shipment fulfillment + UPS + unfulfilled)',
    script: 'server/etl/syncOpsMetrics.js',
    populates: ['ops_metrics_daily'],
    impact: 'The KPI Pulse Ops rows (Avg Shipping Cost / Order, Orders Unfulfilled, Orders Unfulfilled >24h) will be stale. Requires the ERP Postgres (erp_maindb) to be reachable and a fresh UPS token in public.third_party_tokens.',
  },
  cs_tickets: {
    label: 'CS tickets count + region + closes (crmdb + flodb)',
    script: 'server/etl/syncCsTickets.js',
    populates: ['cs_tickets_daily'],
    impact: 'The KPI Pulse CS rows (CS Tickets % of Orders, region splits, effective closes) will be stale. Requires the two Mongo SSH tunnels (port 27018 → crmdb, port 27019 → flodb) to be active on the cron host.',
  },
};

function taskInfo(task) {
  return TASK_CATALOG[task] || { label: task, script: '(unknown script)', populates: [], impact: 'Unrecognized task — investigate manually.' };
}

/** Detailed, multi-line description of one failed task for an alert email. */
function describeTaskFailure(task, brand, error) {
  const t = taskInfo(task);
  return [
    `• Task: ${task}${brand ? ` (${brand})` : ''} — ${t.label}`,
    `  Script:  ${t.script}`,
    `  Error:   ${String(error || 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`,
    `  Tables not updated: ${t.populates.join(', ') || '—'}`,
    `  Impact if not re-run: ${t.impact}`,
  ].join('\n');
}

/** Short impact line for a list of tasks (used in timeout/incomplete alerts). */
function describeTasksImpact(tasks) {
  return tasks.map((task) => {
    const t = taskInfo(task);
    return `• ${task} — ${t.label}\n    → ${t.impact}`;
  }).join('\n');
}

module.exports = { TASK_CATALOG, taskInfo, describeTaskFailure, describeTasksImpact };
