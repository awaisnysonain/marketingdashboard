/**
 * Appstle subscription contracts ETL.
 * Endpoint per the technical doc:
 *   GET subscription-admin.appstle.com/api/external/v2/subscription-contract-details
 *   ?page=N&size=2000&sort=created_at,desc
 *   Header: X-API-Key
 *
 * Pulls all subscription contracts (not just rebills, not just first orders).
 * Stores in nobl_air_subscribers with contract_amount (the tier — $79/$99/etc).
 *
 * Idempotent: re-running fetches all pages and upserts, refreshing TTP/maturity flags.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pgQuery } = require('../db/postgres');
const { syncFloAppstleRevenueFullRange, ensureFloAppstleRevenueTable } = require('./floAppstleRevenue');

const DEFAULT_APPSTLE_BASE_URL = 'https://subscription-admin.appstle.com';
const PAGE_SIZE = 2000;
const TRIAL_DAYS = 14; // per the doc
const BILLING_ATTEMPT_PAGE_SIZE = 200;
const BILLING_ATTEMPT_CONCURRENCY = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeAppstleBaseUrl(url) {
  return String(url || DEFAULT_APPSTLE_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/external\/v2$/, '')
    .replace(/\/api\/v1$/, '');
}

function contractsBaseUrl(url) {
  return `${normalizeAppstleBaseUrl(url)}/api/external/v2`;
}

function billingAttemptsBaseUrl(url) {
  return `${normalizeAppstleBaseUrl(url)}/api/v1`;
}

const TABLES = new Set(['nobl_air_subscribers', 'flo_appstle_subscribers']);

function assertTable(tableName) {
  if (!TABLES.has(tableName)) throw new Error(`Unsupported Appstle table: ${tableName}`);
}

async function ensureFloTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS flo_appstle_subscribers (
      appstle_id TEXT PRIMARY KEY,
      graph_subscription_contract_id TEXT,
      subscription_contract_id TEXT,
      customer_id TEXT,
      customer_email TEXT,
      customer_name TEXT,
      order_name TEXT,
      graph_order_id TEXT,
      status TEXT,
      contract_amount NUMERIC(14,4),
      order_amount NUMERIC(14,4),
      billing_policy_interval TEXT,
      billing_policy_interval_count INT,
      currency_code TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      next_billing_date TIMESTAMPTZ,
      last_billing_date TIMESTAMPTZ,
      cancelled_on TIMESTAMPTZ,
      is_mature BOOLEAN DEFAULT FALSE,
      is_converted BOOLEAN DEFAULT FALSE,
      is_same_day_cancel BOOLEAN DEFAULT FALSE,
      raw_json JSONB,
      etl_fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_created_at ON flo_appstle_subscribers (created_at)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_order_name ON flo_appstle_subscribers (order_name)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_status ON flo_appstle_subscribers (status)`);
}

async function ensureFloBillingAttemptsTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS flo_appstle_billing_attempts (
      subscription_appstle_id TEXT NOT NULL,
      attempt_key TEXT NOT NULL,
      attempt_id TEXT,
      order_id TEXT,
      order_name TEXT,
      attempt_status TEXT,
      attempt_date TIMESTAMPTZ,
      amount NUMERIC(14,4),
      currency_code TEXT,
      is_successful BOOLEAN DEFAULT FALSE,
      is_initial_order BOOLEAN DEFAULT FALSE,
      raw_json JSONB,
      etl_fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (subscription_appstle_id, attempt_key)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_date ON flo_appstle_billing_attempts (attempt_date)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_success ON flo_appstle_billing_attempts (is_successful, is_initial_order, attempt_date)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_order_id ON flo_appstle_billing_attempts (order_id)`);
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toUtcDateOnly(value) {
  const ts = toIsoTimestamp(value);
  return ts ? ts.slice(0, 10) : null;
}

function toComparableId(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digits = raw.match(/(\d+)(?!.*\d)/);
  return digits ? digits[1] : raw.toLowerCase();
}

function toComparableOrderName(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().replace(/\s+/g, '').toUpperCase() || null;
}

function toBooleanOrNull(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return null;
}

function isSuccessfulStatus(status) {
  if (!status) return false;
  const s = String(status).trim().toLowerCase();
  if (!s) return false;
  if (/(fail|declin|error|pending|skip|cancel|refund|void|expired)/.test(s)) return false;
  return /(success|paid|complete|charg|bill|process)/.test(s);
}

function extractBillingAttempts(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['billingAttempts', 'billing_attempts', 'data', 'items', 'results', 'content']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    for (const key of ['billingAttempts', 'billing_attempts', 'items', 'results', 'content']) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

function hasMoreBillingAttemptPages(payload, page, pageSize, rowsInPage) {
  if (Array.isArray(payload)) return rowsInPage === pageSize;
  const totalPages = parseInt(payload?.totalPages || payload?.total_pages || payload?.pages || '0', 10);
  if (Number.isFinite(totalPages) && totalPages > 0) return page < totalPages;
  const totalCount = parseInt(payload?.totalCount || payload?.total_count || payload?.count || '0', 10);
  if (Number.isFinite(totalCount) && totalCount > 0) return page * pageSize < totalCount;
  return rowsInPage === pageSize;
}

async function fetchBillingAttemptsPage(subscriptionId, apiKey, shopDomain, page, baseUrl) {
  const url = `${billingAttemptsBaseUrl(baseUrl)}/subscription/${subscriptionId}/billing-attempts?page=${page}&limit=${BILLING_ATTEMPT_PAGE_SIZE}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      const headers = {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      };
      if (shopDomain) headers['X-Shopify-Domain'] = shopDomain;
      res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      if (attempt === 4) {
        const detail = e?.cause?.message || e?.cause?.code;
        throw new Error(detail ? `${e.message} (${detail})` : e.message);
      }
      await sleep(1500 * attempt);
      continue;
    }

    if (res.status === 404) return [];
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 4) {
        const text = await res.text().catch(() => '');
        throw new Error(`billing-attempts HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      await sleep(1500 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`billing-attempts HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error('billing-attempt retries exhausted');
}

async function fetchAllBillingAttempts(subscriptionId, apiKey, shopDomain, baseUrl) {
  const attempts = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await fetchBillingAttemptsPage(subscriptionId, apiKey, shopDomain, page, baseUrl);
    const rows = extractBillingAttempts(payload);
    if (!rows.length) break;
    attempts.push(...rows);
    if (!hasMoreBillingAttemptPages(payload, page, BILLING_ATTEMPT_PAGE_SIZE, rows.length)) break;
    await sleep(250);
  }
  return attempts;
}

function normalizeBillingAttempt(rawAttempt, contract) {
  if (!rawAttempt || typeof rawAttempt !== 'object') return null;

  const attemptId = pickFirst(
    rawAttempt.id,
    rawAttempt.billingAttemptId,
    rawAttempt.attemptId,
    rawAttempt.transactionId,
    rawAttempt.chargeId,
    rawAttempt.paymentId
  );
  const orderId = pickFirst(
    rawAttempt.orderId,
    rawAttempt.order_id,
    rawAttempt.shopifyOrderId,
    rawAttempt.billingOrderId,
    rawAttempt.order?.id
  );
  const orderName = pickFirst(
    rawAttempt.orderName,
    rawAttempt.order_name,
    rawAttempt.shopifyOrderName,
    rawAttempt.order?.name
  );
  const status = pickFirst(
    rawAttempt.status,
    rawAttempt.billingStatus,
    rawAttempt.paymentStatus,
    rawAttempt.chargeStatus,
    rawAttempt.attemptStatus,
    rawAttempt.state
  );
  const attemptDate = pickFirst(
    toIsoTimestamp(rawAttempt.orderDate),
    toIsoTimestamp(rawAttempt.billingDate),
    toIsoTimestamp(rawAttempt.processedAt),
    toIsoTimestamp(rawAttempt.processedDate),
    toIsoTimestamp(rawAttempt.attemptDate),
    toIsoTimestamp(rawAttempt.transactionDate),
    toIsoTimestamp(rawAttempt.chargeDate),
    toIsoTimestamp(rawAttempt.createdAt),
    toIsoTimestamp(rawAttempt.updatedAt)
  );
  const amount = pickFirst(
    toFiniteNumber(rawAttempt.orderAmount),
    toFiniteNumber(rawAttempt.amount),
    toFiniteNumber(rawAttempt.billingAmount),
    toFiniteNumber(rawAttempt.chargeAmount),
    toFiniteNumber(rawAttempt.order?.amount),
    toFiniteNumber(rawAttempt.orderAmountShop),
    toFiniteNumber(rawAttempt.orderAmountUSD)
  );

  if (!attemptDate) return null;

  const explicitSuccess = pickFirst(
    toBooleanOrNull(rawAttempt.isSuccessful),
    toBooleanOrNull(rawAttempt.successful),
    toBooleanOrNull(rawAttempt.success),
    toBooleanOrNull(rawAttempt.isSuccess),
    toBooleanOrNull(rawAttempt.paid)
  );
  const isSuccessful = explicitSuccess !== null
    ? explicitSuccess
    : (isSuccessfulStatus(status) || (!!attemptDate && amount !== null && amount > 0 && !!pickFirst(orderId, orderName)));

  const attemptOrderId = toComparableId(orderId);
  const contractOrderId = toComparableId(pickFirst(contract.original_order_id, contract.graph_order_id));
  const attemptOrderName = toComparableOrderName(orderName);
  const contractOrderName = toComparableOrderName(contract.order_name);
  const attemptDateOnly = toUtcDateOnly(attemptDate);
  const createdDateOnly = toUtcDateOnly(contract.created_at);
  const contractOrderAmount = toFiniteNumber(contract.order_amount);

  let isInitialOrder = false;
  if (attemptOrderId && contractOrderId && attemptOrderId === contractOrderId) isInitialOrder = true;
  if (attemptOrderName && contractOrderName && attemptOrderName === contractOrderName) isInitialOrder = true;
  if (!isInitialOrder && attemptDateOnly && createdDateOnly && attemptDateOnly === createdDateOnly && amount !== null && contractOrderAmount !== null) {
    isInitialOrder = Math.abs(amount - contractOrderAmount) < 0.01;
  }

  const attemptKey = String(pickFirst(
    attemptId,
    attemptOrderId && attemptDate ? `${attemptOrderId}|${attemptDate}` : null,
    attemptOrderName && attemptDate ? `${attemptOrderName}|${attemptDate}` : null,
    `${attemptDate}|${amount !== null ? amount.toFixed(4) : 'na'}|${String(status || 'na').toLowerCase()}`
  ));

  return {
    subscription_appstle_id: String(contract.appstle_id),
    attempt_key: attemptKey,
    attempt_id: attemptId != null ? String(attemptId) : null,
    order_id: orderId != null ? String(orderId) : null,
    order_name: orderName != null ? String(orderName) : null,
    attempt_status: status != null ? String(status) : null,
    attempt_date: attemptDate,
    amount,
    currency_code: pickFirst(rawAttempt.currencyCode, rawAttempt.currency, contract.currency_code),
    is_successful: !!isSuccessful,
    is_initial_order: !!isInitialOrder,
    raw_json: JSON.stringify(rawAttempt),
  };
}

async function writeBillingAttemptBatch(attempts) {
  if (!attempts.length) return 0;
  const CHUNK = 250;
  let written = 0;
  for (let i = 0; i < attempts.length; i += CHUNK) {
    const slice = attempts.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let p = 1;
    for (const a of slice) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,NOW())`);
      params.push(
        a.subscription_appstle_id,
        a.attempt_key,
        a.attempt_id,
        a.order_id,
        a.order_name,
        a.attempt_status,
        a.attempt_date,
        a.amount,
        a.currency_code,
        a.is_successful,
        a.is_initial_order,
        a.raw_json,
      );
    }
    await pgRun(`
      INSERT INTO flo_appstle_billing_attempts (
        subscription_appstle_id, attempt_key, attempt_id, order_id, order_name,
        attempt_status, attempt_date, amount, currency_code,
        is_successful, is_initial_order, raw_json, etl_fetched_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (subscription_appstle_id, attempt_key) DO UPDATE SET
        attempt_id       = EXCLUDED.attempt_id,
        order_id         = EXCLUDED.order_id,
        order_name       = EXCLUDED.order_name,
        attempt_status   = EXCLUDED.attempt_status,
        attempt_date     = EXCLUDED.attempt_date,
        amount           = EXCLUDED.amount,
        currency_code    = EXCLUDED.currency_code,
        is_successful    = EXCLUDED.is_successful,
        is_initial_order = EXCLUDED.is_initial_order,
        raw_json         = EXCLUDED.raw_json,
        etl_fetched_at   = NOW()
    `, params);
    written += slice.length;
  }
  return written;
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length || 0) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

async function fetchPage(page, apiKey, baseUrl) {
  // Per the technical doc: ?sort=created_at,asc (snake_case)
  const url = `${contractsBaseUrl(baseUrl)}/subscription-contract-details?page=${page}&size=${PAGE_SIZE}&sort=created_at,asc`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * attempt); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * attempt); continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      throw new Error(`Appstle HTTP ${res.status}: ${t.slice(0,200)}`);
    }
    const total = parseInt(res.headers.get('x-total-count') || '0', 10);
    const data  = await res.json();
    return { data, total };
  }
  throw new Error('Appstle retries exhausted');
}

function computeFlags(contract) {
  const now = Date.now();
  const created = contract.createdAt ? new Date(contract.createdAt).getTime() : null;

  // Appstle frequently leaves `lastBillingDate` null and instead records the most
  // recent paid event under `lastSuccessfulOrder` (a stringified or nested object).
  let lastSuccess = contract.lastSuccessfulOrder;
  if (typeof lastSuccess === 'string') {
    try { lastSuccess = JSON.parse(lastSuccess); } catch { lastSuccess = null; }
  }
  const successAmount = toFiniteNumber(lastSuccess?.orderAmount) || 0;
  const lastSuccessDate = lastSuccess?.orderDate ? new Date(lastSuccess.orderDate).getTime() : null;
  const contractBillingDate = contract.lastBillingDate ? new Date(contract.lastBillingDate).getTime() : null;
  const successDate = successAmount > 0 && lastSuccessDate
    ? lastSuccessDate
    : contractBillingDate;

  const cancelled = contract.cancelledOn ? new Date(contract.cancelledOn).getTime() : null;

  const isMature = created !== null && (now - created) >= TRIAL_DAYS * 86400 * 1000;
  // Converted = a paid billing event after trial creation.
  const isConverted = created !== null && successDate !== null && successDate > created;
  // Same-day cancel = cancelled within 24h of creation (still a useful churn signal)
  const isSameDayCancel = (cancelled && created) ? ((cancelled - created) <= 86400 * 1000) : false;

  return {
    isMature,
    isConverted,
    isSameDayCancel,
    lastBillingDate: successDate ? new Date(successDate).toISOString() : null,
  };
}

async function writeBatch(contracts, tableName) {
  if (contracts.length === 0) return 0;
  assertTable(tableName);
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < contracts.length; i += CHUNK) {
    const slice = contracts.slice(i, i + CHUNK);
    const values = []; const params = []; let p = 1;
    for (const c of slice) {
      const flags = computeFlags(c);
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb,NOW())`);
      params.push(
        String(c.id),
        c.graphSubscriptionContractId || null,
        c.subscriptionContractId || null,
        c.customerId ? String(c.customerId) : null,
        c.customerEmail || null,
        c.customerName || null,
        c.orderName || null,
        c.graphOrderId || null,
        c.status || null,
        c.contractAmount != null ? Number(c.contractAmount) : null,
        c.orderAmount    != null ? Number(c.orderAmount)    : null,
        c.billingPolicyInterval || null,
        c.billingPolicyIntervalCount || null,
        c.currencyCode || null,
        c.createdAt || null,
        c.updatedAt || null,
        c.startsAt || null,
        c.endsAt || null,
        c.nextBillingDate || null,
        c.lastBillingDate || flags.lastBillingDate,
        c.cancelledOn || null,
        flags.isMature,
        flags.isConverted,
        flags.isSameDayCancel,
        JSON.stringify(c),
      );
    }
    await pgRun(`
      INSERT INTO ${tableName} (
        appstle_id, graph_subscription_contract_id, subscription_contract_id,
        customer_id, customer_email, customer_name,
        order_name, graph_order_id,
        status, contract_amount, order_amount,
        billing_policy_interval, billing_policy_interval_count, currency_code,
        created_at, updated_at, starts_at, ends_at,
        next_billing_date, last_billing_date, cancelled_on,
        is_mature, is_converted, is_same_day_cancel,
        raw_json, etl_fetched_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (appstle_id) DO UPDATE SET
        status                = EXCLUDED.status,
        contract_amount       = EXCLUDED.contract_amount,
        order_amount          = EXCLUDED.order_amount,
        next_billing_date     = EXCLUDED.next_billing_date,
        last_billing_date     = EXCLUDED.last_billing_date,
        cancelled_on          = EXCLUDED.cancelled_on,
        ends_at               = EXCLUDED.ends_at,
        updated_at            = EXCLUDED.updated_at,
        is_mature             = EXCLUDED.is_mature,
        is_converted          = EXCLUDED.is_converted,
        is_same_day_cancel    = EXCLUDED.is_same_day_cancel,
        raw_json              = EXCLUDED.raw_json,
        etl_fetched_at        = NOW()
    `, params);
    written += slice.length;
  }
  return written;
}

async function syncAppstleContracts(options = {}) {
  const brand = options.brand || 'NOBL';
  const apiKey = options.apiKey || process.env.APPSTLE_API_KEY;
  const tableName = options.tableName || 'nobl_air_subscribers';
  const baseUrl = normalizeAppstleBaseUrl(options.baseUrl || process.env.APPSTLE_BASE_URL || DEFAULT_APPSTLE_BASE_URL);
  assertTable(tableName);
  if (tableName === 'flo_appstle_subscribers') await ensureFloTable();

  if (!apiKey) {
    return { rows: 0, errors: [`Missing ${brand === 'FLO' ? 'FLO_APPSTLE_API_KEY' : 'APPSTLE_API_KEY'}`] };
  }
  console.log(`[Appstle ${brand}] Fetching all subscription contracts...`);
  const errors = [];
  let page = 0, written = 0, total = null;
  while (true) {
    let r;
    try { r = await fetchPage(page, apiKey, baseUrl); }
    catch (e) { errors.push(`page ${page}: ${e.message}`); break; }
    if (total === null) {
      total = r.total;
      console.log(`[Appstle ${brand}] Total contracts: ${total}`);
    }
    if (!Array.isArray(r.data) || r.data.length === 0) break;
    written += await writeBatch(r.data, tableName);
    console.log(`[Appstle ${brand}] page ${page}: +${r.data.length} (cumulative ${written}/${total})`);
    if (page * PAGE_SIZE + r.data.length >= total) break;
    page++;
    await sleep(500);
    if (page > 50) { console.warn(`[Appstle ${brand}] page cap`); break; }
  }
  return { rows: written, errors, total };
}

async function syncFloBillingAttempts(options = {}) {
  const apiKey = options.apiKey || process.env.FLO_APPSTLE_API_KEY;
  const baseUrl = normalizeAppstleBaseUrl(options.baseUrl || process.env.FLO_APPSTLE_BASE_URL || process.env.APPSTLE_BASE_URL || DEFAULT_APPSTLE_BASE_URL);
  const defaultShopDomain = options.shopDomain || process.env.FLO_SHOPIFY_SHOP || process.env.FLO_APPSTLE_SHOP || process.env.APPSTLE_SHOP || null;
  const subscriptionId = options.subscriptionId ? String(options.subscriptionId) : null;
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10)) : null;
  await ensureFloTable();
  await ensureFloBillingAttemptsTable();

  if (!apiKey) {
    return { rows: 0, errors: ['Missing FLO_APPSTLE_API_KEY'] };
  }

  const subsRes = await pgQuery(`
    SELECT
      appstle_id,
      order_name,
      graph_order_id,
      order_amount,
      currency_code,
      created_at,
      raw_json->>'orderId' AS original_order_id,
      COALESCE($1, NULLIF(raw_json->>'shop', '')) AS shop_domain
    FROM flo_appstle_subscribers
    WHERE appstle_id IS NOT NULL
      AND ($2::text IS NULL OR appstle_id = $2::text)
    ORDER BY created_at ASC NULLS LAST
    LIMIT COALESCE($3::int, 1000000000)
  `, [defaultShopDomain, subscriptionId, limit]);

  const subscriptions = subsRes.rows;
  const errors = [];
  let written = 0;

  console.log(`[Appstle FLO] Syncing billing attempts for ${subscriptions.length} subscriptions...`);

  await runWithConcurrency(subscriptions, BILLING_ATTEMPT_CONCURRENCY, async (subscription, idx) => {
    try {
      const attempts = await fetchAllBillingAttempts(subscription.appstle_id, apiKey, subscription.shop_domain || defaultShopDomain, baseUrl);
      const normalized = attempts
        .map(attempt => normalizeBillingAttempt(attempt, subscription))
        .filter(Boolean);
      written += await writeBillingAttemptBatch(normalized);
      if ((idx + 1) % 100 === 0 || idx === subscriptions.length - 1) {
        console.log(`[Appstle FLO] billing attempts ${idx + 1}/${subscriptions.length}`);
      }
    } catch (e) {
      errors.push(`billing_attempts ${subscription.appstle_id}: ${e.message}`);
    }
  });

  console.log(`[Appstle FLO] Billing attempts sync complete: ${written} upserts, ${errors.length} errors`);
  return { rows: written, errors, subscriptions: subscriptions.length };
}

async function syncFloAppstleContracts() {
  await ensureFloAppstleRevenueTable();
  const contracts = await syncAppstleContracts({
    brand: 'FLO',
    apiKey: process.env.FLO_APPSTLE_API_KEY,
    baseUrl: process.env.FLO_APPSTLE_BASE_URL || process.env.APPSTLE_BASE_URL || DEFAULT_APPSTLE_BASE_URL,
    tableName: 'flo_appstle_subscribers',
  });
  const shouldSyncBillingAttempts = String(process.env.FLO_APPSTLE_SYNC_BILLING_ATTEMPTS || '').toLowerCase() === 'true';
  const attempts = shouldSyncBillingAttempts
    ? await syncFloBillingAttempts({
        apiKey: process.env.FLO_APPSTLE_API_KEY,
        baseUrl: process.env.FLO_APPSTLE_BASE_URL || process.env.APPSTLE_BASE_URL || DEFAULT_APPSTLE_BASE_URL,
        shopDomain: process.env.FLO_SHOPIFY_SHOP || process.env.FLO_APPSTLE_SHOP || process.env.APPSTLE_SHOP || null,
      })
    : { rows: 0, errors: [] };
  const revenue = await syncFloAppstleRevenueFullRange();
  return {
    rows: (contracts.rows || 0) + (attempts.rows || 0) + (revenue.rows || 0),
    total: contracts.total,
    errors: [...(contracts.errors || []), ...(attempts.errors || []), ...(revenue.errors || [])],
  };
}

module.exports = {
  syncAppstleContracts,
  syncFloAppstleContracts,
  syncFloBillingAttempts,
  ensureFloTable,
  ensureFloBillingAttemptsTable,
};
