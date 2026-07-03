/**
 * Ops metrics ETL — JS port of daily_ops_metrics_corrected_join.py.
 *
 *   Reads from the ERP Postgres (erp_maindb):
 *     store.orders_shipment            ← shipped rows, tracking, cost-by-tracking
 *     store.shiphero_live_orders       ← created_at (for fulfillment hours), fulfillment_status
 *     public.shiphero_brand_ids        ← brand_name ⇄ account_id / account_uuid
 *     store.orders_shipment_shipping_label ← per-tracking shipping cost
 *     public.third_party_tokens        ← live UPS bearer token
 *
 *   Reads from the dashboard's NOBL EU + NOBL CA / NOBL AU / FLO CA / FLO AU
 *   Shopify GraphQL admin APIs to compute Canada/Australia TTF (Time-to-Fulfillment)
 *   from order.createdAt → fulfillment.createdAt.
 *
 *   Calls the UPS Tracking API (v1) for ship-to-door delivery time per tracking.
 *
 *   Writes upserts to dashboard.ops_metrics_daily (one row per brand × date in
 *   the requested window). Idempotent. Default is DRY RUN; pass commit:true to
 *   actually write.
 *
 *   Reuses the EXACT business logic from the Python reference:
 *     - per shipment: fulfillment_hours = (shipped_at - live_order.created_at) / 3600
 *       (skip if shipped_at < created_at)
 *     - per order:    avg of the order's shipment fulfillment_hours
 *     - per brand:    avg of those per-order averages
 *     - shipping cost: sum cost-by-tracking across the order's tracking set, then
 *       brand-average those per-order totals
 *     - ship-to-door:  per shipment, hours = (ups_delivered - shipped_at) / 3600
 *       (skip if delivered < shipped); then order-avg → brand-avg
 *
 *   The 7-day rolling window mirrors the Python script. The "for a target day"
 *   call is `runOpsMetrics({ start, end })` where start..end describes the dates
 *   that get UPSERTED (one row per date per brand). For deep backfills, the
 *   caller chunks the window externally — UPS calls per day are the cost driver.
 */
// Load env BEFORE requiring db/postgres (which reads DB_* eagerly).
// If this module is required from server/index.js the env is already loaded;
// dotenv is idempotent so this is a no-op there.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const httpx = require('node:https');
const { erpQuery, endErpPool } = require('../db/erpPostgres');
const { pgQuery } = require('../db/postgres');

// ── Config ───────────────────────────────────────────────────────────────────

const ERP_BRAND_NAMES = ['Flo Pilates', 'Nobl Travel'];
const TO_DASHBOARD_BRAND = { 'Flo Pilates': 'FLO', 'Nobl Travel': 'NOBL' };

// Brand → Shopify stores to ask for regional TTF. Reuses the dashboard's existing
// admin tokens (NOBL main+EU+UK; FLO main+EU). Pass-through API version matches
// the dashboard's other Shopify ETL.
const SHOPIFY_STORES_FOR_BRAND = {
  NOBL: [
    { key: 'NOBL_MAIN', shop: process.env.NOBL_SHOPIFY_SHOP, token: process.env.NOBL_SHOPIFY_TOKEN, apiVersion: '2024-10' },
    { key: 'NOBL_EU',   shop: process.env.NOBL_EU_SHOPIFY_SHOP, token: process.env.NOBL_EU_SHOPIFY_TOKEN, apiVersion: '2024-10' },
    { key: 'NOBL_UK',   shop: process.env.NOBL_UK_SHOPIFY_SHOP, token: process.env.NOBL_UK_SHOPIFY_TOKEN, apiVersion: '2024-10' },
  ],
  FLO: [
    { key: 'FLO_MAIN', shop: process.env.FLO_SHOPIFY_SHOP, token: process.env.FLO_SHOPIFY_TOKEN, apiVersion: '2024-10' },
    { key: 'FLO_EU',   shop: process.env.FLO_EU_SHOPIFY_SHOP, token: process.env.FLO_EU_SHOPIFY_TOKEN, apiVersion: '2024-10' },
  ],
};

const REGION_COUNTRIES = { US: 'United States', CA: 'Canada', AU: 'Australia', UK: 'United Kingdom' };
function normalizeTtfCountry(cc) {
  const c = String(cc || '').toUpperCase().trim();
  if (['GB', 'UK'].includes(c)) return 'UK';
  if (['US', 'CA', 'AU'].includes(c)) return c;
  return null;
}

// UPS concurrency / retry — slightly more conservative than the Python script
// (Python uses 250 in-flight; we cap at 100 to be polite to UPS's rate limiter
// when running from a Node server alongside other ETL).
const UPS_CONCURRENCY = parseInt(process.env.UPS_TRACKING_CONCURRENCY || '100', 10);
const UPS_TIMEOUT_MS  = 15000;
const UPS_MAX_RETRIES = 3;

// ── Small helpers ────────────────────────────────────────────────────────────

const avg = (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const round4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

function toDateStr(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d); }
function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return toDateStr(d); }
function utcMidnight(s) { return new Date(`${s}T00:00:00Z`); }

// ── ERP queries (mirrors the Python's three SQL blocks) ─────────────────────

async function fetchUpsTokenFromErp() {
  const r = await erpQuery(
    `SELECT token_value FROM public.third_party_tokens
      WHERE token_name = 'ups'
      ORDER BY token_inserted_at DESC LIMIT 1`
  );
  if (!r.rows.length) throw new Error("UPS token not found in public.third_party_tokens (token_name='ups')");
  return r.rows[0].token_value;
}

/**
 * Pull every UPS shipment row for both brands in [start, end] (inclusive),
 * joined to live_orders for created_at and brand mapping. Exact join logic from
 * the corrected-join Python (account_uuid OR account_id::text → account_id).
 */
async function fetchShipmentRowsFromErp(start, end) {
  // The DB stores timestamps in UTC. Cast ::date and return YYYY-MM-DD as TEXT
  // so node-postgres doesn't reinterpret the DATE via the JS local TZ and shift
  // it by the JS-process timezone offset.
  const r = await erpQuery(
    `SELECT
        TO_CHAR(os.created_at::date, 'YYYY-MM-DD') AS ship_date,
        os.created_at                              AS shipped_at,
        os.order_number::text                      AS order_number,
        os.tracking_number,
        os.shipping_carrier,
        os.shipping_method,
        b.brand_name,
        lo.created_at                              AS live_order_created_at,
        lo.fulfillment_status                      AS fulfillment_status,
        lo.account_id                              AS shiphero_account_id
     FROM store.orders_shipment os
     JOIN store.shiphero_live_orders lo
       ON lo.order_nodeid = os.order_uuid
     JOIN public.shiphero_brand_ids b
       ON b.account_uuid = lo.account_id
       OR b.account_id::text = lo.account_id
     WHERE os.created_at::date BETWEEN $1::date AND $2::date
       AND b.brand_name = ANY($3)
       AND lower(coalesce(os.shipping_carrier,'')) = 'ups'
       AND coalesce(os.tracking_number,'') <> ''
     ORDER BY b.brand_name, os.order_number::text, os.created_at, os.tracking_number`,
    [start, end, ERP_BRAND_NAMES]
  );
  return r.rows;
}

async function fetchCostByTrackingFromErp(start, end) {
  const r = await erpQuery(
    `SELECT tracking_number, COALESCE(SUM(cost), 0) AS cost
       FROM store.orders_shipment_shipping_label
      WHERE created_at::date BETWEEN $1 AND $2
      GROUP BY tracking_number`,
    [start, end]
  );
  const map = new Map();
  for (const row of r.rows) {
    const tn = row.tracking_number ? String(row.tracking_number).trim() : '';
    if (tn) map.set(tn, Number(row.cost) || 0);
  }
  return map;
}

/**
 * Unfulfilled counts by (brand, date). Date = live_orders.created_at::date,
 * scoped to [start, end]. "Unfulfilled" = fulfillment_status is null or not
 * in {fulfilled, canceled, cancelled}. "Over 24h" = unfulfilled AND
 * NOW() - created_at >= 24h.
 *
 * NOTE: this is a SNAPSHOT — it reflects the current state of those orders
 * (as of when the ETL runs). It's consistent with how the user's spreadsheet
 * tracks the metric ("orders unfulfilled" is read at the time of the report).
 */
async function fetchUnfulfilledCountsFromErp(start, end) {
  const r = await erpQuery(
    `SELECT
        b.brand_name                                    AS brand_name,
        TO_CHAR(lo.created_at::date, 'YYYY-MM-DD')      AS date,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
        )                                               AS unfulfilled,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('US','USA','UNITED STATES','UNITED STATES OF AMERICA')
        )                                               AS us_unfulfilled,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('CA','CANADA')
        )                                               AS ca_unfulfilled,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('AU','AUS','AUSTRALIA')
        )                                               AS au_unfulfilled,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('GB','UK','UNITED KINGDOM')
        )                                               AS uk_unfulfilled,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND NOW() - lo.created_at >= INTERVAL '24 hours'
        )                                               AS unfulfilled_over_24h,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('US','USA','UNITED STATES','UNITED STATES OF AMERICA')
          AND NOW() - lo.created_at >= INTERVAL '24 hours'
        )                                               AS us_unfulfilled_over_24h,
        COUNT(*) FILTER (WHERE
          lower(coalesce(lo.fulfillment_status, '')) NOT IN ('fulfilled','canceled','cancelled')
          AND upper(coalesce(lo.ship_country, '')) IN ('GB','UK','UNITED KINGDOM')
          AND NOW() - lo.created_at >= INTERVAL '24 hours'
        )                                               AS uk_unfulfilled_over_24h
     FROM store.shiphero_live_orders lo
     JOIN public.shiphero_brand_ids b
       ON b.account_uuid = lo.account_id
       OR b.account_id::text = lo.account_id
     WHERE lo.created_at::date BETWEEN $1::date AND $2::date
       AND b.brand_name = ANY($3)
     GROUP BY b.brand_name, lo.created_at::date`,
    [start, end, ERP_BRAND_NAMES]
  );
  const m = new Map(); // key: brand|date → {unfulfilled, unfulfilled_over_24h}
  for (const row of r.rows) {
    const brand = TO_DASHBOARD_BRAND[row.brand_name];
    if (!brand) continue;
    m.set(`${brand}|${row.date}`, {
      unfulfilled: Number(row.unfulfilled) || 0,
      us_unfulfilled: Number(row.us_unfulfilled) || 0,
      ca_unfulfilled: Number(row.ca_unfulfilled) || 0,
      au_unfulfilled: Number(row.au_unfulfilled) || 0,
      uk_unfulfilled: Number(row.uk_unfulfilled) || 0,
      unfulfilled_over_24h: Number(row.unfulfilled_over_24h) || 0,
      us_unfulfilled_over_24h: Number(row.us_unfulfilled_over_24h) || 0,
      uk_unfulfilled_over_24h: Number(row.uk_unfulfilled_over_24h) || 0,
    });
  }
  return m;
}

async function ensureOpsMetricColumns() {
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS ca_orders_unfulfilled INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS au_orders_unfulfilled INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS us_orders_unfulfilled INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS uk_orders_unfulfilled INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS us_orders_unfulfilled_over_24h INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS uk_orders_unfulfilled_over_24h INT DEFAULT 0`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS uk_avg_ttf_days NUMERIC(10,4)`);
  await pgQuery(`ALTER TABLE ops_metrics_daily ADD COLUMN IF NOT EXISTS uk_orders_count INT DEFAULT 0`);
}

// ── UPS Tracking API (mirrors fetch_one_tracking + fetch_all_trackings) ─────

function parseUpsDelivered(payload) {
  try {
    const tr = payload?.trackResponse;
    const shipment = (tr?.shipment || [{}])[0] || {};
    const pkg = (shipment.package || [{}])[0];
    if (!pkg) return null;
    let deliveredYmd = null;
    for (const entry of pkg.deliveryDate || []) {
      if (entry && entry.type === 'DEL') { deliveredYmd = entry.date; break; }
    }
    if (!deliveredYmd) return null;
    const endTime = String(pkg.deliveryTime?.endTime ?? '000000').padEnd(6, '0').slice(0, 6);
    const y = Number(deliveredYmd.slice(0, 4));
    const mo = Number(deliveredYmd.slice(4, 6)) - 1;
    const da = Number(deliveredYmd.slice(6, 8));
    const hh = Number(endTime.slice(0, 2));
    const mm = Number(endTime.slice(2, 4));
    const ss = Number(endTime.slice(4, 6));
    // UPS times are local to the delivery point; treat them as a naïve local
    // timestamp by constructing in UTC. This matches the Python implementation
    // which built a naïve datetime; the comparison vs shipped_at (also naïve
    // local-server time stored as `timestamp without time zone`) then works
    // by subtraction. Both sides use the same convention.
    return new Date(Date.UTC(y, mo, da, hh, mm, ss));
  } catch {
    return null;
  }
}

/**
 * Simple in-process concurrency limiter — no extra dependency.
 * Returns a wrapper that runs at most `limit` of the given thunks concurrently.
 */
function makeLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (!queue.length || active >= limit) return;
    active += 1;
    const { thunk, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(thunk)
      .then((v) => { active -= 1; resolve(v); next(); })
      .catch((e) => { active -= 1; reject(e); next(); });
  };
  return (thunk) => new Promise((resolve, reject) => { queue.push({ thunk, resolve, reject }); next(); });
}

function upsFetch(trackingNumber, token, attempt) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'onlinetools.ups.com',
      port: 443,
      path: `/api/track/v1/details/${encodeURIComponent(trackingNumber)}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        transId: `dashboard-${trackingNumber}-${attempt}`,
        transactionSrc: 'nobl-dashboard',
      },
      timeout: UPS_TIMEOUT_MS,
    };
    const req = httpx.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode || 0;
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ status, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: -1, body: null, error: e.message }));
    req.end();
  });
}

async function fetchAllTrackings(trackings, token) {
  const deliveredByTracking = new Map();
  const statusCounts = {};
  if (!trackings.length) return { deliveredByTracking, statusCounts };
  const limit = makeLimiter(UPS_CONCURRENCY);
  let done = 0;
  await Promise.all(trackings.map((tn) => limit(async () => {
    for (let attempt = 0; attempt < UPS_MAX_RETRIES; attempt += 1) {
      const { status, body } = await upsFetch(tn, token, attempt);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (status === 200) {
        const delivered = parseUpsDelivered(body);
        if (delivered) deliveredByTracking.set(tn, delivered);
        break;
      }
      if (status === 429 || (status >= 500 && status < 600)) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      break; // non-retryable
    }
    done += 1;
    if (done % 500 === 0 || done === trackings.length) {
      console.log(`[OpsMetrics] UPS progress ${done}/${trackings.length}`);
    }
  })));
  return { deliveredByTracking, statusCounts };
}

// ── Shopify CA/AU TTF (mirrors fetch_shopify_store_orders + calculate_shopify_country_ttf) ──

function utcWindowStrings(start, end) {
  const startISO = `${start}T00:00:00Z`;
  const endExcl = `${addDays(end, 1)}T00:00:00Z`;
  return { startISO, endExcl };
}

async function fetchShopifyStoreOrders(store, start, end) {
  if (!store?.shop || !store?.token) return { orders: [], statusCounts: {} };
  const { startISO, endExcl } = utcWindowStrings(start, end);
  const searchQuery = `updated_at:>=${startISO} updated_at:<${endExcl}`;
  const url = `https://${store.shop}/admin/api/${store.apiVersion}/graphql.json`;
  const queryDoc = `query($q: String!, $cursor: String) {
    orders(first: 250, after: $cursor, query: $q, sortKey: UPDATED_AT) {
      edges {
        node {
          name
          createdAt
          updatedAt
          displayFulfillmentStatus
          shippingAddress { country countryCodeV2 province provinceCode }
          fulfillments(first: 20) {
            createdAt
            status
            trackingInfo { number company }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const orders = [];
  const statusCounts = {};
  let cursor = null;
  let pages = 0;
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': store.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryDoc, variables: { q: searchQuery, cursor } }),
    });
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Shopify ${store.key} HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    const body = await res.json();
    if (body.errors) throw new Error(`Shopify ${store.key} GraphQL: ${JSON.stringify(body.errors).slice(0, 500)}`);
    const conn = body.data.orders;
    orders.push(...conn.edges.map((e) => e.node));
    pages += 1;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (pages % 25 === 0) console.log(`[OpsMetrics] Shopify ${store.key} pages=${pages} orders=${orders.length}`);
  }
  return { orders, statusCounts };
}

function calculateShopifyCountryTtf(start, end, ordersByStoreByBrand) {
  const { startISO, endExcl } = utcWindowStrings(start, end);
  const startDt = new Date(startISO);
  const endDt = new Date(endExcl);

  // Indexed: brand → country → orderName → [fulfillmentDays...]
  const byBrandCountryOrder = new Map();

  for (const [brand, storesMap] of ordersByStoreByBrand) {
    for (const [, orders] of storesMap) {
      for (const order of orders) {
        const shipping = order.shippingAddress || {};
        const cc = normalizeTtfCountry(shipping.countryCodeV2 || '');
        if (!cc || !REGION_COUNTRIES[cc]) continue;
        const orderCreatedAt = new Date(order.createdAt);
        for (const ful of order.fulfillments || []) {
          if (ful.status && ful.status !== 'SUCCESS') continue;
          const fulCreatedAt = new Date(ful.createdAt);
          if (!(fulCreatedAt >= startDt && fulCreatedAt < endDt)) continue;
          const days = (fulCreatedAt - orderCreatedAt) / 86400000;
          if (days < 0) continue;
          const orderName = order.name || '';
          const k1 = brand;
          const k2 = cc;
          if (!byBrandCountryOrder.has(k1)) byBrandCountryOrder.set(k1, new Map());
          const lvl1 = byBrandCountryOrder.get(k1);
          if (!lvl1.has(k2)) lvl1.set(k2, new Map());
          const lvl2 = lvl1.get(k2);
          if (!lvl2.has(orderName)) lvl2.set(orderName, []);
          lvl2.get(orderName).push(days);
        }
      }
    }
  }

  // For each (brand, country): average per-order day-counts, then average those.
  const result = new Map(); // brand → country-code → {avg, count}
  for (const brand of ['NOBL', 'FLO']) {
    result.set(brand, {
      US: { avg: null, count: 0 },
      CA: { avg: null, count: 0 },
      AU: { avg: null, count: 0 },
      UK: { avg: null, count: 0 },
    });
    const byCountry = byBrandCountryOrder.get(brand);
    if (!byCountry) continue;
    for (const cc of Object.keys(REGION_COUNTRIES)) {
      const orderMap = byCountry.get(cc);
      if (!orderMap) continue;
      const perOrderAvgs = [];
      for (const [, vals] of orderMap) {
        if (vals.length) perOrderAvgs.push(avg(vals));
      }
      result.get(brand)[cc] = {
        avg: perOrderAvgs.length ? avg(perOrderAvgs) : null,
        count: orderMap.size,
      };
    }
  }
  return result;
}

// ── Metric assembly (mirrors calculate_metrics) ─────────────────────────────

function calculateOpsMetrics({ start, end, shipmentRows, costByTracking, deliveredByTracking, unfulfilledMap, shopifyCountryTtf }) {
  // shipments → by (brand, date)
  const byBrandDate = new Map(); // key: brand|date → { ordersByKey: Map<order,[rows]>, allTrackings: Set, ... }

  for (const row of shipmentRows) {
    const brand = TO_DASHBOARD_BRAND[row.brand_name];
    if (!brand) continue;
    const date = toDateStr(row.ship_date);
    const key = `${brand}|${date}`;
    if (!byBrandDate.has(key)) byBrandDate.set(key, { ordersByKey: new Map(), shipmentsCount: 0 });
    const bucket = byBrandDate.get(key);
    bucket.shipmentsCount += 1;
    const orderKey = row.order_number;
    if (!bucket.ordersByKey.has(orderKey)) bucket.ordersByKey.set(orderKey, []);
    bucket.ordersByKey.get(orderKey).push(row);
  }

  const rows = [];
  // Ensure both brands × every date in the range get a row (empty if no data),
  // so the matrix is dense per the user's "no missing/null/0" expectation:
  // we WRITE the row when there's data; we OMIT it when there isn't, so the
  // endpoint reads NULL instead of a misleading 0.
  for (const [key, bucket] of byBrandDate) {
    const [brand, date] = key.split('|');
    const orderFulfillmentHours = [];
    const orderShippingCosts = [];
    const orderShipToDoorHours = [];
    let ordersWithDelivery = 0;
    for (const [, orderShipments] of bucket.ordersByKey) {
      const fulVals = [];
      const transitVals = [];
      const trackingSet = new Set();
      for (const s of orderShipments) {
        const shippedAt = new Date(s.shipped_at);
        const createdAt = s.live_order_created_at ? new Date(s.live_order_created_at) : null;
        const tn = String(s.tracking_number).trim();
        if (createdAt && shippedAt >= createdAt) {
          fulVals.push((shippedAt - createdAt) / 3600000);
        }
        trackingSet.add(tn);
        const delivered = deliveredByTracking.get(tn);
        if (delivered && delivered >= shippedAt) {
          transitVals.push((delivered - shippedAt) / 3600000);
        }
      }
      const fulAvg = avg(fulVals);
      const cost = [...trackingSet].reduce((s, tn) => s + (costByTracking.get(tn) || 0), 0);
      const ttdAvg = avg(transitVals);
      if (fulAvg != null) orderFulfillmentHours.push(fulAvg);
      orderShippingCosts.push(cost);
      if (ttdAvg != null) { orderShipToDoorHours.push(ttdAvg); ordersWithDelivery += 1; }
    }

    const unfMap = unfulfilledMap.get(key) || { unfulfilled: 0, us_unfulfilled: 0, ca_unfulfilled: 0, au_unfulfilled: 0, uk_unfulfilled: 0, unfulfilled_over_24h: 0, us_unfulfilled_over_24h: 0, uk_unfulfilled_over_24h: 0 };
    const ttf = shopifyCountryTtf.get(brand) || { US: { avg: null, count: 0 }, CA: { avg: null, count: 0 }, AU: { avg: null, count: 0 }, UK: { avg: null, count: 0 } };

    rows.push({
      brand,
      date,
      shipments_count: bucket.shipmentsCount,
      orders_count: bucket.ordersByKey.size,
      orders_with_ups_delivery: ordersWithDelivery,
      orders_unfulfilled: unfMap.unfulfilled,
      us_orders_unfulfilled: unfMap.us_unfulfilled,
      ca_orders_unfulfilled: unfMap.ca_unfulfilled,
      au_orders_unfulfilled: unfMap.au_unfulfilled,
      uk_orders_unfulfilled: unfMap.uk_unfulfilled,
      orders_unfulfilled_over_24h: unfMap.unfulfilled_over_24h,
      us_orders_unfulfilled_over_24h: unfMap.us_unfulfilled_over_24h,
      uk_orders_unfulfilled_over_24h: unfMap.uk_unfulfilled_over_24h,
      avg_fulfillment_hours: round2(avg(orderFulfillmentHours)),
      avg_ship_to_door_hours: round2(avg(orderShipToDoorHours)),
      avg_shipping_cost_per_order: round2(avg(orderShippingCosts)),
      ca_avg_ttf_days: round4(ttf.CA.avg),
      ca_orders_count: ttf.CA.count,
      au_avg_ttf_days: round4(ttf.AU.avg),
      au_orders_count: ttf.AU.count,
      uk_avg_ttf_days: round4(ttf.UK.avg),
      uk_orders_count: ttf.UK.count,
    });
  }

  // Also add brand×date rows for dates where there were NO shipments but
  // unfulfilled-orders data exists (covers FLO low-volume days etc.). We
  // never invent shipping/fulfillment averages — they stay NULL.
  for (const [key, unf] of unfulfilledMap) {
    if (byBrandDate.has(key)) continue;
    const [brand, date] = key.split('|');
    const ttf = shopifyCountryTtf.get(brand) || { US: { avg: null, count: 0 }, CA: { avg: null, count: 0 }, AU: { avg: null, count: 0 }, UK: { avg: null, count: 0 } };
    rows.push({
      brand, date,
      shipments_count: 0, orders_count: 0, orders_with_ups_delivery: 0,
      orders_unfulfilled: unf.unfulfilled,
      us_orders_unfulfilled: unf.us_unfulfilled || 0,
      ca_orders_unfulfilled: unf.ca_unfulfilled || 0,
      au_orders_unfulfilled: unf.au_unfulfilled || 0,
      uk_orders_unfulfilled: unf.uk_unfulfilled || 0,
      orders_unfulfilled_over_24h: unf.unfulfilled_over_24h,
      us_orders_unfulfilled_over_24h: unf.us_unfulfilled_over_24h || 0,
      uk_orders_unfulfilled_over_24h: unf.uk_unfulfilled_over_24h || 0,
      avg_fulfillment_hours: null, avg_ship_to_door_hours: null, avg_shipping_cost_per_order: null,
      ca_avg_ttf_days: round4(ttf.CA.avg), ca_orders_count: ttf.CA.count,
      au_avg_ttf_days: round4(ttf.AU.avg), au_orders_count: ttf.AU.count,
      uk_avg_ttf_days: round4(ttf.UK.avg), uk_orders_count: ttf.UK.count,
    });
  }

  return rows;
}

// ── Upsert ───────────────────────────────────────────────────────────────────

async function upsertRows(rows, statusCounts) {
  if (!rows.length) return { written: 0 };
  await ensureOpsMetricColumns();
  let written = 0;
  for (const r of rows) {
    await pgQuery(
      `INSERT INTO ops_metrics_daily
        (brand, date,
         shipments_count, orders_count, orders_with_ups_delivery,
           orders_unfulfilled, us_orders_unfulfilled, ca_orders_unfulfilled, au_orders_unfulfilled, uk_orders_unfulfilled,
           orders_unfulfilled_over_24h, us_orders_unfulfilled_over_24h, uk_orders_unfulfilled_over_24h,
           avg_fulfillment_hours, avg_ship_to_door_hours, avg_shipping_cost_per_order,
           ca_avg_ttf_days, ca_orders_count, au_avg_ttf_days, au_orders_count, uk_avg_ttf_days, uk_orders_count,
           ups_status_counts, source, computed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,NOW(),NOW())
       ON CONFLICT (brand, date) DO UPDATE SET
         shipments_count             = EXCLUDED.shipments_count,
         orders_count                = EXCLUDED.orders_count,
         orders_with_ups_delivery    = EXCLUDED.orders_with_ups_delivery,
          orders_unfulfilled          = EXCLUDED.orders_unfulfilled,
          us_orders_unfulfilled       = EXCLUDED.us_orders_unfulfilled,
          ca_orders_unfulfilled       = EXCLUDED.ca_orders_unfulfilled,
          au_orders_unfulfilled       = EXCLUDED.au_orders_unfulfilled,
          uk_orders_unfulfilled       = EXCLUDED.uk_orders_unfulfilled,
          orders_unfulfilled_over_24h = EXCLUDED.orders_unfulfilled_over_24h,
          us_orders_unfulfilled_over_24h = EXCLUDED.us_orders_unfulfilled_over_24h,
          uk_orders_unfulfilled_over_24h = EXCLUDED.uk_orders_unfulfilled_over_24h,
         avg_fulfillment_hours       = EXCLUDED.avg_fulfillment_hours,
         avg_ship_to_door_hours      = EXCLUDED.avg_ship_to_door_hours,
         avg_shipping_cost_per_order = EXCLUDED.avg_shipping_cost_per_order,
         ca_avg_ttf_days             = EXCLUDED.ca_avg_ttf_days,
         ca_orders_count             = EXCLUDED.ca_orders_count,
         au_avg_ttf_days             = EXCLUDED.au_avg_ttf_days,
         au_orders_count             = EXCLUDED.au_orders_count,
          uk_avg_ttf_days             = EXCLUDED.uk_avg_ttf_days,
          uk_orders_count             = EXCLUDED.uk_orders_count,
         ups_status_counts           = EXCLUDED.ups_status_counts,
         source                      = EXCLUDED.source,
         updated_at                  = NOW()`,
      [
        r.brand, r.date,
        r.shipments_count, r.orders_count, r.orders_with_ups_delivery,
        r.orders_unfulfilled, r.us_orders_unfulfilled || 0, r.ca_orders_unfulfilled || 0, r.au_orders_unfulfilled || 0, r.uk_orders_unfulfilled || 0,
        r.orders_unfulfilled_over_24h, r.us_orders_unfulfilled_over_24h || 0, r.uk_orders_unfulfilled_over_24h || 0,
        r.avg_fulfillment_hours, r.avg_ship_to_door_hours, r.avg_shipping_cost_per_order,
        r.ca_avg_ttf_days, r.ca_orders_count, r.au_avg_ttf_days, r.au_orders_count, r.uk_avg_ttf_days, r.uk_orders_count,
        JSON.stringify(statusCounts || {}), 'erp_maindb',
      ]
    );
    written += 1;
  }
  return { written };
}

// ── Top-level entry ─────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.start  YYYY-MM-DD (inclusive)
 * @param {string} opts.end    YYYY-MM-DD (inclusive)
 * @param {boolean} [opts.commit=false]     Set true to persist; otherwise dry-run.
 * @param {boolean} [opts.skipUps=false]    Skip UPS API (ship-to-door will be NULL).
 * @param {boolean} [opts.skipShopify=false] Skip Shopify CA/AU TTF (those fields will be NULL).
 */
async function runOpsMetrics(opts = {}) {
  const start = opts.start;
  const end = opts.end || start;
  if (!start || !end) throw new Error('runOpsMetrics: start and end (YYYY-MM-DD) are required');
  const commit = Boolean(opts.commit);
  const skipUps = Boolean(opts.skipUps);
  const skipShopify = Boolean(opts.skipShopify);
  const t0 = Date.now();

  console.log(`[OpsMetrics] ▶ ${start} → ${end} | commit=${commit} skipUps=${skipUps} skipShopify=${skipShopify}`);

  // 1) ERP — UPS token + shipments + costs + unfulfilled
  const upsToken = skipUps ? null : await fetchUpsTokenFromErp();
  const [shipmentRows, costByTracking, unfulfilledMap] = await Promise.all([
    fetchShipmentRowsFromErp(start, end),
    fetchCostByTrackingFromErp(start, end),
    fetchUnfulfilledCountsFromErp(start, end),
  ]);
  console.log(`[OpsMetrics] ERP: shipments=${shipmentRows.length} costRows=${costByTracking.size} unfulfilledKeys=${unfulfilledMap.size}`);

  // 2) UPS deliveries (rate-limited)
  let deliveredByTracking = new Map(), statusCounts = {};
  if (!skipUps && shipmentRows.length) {
    const trackings = [...new Set(shipmentRows.map((r) => String(r.tracking_number).trim()).filter(Boolean))].sort();
    console.log(`[OpsMetrics] UPS: ${trackings.length} unique trackings @ concurrency ${UPS_CONCURRENCY}`);
    const out = await fetchAllTrackings(trackings, upsToken);
    deliveredByTracking = out.deliveredByTracking;
    statusCounts = out.statusCounts;
    console.log('[OpsMetrics] UPS status counts:', statusCounts, '→', deliveredByTracking.size, 'delivered');
  }

  // 3) Shopify CA/AU TTF
  let shopifyCountryTtf = new Map();
  if (!skipShopify) {
    const ordersByBrand = new Map();
    for (const brand of Object.keys(SHOPIFY_STORES_FOR_BRAND)) {
      ordersByBrand.set(brand, new Map());
      for (const store of SHOPIFY_STORES_FOR_BRAND[brand]) {
        if (!store.shop || !store.token) continue;
        try {
          const { orders } = await fetchShopifyStoreOrders(store, start, end);
          ordersByBrand.get(brand).set(store.key, orders);
          console.log(`[OpsMetrics] Shopify ${store.key} (${brand}): ${orders.length} orders`);
        } catch (e) {
          console.warn(`[OpsMetrics] Shopify ${store.key} (${brand}) failed: ${e.message}`);
        }
      }
    }
    shopifyCountryTtf = calculateShopifyCountryTtf(start, end, ordersByBrand);
  }

  // 4) Build per-brand-per-date rows
  const rows = calculateOpsMetrics({
    start, end,
    shipmentRows, costByTracking, deliveredByTracking, unfulfilledMap, shopifyCountryTtf,
  });
  console.log(`[OpsMetrics] computed ${rows.length} brand×date rows`);

  // 5) Persist if asked
  let written = 0;
  if (commit) {
    const out = await upsertRows(rows, statusCounts);
    written = out.written;
    console.log(`[OpsMetrics] upserted ${written} rows`);
  } else {
    console.log('[OpsMetrics] DRY RUN — pass --commit (or commit:true) to write');
    console.log('[OpsMetrics] sample rows:', JSON.stringify(rows.slice(0, 5), null, 2));
  }

  const duration = Date.now() - t0;
  console.log(`[OpsMetrics] ✓ done in ${(duration / 1000).toFixed(1)}s | rows=${rows.length} written=${written}`);
  return { rows: written, dryRunRows: rows.length, written, durationMs: duration, statusCounts };
}

module.exports = { runOpsMetrics };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const dates = argv.filter((a) => !a.startsWith('--'));
  const start = dates[0];
  const end = dates[1] || dates[0];
  if (!start) {
    console.error('Usage: node server/etl/syncOpsMetrics.js <start> [end] [--commit] [--skip-ups] [--skip-shopify]');
    process.exit(1);
  }
  runOpsMetrics({
    start, end,
    commit: flags.has('--commit'),
    skipUps: flags.has('--skip-ups'),
    skipShopify: flags.has('--skip-shopify'),
  })
    .then(() => endErpPool())
    .then(() => process.exit(0))
    .catch((e) => { console.error('[OpsMetrics] FAILED:', e.message); process.exit(1); });
}
