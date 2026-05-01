/**
 * NOBL Air subscription ETL — pulls subscription data directly from Shopify GraphQL
 * (replaces the broken Appstle integration: their direct API endpoints return HTML
 * or 401, and Shopify's own subscriptionContracts field is ACCESS_DENIED for our token).
 *
 * Identifies subscription line items by the `sellingPlan` field — present only on
 * line items that were sold as part of a Shopify subscription. Tag
 * `appstle_subscription_first_order` distinguishes new subs from rebills.
 *
 * Writes to:
 *   - nobl_air_sub_revenue_daily   (one row per date, with new vs rebill split)
 *   - appstle_subscriptions        (one row per unique subscriber)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pgQuery } = require('../db/postgres');

const SHOP   = process.env.NOBL_SHOPIFY_SHOP;
const TOKEN  = process.env.NOBL_SHOPIFY_TOKEN;
const GQL_URL = `https://${SHOP}/admin/api/2024-10/graphql.json`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = 1500 * attempt;
      console.warn(`[NOBL Air] Shopify ${res.status}, retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const json = await res.json();
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join('; ');
      // Throttled "cost" errors come back as 200 + errors[]
      if (/throttle|cost/i.test(msg)) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error('Shopify GraphQL error: ' + msg);
    }
    return json.data;
  }
  throw new Error('Shopify GraphQL retries exhausted');
}

/**
 * Fetch all NOBL orders in [startDate, endDate] that contain a subscription line item.
 * Cursor-paginates until exhausted. Returns an array of normalized order records.
 */
async function fetchSubscriptionOrders(startDate, endDate) {
  const query = `
    query Orders($cursor: String, $q: String!) {
      orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id name createdAt
          tags
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id email firstName lastName }
          lineItems(first: 30) { edges { node {
            title sku quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
            sellingPlan { name }
          } } }
        } }
      }
    }`;

  // Use Shopify search syntax: line_items.title:"NOBL Air" AND date range
  const q = `line_items.title:"NOBL Air" AND created_at:>=${startDate} AND created_at:<=${endDate}`;

  const out = [];
  let cursor = null;
  let pages = 0;

  while (true) {
    const data = await gql(query, { cursor, q });
    pages++;
    const conn = data.orders;
    for (const edge of conn.edges) {
      out.push(edge.node);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    await sleep(250); // rate limit cushion
    if (pages >= 250) {
      console.warn(`[NOBL Air] Hit page cap (250) — fetched ${out.length} orders, stopping`);
      break;
    }
  }
  return out;
}

function isSubLine(li) { return li.sellingPlan != null; }
function priceOf(li) {
  const p = li.discountedUnitPriceSet?.shopMoney?.amount
         || li.originalUnitPriceSet?.shopMoney?.amount
         || '0';
  return parseFloat(p) * (li.quantity || 1);
}

/**
 * Aggregate orders into per-day revenue rows.
 *
 * "New sub" classification (in priority order):
 *   1. Order tagged `appstle_subscription_first_order` (explicit signal — older orders)
 *   2. Customer's earliest sub-order in our visible window AND we're confident it's their first
 *      (heuristic: if backfill covers >=14 months and this is first sub order seen for the customer)
 *   3. Otherwise → rebill
 *
 * For partial-window syncs (e.g. 7-day cron), we can't tell #2 reliably,
 * so we fall back to: tag-based "new" only, everything else "rebill".
 * For full backfills, #2 kicks in and gives correct splits.
 */
function aggregateDaily(orders, opts = {}) {
  const { backfillMode = false } = opts;

  // First pass: find each customer's earliest sub-order date in this window
  const firstSubByCust = new Map();
  for (const o of orders) {
    const cid = o.customer?.id;
    if (!cid) continue;
    const hasSubLine = o.lineItems.edges.some(e => isSubLine(e.node));
    if (!hasSubLine) continue;
    if (!firstSubByCust.has(cid) || o.createdAt < firstSubByCust.get(cid)) {
      firstSubByCust.set(cid, o.createdAt);
    }
  }

  const daily = new Map(); // date → { rebill, new_sub, total }
  for (const o of orders) {
    const date = o.createdAt.slice(0, 10);
    const tags = (o.tags || []).map(t => t.toLowerCase());
    const tagSaysFirst = tags.includes('appstle_subscription_first_order');

    let subRev = 0;
    for (const e of o.lineItems.edges) {
      const li = e.node;
      if (isSubLine(li)) subRev += priceOf(li);
    }
    if (subRev === 0) continue;

    const cid = o.customer?.id;
    const isCustFirstInWindow = cid && firstSubByCust.get(cid) === o.createdAt;
    const isFirst = tagSaysFirst || (backfillMode && isCustFirstInWindow);

    if (!daily.has(date)) daily.set(date, { rebill: 0, new_sub: 0, total: 0 });
    const b = daily.get(date);
    if (isFirst) b.new_sub += subRev;
    else         b.rebill  += subRev;
    b.total += subRev;
  }
  return daily;
}

/**
 * Build subscriber records from orders. One record per unique customer who has
 * ever purchased a subscription line item; their status is "active" if their
 * most recent sub-line-item order is within 14 months (yearly billing + grace).
 */
function buildSubscribers(orders) {
  const byCust = new Map();
  for (const o of orders) {
    if (!o.customer?.id) continue;
    const subLines = o.lineItems.edges.map(e => e.node).filter(isSubLine);
    if (subLines.length === 0) continue;

    const cid = o.customer.id;
    const orderRevenue = subLines.reduce((s, li) => s + priceOf(li), 0);
    const tags = (o.tags || []).map(t => t.toLowerCase());
    const isFirst = tags.includes('appstle_subscription_first_order');

    if (!byCust.has(cid)) {
      byCust.set(cid, {
        appstle_id: cid.replace('gid://shopify/Customer/', ''),
        customer_email: o.customer.email || '',
        customer_name: [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' '),
        first_order_date: o.createdAt,
        last_order_date: o.createdAt,
        last_order_amount: orderRevenue,
        total_successful_orders: 1,
        product_title: subLines[0].title,
        sku: subLines[0].sku,
        sample_selling_plan: subLines[0].sellingPlan?.name,
        new_orders: isFirst ? 1 : 0,
      });
    } else {
      const r = byCust.get(cid);
      r.total_successful_orders += 1;
      if (o.createdAt > r.last_order_date) {
        r.last_order_date = o.createdAt;
        r.last_order_amount = orderRevenue;
      }
      if (o.createdAt < r.first_order_date) r.first_order_date = o.createdAt;
      if (isFirst) r.new_orders += 1;
    }
  }

  // Status heuristic: active if last order within 14 months
  const now = Date.now();
  const FOURTEEN_MO = 14 * 30 * 24 * 60 * 60 * 1000;
  for (const r of byCust.values()) {
    const lastMs = new Date(r.last_order_date).getTime();
    r.status = (now - lastMs) <= FOURTEEN_MO ? 'active' : 'cancelled';
  }
  return [...byCust.values()];
}

async function writeDaily(daily) {
  let written = 0;
  for (const [date, vals] of [...daily.entries()].sort()) {
    await pgRun(`
      INSERT INTO nobl_air_sub_revenue_daily
        (date, sub_revenue_actual, rebill_revenue, new_sub_revenue)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (date) DO UPDATE SET
        sub_revenue_actual = EXCLUDED.sub_revenue_actual,
        rebill_revenue     = EXCLUDED.rebill_revenue,
        new_sub_revenue    = EXCLUDED.new_sub_revenue,
        updated_at         = NOW()
    `, [date, vals.total, vals.rebill, vals.new_sub]);
    written++;
  }
  return written;
}

async function writeSubscribers(subs) {
  if (subs.length === 0) return 0;
  // Batch into chunks of 200 — single multi-row INSERT per chunk to avoid
  // hammering the pool with thousands of round-trips (which was timing out the
  // PG connection on full backfills).
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < subs.length; i += CHUNK) {
    const slice = subs.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;
    for (const s of slice) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW(), NOW(), $${p++}::jsonb)`);
      params.push(
        s.appstle_id, s.status, s.customer_email, s.customer_name,
        s.last_order_date.slice(0, 10), s.last_order_amount, s.total_successful_orders,
        s.first_order_date,
        JSON.stringify({
          product_title:       s.product_title,
          sku:                 s.sku,
          sample_selling_plan: s.sample_selling_plan,
          new_orders:          s.new_orders,
        }),
      );
    }
    await pgRun(`
      INSERT INTO appstle_subscriptions
        (appstle_id, status, customer_email, customer_name,
         last_order_date, last_order_amount, total_successful_orders,
         created_at_appstle, updated_at_appstle, etl_fetched_at, raw_json)
      VALUES ${values.join(', ')}
      ON CONFLICT (appstle_id) DO UPDATE SET
        status                  = EXCLUDED.status,
        customer_email          = EXCLUDED.customer_email,
        customer_name           = EXCLUDED.customer_name,
        last_order_date         = EXCLUDED.last_order_date,
        last_order_amount       = EXCLUDED.last_order_amount,
        total_successful_orders = EXCLUDED.total_successful_orders,
        updated_at_appstle      = NOW(),
        etl_fetched_at          = NOW(),
        raw_json                = EXCLUDED.raw_json
    `, params);
    written += slice.length;
  }
  return written;
}

/**
 * Ensure `appstle_subscriptions.appstle_id` has a UNIQUE constraint.
 * The existing schema defines the column but no unique index, so ON CONFLICT (appstle_id)
 * needs a constraint to target. We add it idempotently here.
 */
async function ensureSchema() {
  await pgRun(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename='appstle_subscriptions' AND indexname='ux_appstle_subs_appstle_id'
      ) THEN
        CREATE UNIQUE INDEX ux_appstle_subs_appstle_id
          ON appstle_subscriptions (appstle_id);
      END IF;
    END $$;
  `);
}

/**
 * Main entry — replaces the old syncAppstleSubRevenue.
 * @param {string} startDate  YYYY-MM-DD inclusive
 * @param {string} endDate    YYYY-MM-DD inclusive
 * @param {object} [opts]
 * @param {boolean} [opts.backfillMode]  When true, use customer-first-seen heuristic
 *   for new-vs-rebill classification (correct only when the window covers full sub history).
 */
async function syncNoblAirSubs(startDate, endDate, opts = {}) {
  if (!SHOP || !TOKEN) {
    return { rows: 0, errors: ['Missing NOBL_SHOPIFY_SHOP or NOBL_SHOPIFY_TOKEN'] };
  }
  const errors = [];
  console.log(`[NOBL Air] Sync ${startDate} → ${endDate} (backfill=${!!opts.backfillMode})`);
  await ensureSchema();

  let orders;
  try {
    orders = await fetchSubscriptionOrders(startDate, endDate);
  } catch (e) {
    errors.push('fetch: ' + e.message);
    return { rows: 0, errors };
  }
  console.log(`[NOBL Air] Fetched ${orders.length} candidate orders`);

  const daily = aggregateDaily(orders, opts);
  const subs  = buildSubscribers(orders);
  console.log(`[NOBL Air] ${daily.size} day-rows, ${subs.length} unique subscribers`);

  let dayRows = 0, subRows = 0;
  try { dayRows = await writeDaily(daily); }
  catch (e) { errors.push('writeDaily: ' + e.message); }
  try { subRows = await writeSubscribers(subs); }
  catch (e) { errors.push('writeSubscribers: ' + e.message); }

  return { rows: dayRows + subRows, day_rows: dayRows, sub_rows: subRows, errors };
}

module.exports = { syncNoblAirSubs };
