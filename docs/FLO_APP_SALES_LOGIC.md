# FLO App Sales Logic Reconciliation

Date checked: 2026-05-05

This note documents the FLO App Sales logic tested against the QuickBooks `4008 - App sales` monthly values for Jan-Apr 2026.

## Accounting Target

QuickBooks `4008 - App sales` values used for comparison:

| Month | QuickBooks App Sales |
|---|---:|
| 2026-01 | 228,795.42 |
| 2026-02 | 342,954.14 |
| 2026-03 | 818,893.13 |
| 2026-04 | 528,104.96 |

## Current Production Logic

Current persisted FLO subscription revenue is stored in `flo_appstle_revenue_daily`.

Source table:

- `shopify_orders_raw`

Current app-line detection:

```sql
COALESCE(li->>'sku', '') ILIKE '%AppSubscription%'
OR COALESCE(li->>'title', '') ILIKE '%Subscription%'
```

Current revenue allocation:

- If an order contains only app/subscription lines, use `order.total_price`.
- If an order contains mixed app + non-app lines, use only the app line amount.
- `sub_revenue_actual` is gross and does not subtract refunds.
- Refunds are stored separately in `shopify_sub_refunds`.
- Month bucket uses Shopify `date_key`, which is effectively `America/New_York`/ET.

Current result vs QuickBooks:

| Month | Current Logic | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 207,408.32 | 228,795.42 | -21,387.10 |
| 2026-02 | 321,844.00 | 342,954.14 | -21,110.14 |
| 2026-03 | 825,491.66 | 818,893.13 | +6,598.53 |
| 2026-04 | 534,120.04 | 528,104.96 | +6,015.08 |

## Timezone Checks

Timezone was tested as a possible cause.

Result: timezone does not explain the mismatch.

EST compared to current ET logic:

| Month | EST - Current ET |
|---|---:|
| 2026-01 | 0.00 |
| 2026-02 | 0.00 |
| 2026-03 | +477.02 |
| 2026-04 | +22.37 |

UTC made some months worse, especially February.

## Other Tested Logic Variants

### App Line Only

Only count app/subscription line-item amounts.

| Month | App Line Only | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 203,974.94 | 228,795.42 | -24,820.48 |
| 2026-02 | 333,411.06 | 342,954.14 | -9,543.08 |
| 2026-03 | 837,228.57 | 818,893.13 | +18,335.44 |
| 2026-04 | 520,058.27 | 528,104.96 | -8,046.69 |

This does not consistently match QuickBooks.

### Current Logic Less Refunds

Subtract app/subscription refunds from current gross logic.

| Month | Current Less Refunds | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 207,258.47 | 228,795.42 | -21,536.95 |
| 2026-02 | 309,436.87 | 342,954.14 | -33,517.27 |
| 2026-03 | 786,635.13 | 818,893.13 | -32,258.00 |
| 2026-04 | 529,010.64 | 528,104.96 | +905.68 |

This helps April but makes February and March much worse.

### Original/Gross Line Price

Original line price was tested against discounted line price.

Result: for app/subscription lines, original line amount equaled discounted line amount in the checked period, so discount handling does not explain the gap.

### Financial Status Filtering

Financial status variants were tested:

- Include all statuses.
- Paid only.
- Paid + partially refunded.
- Exclude pending.
- Exclude refunded.

Result: no financial-status filter produced a consistent match. Excluding refunded orders understated March/April too much.

## Important Missed Line Item

The search found a real app-related line item that current logic excludes:

```text
Unlimited FLO Access
```

It does not include `Subscription` in the title or `AppSubscription` in the SKU, so current detection misses it.

Monthly amounts:

| Month | Unlimited FLO Access |
|---|---:|
| 2026-01 | 14,454.06 |
| 2026-02 | 11,294.07 |
| 2026-03 | 8,878.53 |
| 2026-04 | 7,136.16 |

Recommended expanded app detection if `Unlimited FLO Access` is confirmed as App Sales:

```sql
COALESCE(li->>'sku', '') ILIKE '%AppSubscription%'
OR COALESCE(li->>'title', '') ILIKE '%Subscription%'
OR COALESCE(li->>'title', '') ILIKE '%Unlimited FLO Access%'
```

## Package Protection Candidate

Package/protection-style line items also exist and current logic excludes them.

Examples:

- `Add Package Protection`
- `10-Year Warranty + Package Protection`

Monthly protection totals:

| Month | Protection Lines |
|---|---:|
| 2026-01 | 8,660.08 |
| 2026-02 | 6,085.04 |
| 2026-03 | 8,836.10 |
| 2026-04 | 6,770.76 |

Detection used in testing:

```sql
COALESCE(li->>'title', '') ILIKE '%protection%'
OR COALESCE(li->>'sku', '') ILIKE '%protect%'
```

This may or may not belong in `4008 - App sales`. It sounds like a package protection/warranty app fee rather than FLO subscription revenue, so this needs accounting confirmation before ETL changes.

## Best-Matching Tested Formula

The closest tested formula to QuickBooks was:

```text
Subscription lines
+ Unlimited FLO Access lines
+ Protection lines
- Matching line-item refunds
```

This formula uses line-item revenue only, not whole order totals.

Result:

| Month | Formula | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 226,892.23 | 228,795.42 | -1,903.19 |
| 2026-02 | 337,627.32 | 342,954.14 | -5,326.82 |
| 2026-03 | 815,688.00 | 818,893.13 | -3,205.13 |
| 2026-04 | 528,846.79 | 528,104.96 | +741.83 |

This reduced the four-month total absolute difference from the current logic's much larger mismatch to about `11,176.97`.

## Best Formula With Timezone Variants

Using the best formula above, timezone was checked again.

### `date_key` / ET

| Month | Formula | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 226,892.23 | 228,795.42 | -1,903.19 |
| 2026-02 | 337,627.32 | 342,954.14 | -5,326.82 |
| 2026-03 | 815,688.00 | 818,893.13 | -3,205.13 |
| 2026-04 | 527,575.42 | 528,104.96 | -529.54 |

### Fixed EST

| Month | Formula | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 226,892.23 | 228,795.42 | -1,903.19 |
| 2026-02 | 337,498.32 | 342,954.14 | -5,455.82 |
| 2026-03 | 816,266.00 | 818,893.13 | -2,627.13 |
| 2026-04 | 527,126.42 | 528,104.96 | -978.54 |

### America/New_York

| Month | Formula | QuickBooks | Diff |
|---|---:|---:|---:|
| 2026-01 | 226,892.23 | 228,795.42 | -1,903.19 |
| 2026-02 | 337,498.32 | 342,954.14 | -5,455.82 |
| 2026-03 | 815,808.00 | 818,893.13 | -3,085.13 |
| 2026-04 | 527,584.42 | 528,104.96 | -520.54 |

Timezone still does not fully explain the remaining gap.

## Recommended Decision Point

Before changing production ETL, confirm what QuickBooks `4008 - App sales` should represent:

1. FLO/Appstle subscription revenue only, including `Unlimited FLO Access`.
2. All app-related line items, including subscriptions, `Unlimited FLO Access`, and package/protection fees.
3. A QuickBooks-matching accounting definition, even if it includes protection/warranty app fees.

## Recommended ETL Change After Confirmation

If option 1 is confirmed:

- Add `Unlimited FLO Access` to app-line detection.
- Keep package/protection excluded.
- Decide whether dashboard should show gross or net of refunds.

If option 2 or 3 is confirmed:

- Add `Unlimited FLO Access` and protection detection to app-line logic.
- Switch App Sales comparison/reporting to line-item revenue less matching refunds.
- Backfill `flo_appstle_revenue_daily` after changing `server/etl/floAppstleRevenue.js`.

## Current Blocker

Direct Appstle billing-attempt history is still unavailable because the Appstle billing-attempt API returned HTTP 401. Because of that, the current reconciliation is based on Shopify order and line-item data.
