# KPI Pulse — backend status

This page (KpiPulsePage) renders ~78 leadership KPI cells across NOBL/FLO and
daily/weekly/quarterly cadences. It reads `/api/analytics/kpi-pulse`, which
returns one number per (brand, metric, period).

## How the backend is wired

```
ops_metrics_daily    ← server/etl/syncOpsMetrics.js   (ERP Postgres + UPS API + Shopify CA/AU)
cs_tickets_daily     ← server/etl/syncCsTickets.js    (Mongo crmdb + flodb + Shopify cascade match)
nobl_brand_tw_summary_daily / flo_brand_tw_summary_daily
                     ← server/etl/tripleWhaleSQL.js   (existing — unchanged)
nobl_brand_tw_geo_daily / flo_brand_tw_geo_daily
                     ← server/etl/tripleWhaleSQL.js   (existing — unchanged)
nobl_air_daily       ← server/etl/noblAirAggregate.js (existing — unchanged)
nobl_air_subscribers ← server/etl/appstleContracts.js (existing — unchanged)
meta_ads_daily       ← server/etl/metaAdsSync.js      (existing — unchanged)
iap_subscription_daily ← server/etl/syncIap.js        (existing — unchanged)
shopify_orders_raw   ← server/etl/shopifyOrders.js    (existing — unchanged)
```

`server/routes/analytics.js getKpiPulse()` reads all of the above tables for
the calendar year, sums base values per period, and recomputes ratios per
period (so weekly/quarterly rollups stay correct).

The frontend `client/src/pages/KpiPulsePage.js` maps each KPI label to a
backend key via `DB_KEY`. Anything not in `DB_KEY` renders as `—` (blank).

## KPI coverage

### Now live (was blank before this pass)

NOBL daily/weekly/quarterly:
- Avg Shipping Cost / Order   → `ops_metrics_daily.avg_shipping_cost_per_order`
- Orders Partially Unfulfilled → `ops_metrics_daily.orders_unfulfilled`
- Orders Unfulfilled >24hrs   → `ops_metrics_daily.orders_unfulfilled_over_24h`
- Unfulfilled Orders          → `ops_metrics_daily.orders_unfulfilled`
- CS Tickets % of Orders      → `cs_tickets_daily.total_tickets` / brand `total_orders`
- Meta CVR %                  → `meta_ads_daily` (purchases / link_clicks)
- Net Subscriber Adds         → `nobl_air_subscribers` (new − cancelled in window)

FLO daily/weekly/quarterly:
- Gross Sales − Discounts     → `flo_brand_tw_summary_daily.order_revenue` (already in DB; was unwired)
- US MER                      → `flo_brand_tw_geo_daily` (already in DB; was unwired)
- AOV                         → `flo_brand_tw_summary_daily` (was unwired)
- Avg Shipping Cost / Order   → `ops_metrics_daily`
- Orders Unfulfilled >24hrs   → `ops_metrics_daily`
- Unfulfilled Orders          → `ops_metrics_daily`
- CS Tickets % of Orders      → `cs_tickets_daily`
- Meta CVR %                  → `meta_ads_daily`
- Monthly Churn Rate          → `iap_subscription_daily` (cancelled / active)
- Returning Customer Revenue % → `shopify_orders_raw` (orders with prior FLO order)

NOBL Paid Media — strategist Share of Spend (from `meta_ads_daily`, ad_name code
convention `002TC`=Taylor / `002FA`=Franz / `002LK`=Luke / `002CA`=Chris,
matching the Meta GAS automation script):
- Share of Spend TOF — Taylor → `sos_taylor`
- Share of Spend TOF — Franz  → `sos_franz`
- Share of Spend TOF — Luke   → `sos_luke`
- Share of Spend — Chris TOF  → `sos_chris`

FLO Creative — Chris Share + product-bucket CAC (Chris is the FLO strategist;
products are bucketed by normalized substring match in
`campaign|adset|ad` name — `portable` → portable, `studio`/`sutido` → studio,
`home` → home):
- Share of Spend — Chris     → `sos_chris` (FLO series)
- Portable Reformer CAC      → `portable_cac`
- Portable Ad CAC — Chris    → `portable_cac`
- Home + Studio Blended CAC  → `home_studio_cac`
- Sutido / Studio Ad CAC     → `studio_cac`
- Home Ad CAC                → `home_cac`

### Still blank — needs new data sources or integrations

| KPI | What's needed |
|---|---|
| PageSpeed PDP AIO Avg | Google PageSpeed Insights API (no key in `.env`); periodic poll of NOBL/FLO PDP URLs |
| Instagram Engagement Rate | Instagram Graph API access token; periodic IG insights pull |
| Instagram Total Posts | Instagram Graph API |
| TikTok Total Posts | TikTok Business API |
| Site Conversion Rate | TW sessions data (pipeline currently dead per memory) or Shopify Analytics |
| Whitelisting Spend % of Meta Spend | Meta ad-tagging convention (which ads are "whitelisting"?) |
| TOF vs BOF Spend Split | Meta ad funnel/objective tagging convention |
| Bundle % of NOBL Revenue | Bundle-tag mapping on `shopify_product_daily.product_title` |
| App Attach %, FLO daily Trial-to-Paid % | Approximation possible from `iap_subscription_daily` + `flo_brand_tw_summary_daily.total_orders`; clarify exact definition |
| DAU / MAU Stickiness | App analytics SDK (Firebase/Mixpanel/etc.) — not currently emitted by the apps |
| Chargeback Rate | Shopify Disputes API (no current ETL) |
| Retention Rev % | Klaviyo flow/campaign-attributed revenue (the current `klaviyo_daily.revenue` is TOTAL brand revenue, not flow-attributed — would over-report ~100%) |
| SMS % of Sales | Klaviyo SMS-channel attribution split (not in current `klaviyo_daily` schema) |
| Email Flow vs Campaign Split | Klaviyo flow-vs-campaign breakdown (not in current schema) |
| Unsubscribe Rate | Klaviyo unsubscribe event count |
| Blended nCPA | Definition of "new customer acquisition" + Meta/TW alignment |
| Share of Spend TOF — Taylor / Share of Spend — Chris | Per-creator ad tagging convention |

Each of these is a self-contained follow-up. None require touching the
write-paths populated by this pass — adding a new source means adding a new
`server/etl/*` syncer + adding the read to `getKpiPulse()` + adding the key
to `DB_KEY`.

## Operations

### Daily cron

The daily 11:00 Asia/Karachi cron (`server/index.js` → `runDailySync`) now
includes `ops_metrics` and `cs_tickets` as the last two tasks in
`ALL_DAILY_TASKS`. Default backfill window per run: 30 days.

```
ALL_DAILY_TASKS = [...existing, 'ops_metrics', 'cs_tickets']
```

`server/etl/taskCatalog.js` carries the per-task `{label, script, populates,
impact}` metadata so alert emails describe ops/CS failures cleanly.

### Manual backfill commands

YTD 2026 backfill of ops_metrics (UPS-enabled). UPS calls dominate runtime —
plan for ~30 minutes per month at the default concurrency (100):

```bash
# Without UPS (fast — populates orders/unfulfilled/shipping cost):
node server/etl/syncOpsMetrics.js 2026-01-01 2026-06-25 --skip-ups --skip-shopify --commit

# With UPS (slow — adds avg_ship_to_door_hours). Best run in chunks:
node server/etl/syncOpsMetrics.js 2026-01-01 2026-01-31 --skip-shopify --commit
node server/etl/syncOpsMetrics.js 2026-02-01 2026-02-28 --skip-shopify --commit
# … and so on.

# With Shopify CA/AU TTF (slowest — adds ca_avg_ttf_days, au_avg_ttf_days):
node server/etl/syncOpsMetrics.js 2026-01-01 2026-06-25 --commit
```

CS tickets backfill (requires the two Mongo SSH tunnels — see `.env`):

```bash
# Tunnels first (or have systemd manage them):
ssh -N -L 27018:127.0.0.1:27017 <user>@<crmdb-host>
ssh -N -L 27019:127.0.0.1:27017 <user>@<flodb-host>

# YTD backfill:
node server/etl/syncCsTickets.js 2026-01-01 2026-06-25 --commit

# Or skip the Shopify region cascade (counts only — much faster):
node server/etl/syncCsTickets.js 2026-01-01 2026-06-25 --skip-shopify --commit

# One brand only:
node server/etl/syncCsTickets.js 2026-01-01 2026-06-25 --commit --brand=FLO
```

Both ETLs are idempotent — safe to re-run any date range.

### Schema apply

`server/db/applySchema.js` now includes `ops_cs_schema.sql`:

```bash
node server/db/applySchema.js
```

Already applied against prod — both tables created with no rows on
`2026-06-26`.

### .env entries added

```
# Ops ETL (already in .env):
ERP_DB_HOST=54.172.115.118
ERP_DB_PORT=5432
ERP_DB_NAME=erp_maindb
ERP_DB_USER=nysonianREAD
ERP_DB_PASSWORD=NysonianERPREAD
# Optional: UPS_TRACKING_CONCURRENCY=100

# CS ETL (both URIs added this pass):
CS_NOBL_MONGO_URI=mongodb://crmdbreaduser:dontdropanything@127.0.0.1:27018/crmdb?authSource=crmdb
CS_FLO_MONGO_URI=mongodb://flodb_readonly:NittheFLOAccess%40123@127.0.0.1:27019/flodb?authSource=flodb
```

## Caveats / known gotchas

- **ERP timestamps are stored UTC** but node-postgres returns DATE values as
  local-midnight JS Date, which shifts the day. Both syncOpsMetrics queries
  return `TO_CHAR(::date, 'YYYY-MM-DD')` as TEXT to avoid this. Don't change
  back to raw `::date` without a TZ-safe formatter.
- **FLO TW summary numbers can look ~10× lower than the spreadsheet samples**
  on KpiPulsePage. Those samples were hardcoded mock data; the dashboard's
  numbers come from Triple Whale and represent reality. If they're wrong, the
  fix is in `tripleWhaleSQL.js` / TW account configuration, not here.
- **klaviyo_daily.revenue is total brand revenue, not flow-attributed.** The
  endpoint loads it but does NOT emit a `retention_rev_pct` KPI because the
  ratio would be ~100% (nonsensical). Restore the KPI once the Klaviyo ETL is
  upgraded to emit flow-attributed revenue.
- **UPS deliveries are re-fetched every cron run.** Past-day delivery info is
  stable; a future optimization is a `ups_tracking_deliveries` cache table so
  only new trackings hit UPS each day. Current concurrency (100) keeps a day's
  ~2,500 calls under ~25 seconds, so the daily cron isn't bottlenecked.
- **MongoDB tunnels must be live on the cron host** for `cs_tickets` to
  succeed. If a tunnel is down on a given day, the row for that day is still
  upserted but with `source_error` set and counts at 0 — so a downstream
  consumer can tell "missing because tunnel down" from "really 0 tickets".
