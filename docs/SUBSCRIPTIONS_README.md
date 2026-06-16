# Subscription Data Flow

This document explains how NOBL and FLO subscription data is fetched, stored, aggregated, exposed through the API, and displayed on the frontend.

## Overview

Subscription data is sourced from Appstle and saved into PostgreSQL. The frontend does not call Appstle directly.

Flow:

```text
Appstle API
  -> server/etl/appstleContracts.js
  -> PostgreSQL subscription tables
  -> server/routes/analytics.js
  -> client/src/utils/api.js
  -> client/src/pages/SubsPage.js
```

NOBL Air Performance also uses NOBL Appstle data for TTP, active subscribers, ARR, tier mix, and rebill revenue.

## Source APIs

### NOBL

NOBL subscriptions use the Appstle API key from:

```text
APPSTLE_API_KEY
```

The sync function is:

```js
syncAppstleContracts()
```

Data is stored in:

```text
nobl_air_subscribers
```

### FLO

FLO subscriptions use the Appstle API key from:

```text
FLO_APPSTLE_API_KEY
```

The sync function is:

```js
syncFloAppstleContracts()
```

Data is stored in:

```text
flo_appstle_subscribers
flo_appstle_revenue_daily
```

Optional detailed billing attempts can also be stored in:

```text
flo_appstle_billing_attempts
```

## Appstle Fetch Logic

File:

```text
server/etl/appstleContracts.js
```

Endpoint:

```text
GET https://subscription-admin.appstle.com/api/external/v2/subscription-contract-details
```

Query pattern:

```text
page=<page>&size=2000&sort=created_at,asc
```

The ETL pages through all Appstle contracts and upserts each contract into the correct PostgreSQL table.

Important saved fields:

```text
appstle_id
customer_id
customer_email
customer_name
order_name
graph_order_id
status
contract_amount
order_amount
created_at
next_billing_date
last_billing_date
cancelled_on
is_mature
is_converted
is_same_day_cancel
raw_json
```

## Derived Fields

### is_mature

`is_mature` is true when the subscription was created at least 14 days ago.

```text
created_at <= now - 14 days
```

This matches the 14-day trial-to-paid maturity window.

### is_converted

`is_converted` is true when Appstle has a successful paid order amount greater than zero.

The ETL reads `lastSuccessfulOrder` from the Appstle contract payload.

```text
lastSuccessfulOrder.orderAmount > 0
```

### is_same_day_cancel

`is_same_day_cancel` is true when the subscription was cancelled within 24 hours of creation.

```text
cancelled_on - created_at <= 24 hours
```

## Daily Cron Behavior

File:

```text
server/etl/syncEngine.js
```

The `appstle_contracts` task now syncs both brands:

```text
NOBL -> syncAppstleContracts() -> nobl_air_subscribers
FLO  -> syncFloAppstleContracts() -> flo_appstle_subscribers -> flo_appstle_revenue_daily
```

This means future cron runs refresh both subscription datasets automatically.

FLO billing-attempt history is not fetched by default during cron because it can require one API call per subscription. To run that expensive backfill intentionally, set:

```text
FLO_APPSTLE_SYNC_BILLING_ATTEMPTS=true
```

Leave that unset or false for normal daily cron reliability.

## NOBL Subscription API

Legacy endpoint:

```text
GET /api/analytics/nobl/subscriptions?start=YYYY-MM-DD&end=YYYY-MM-DD
```

This endpoint is still supported for compatibility.

Brand-aware endpoint:

```text
GET /api/analytics/subscriptions?brand=NOBL&start=YYYY-MM-DD&end=YYYY-MM-DD
```

NOBL daily subscription revenue comes from `nobl_air_daily`:

```text
new_sub_revenue = sub_net_sales
rebill_revenue = Appstle lastSuccessfulOrder.orderAmount by billing date
sub_revenue_actual = sub_net_sales + rebill_revenue
```

NOBL summary metrics come from `nobl_air_subscribers`:

```text
total
active
cancelled
paused
trialing
converted
avg_order_amount
```

## FLO Subscription API

Brand-aware endpoint:

```text
GET /api/analytics/subscriptions?brand=FLO&start=YYYY-MM-DD&end=YYYY-MM-DD
```

FLO daily subscription revenue is read by the API from `flo_appstle_revenue_daily`.

The revenue table is computed by:

```text
server/etl/floAppstleRevenue.js
```

The aggregation prefers the best available source in this order:

```text
1. flo_appstle_billing_attempts, if detailed billing-attempt history exists
2. FLO Shopify AppSubscription line items from shopify_orders_raw
3. Appstle lastSuccessfulOrder fallback from flo_appstle_subscribers
```

Daily new subscription revenue:

```text
Shopify AppSubscription revenue for orders matching original Appstle order names.
If Shopify subscription-line history is unavailable, fallback is SUM(order_amount) grouped by DATE(created_at).
```

Daily rebill revenue:

```text
Successful non-initial billing attempts when available.
Otherwise, Shopify AppSubscription orders not matching original Appstle order names.
If neither is available, fallback is SUM(lastSuccessfulOrder.orderAmount) grouped by lastSuccessfulOrder.orderDate.
```

Daily total subscription revenue:

```text
new_sub_revenue + rebill_revenue
```

FLO summary metrics come from `flo_appstle_subscribers`:

```text
total
active
cancelled
paused
trialing
converted
avg_order_amount
```

## Frontend API Client

File:

```text
client/src/utils/api.js
```

Subscription fetch helper:

```js
getSubscriptions(start, end, brand)
```

Example:

```js
getSubscriptions('2026-05-01', '2026-05-05', 'FLO')
```

## Frontend Page

File:

```text
client/src/pages/SubsPage.js
```

The page has a brand selector:

```text
NOBL | FLO
```

Changing the selector calls:

```js
getSubscriptions(range.start, range.end, brand)
```

The page renders:

```text
Active Subscribers
Trialing
Converted
Cancelled
Total Sub Revenue
Avg Order Amount
Daily Subscription Revenue chart
Rebill vs New Subscribers chart
Daily Subscription Detail table
```

## NOBL Air Performance Usage

File:

```text
client/src/pages/NoblAirPerformancePage.js
```

NOBL Air Performance uses subscription data for:

```text
TTP Rate
Activation Rate
Active Subscribers
Active ARR
Tier Mix
Status Mix
Same-Day Cancels
```

TTP uses mature Appstle subscribers, not the selected MTD cohort, because recent subscribers are still inside the 14-day trial window.

TTP formula:

```text
converted mature subscribers / mature subscribers
```

Activation formula:

```text
attach_rate * ttp_rate
```

## Important Business Rules

### Rebills In Total Orders

Rebills are never counted in NOBL Air total orders.

### Rebill Revenue

NOBL rebill revenue uses Appstle successful billing amount, not Shopify rebill order total.

```text
lastSuccessfulOrder.orderAmount
```

### Dates

NOBL Air order metrics use UTC order dates from Shopify `created_at`.

```text
(created_at AT TIME ZONE 'UTC')::date
```

The NOBL Air Performance endpoint caps results to the latest successful `nobl_air_aggregate` cron date, so incomplete current-day data does not appear in totals.

## Key Files

```text
server/etl/appstleContracts.js       Appstle fetch and upsert for NOBL/FLO
server/etl/syncEngine.js             Daily cron task orchestration
server/etl/noblAirAggregate.js       NOBL Air daily aggregation
server/routes/analytics.js           Subscription and NOBL Air APIs
client/src/utils/api.js              Frontend API helpers
client/src/pages/SubsPage.js         NOBL/FLO subscriptions page
client/src/pages/NoblAirPerformancePage.js  NOBL Air dashboard
```

## Production Notes

See [DEPLOY.md](../DEPLOY.md) for full production setup.

PM2 process name: `nobl` (from `ecosystem.config.js`).

Required Appstle keys in production `.env`:

```text
APPSTLE_API_KEY
FLO_APPSTLE_API_KEY
```
