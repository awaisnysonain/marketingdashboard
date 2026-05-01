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

const BASE = 'https://subscription-admin.appstle.com/api/external/v2';
const PAGE_SIZE = 2000;
const TRIAL_DAYS = 14; // per the doc

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(page) {
  // Per the technical doc: ?sort=created_at,asc (snake_case)
  const url = `${BASE}/subscription-contract-details?page=${page}&size=${PAGE_SIZE}&sort=created_at,asc`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': process.env.APPSTLE_API_KEY, 'Accept': 'application/json' },
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
  // Convert = a successful paid order exists with orderAmount > 0.
  let lastSuccess = contract.lastSuccessfulOrder;
  if (typeof lastSuccess === 'string') {
    try { lastSuccess = JSON.parse(lastSuccess); } catch { lastSuccess = null; }
  }
  const successAmount = lastSuccess?.orderAmount != null ? Number(lastSuccess.orderAmount) : 0;
  const successDate = lastSuccess?.orderDate
    ? new Date(lastSuccess.orderDate).getTime()
    : (contract.lastBillingDate ? new Date(contract.lastBillingDate).getTime() : null);

  const cancelled = contract.cancelledOn ? new Date(contract.cancelledOn).getTime() : null;

  const isMature = created !== null && (now - created) >= TRIAL_DAYS * 86400 * 1000;
  // Converted = customer was actually charged (orderAmount > 0). Per the technical
  // doc, billing date alone isn't reliable because Appstle sometimes records the
  // trial activation as a "billing" with $0 amount.
  const isConverted = successAmount > 0;
  // Same-day cancel = cancelled within 24h of creation (still a useful churn signal)
  const isSameDayCancel = (cancelled && created) ? ((cancelled - created) <= 86400 * 1000) : false;

  return { isMature, isConverted, isSameDayCancel, lastBillingMs: successDate };
}

async function writeBatch(contracts) {
  if (contracts.length === 0) return 0;
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
        c.lastBillingDate || null,
        c.cancelledOn || null,
        flags.isMature,
        flags.isConverted,
        flags.isSameDayCancel,
        JSON.stringify(c),
      );
    }
    await pgRun(`
      INSERT INTO nobl_air_subscribers (
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

async function syncAppstleContracts() {
  if (!process.env.APPSTLE_API_KEY) {
    return { rows: 0, errors: ['Missing APPSTLE_API_KEY'] };
  }
  console.log('[Appstle] Fetching all subscription contracts…');
  const errors = [];
  let page = 0, written = 0, total = null;
  while (true) {
    let r;
    try { r = await fetchPage(page); }
    catch (e) { errors.push(`page ${page}: ${e.message}`); break; }
    if (total === null) {
      total = r.total;
      console.log(`[Appstle] Total contracts: ${total}`);
    }
    if (!Array.isArray(r.data) || r.data.length === 0) break;
    written += await writeBatch(r.data);
    console.log(`[Appstle] page ${page}: +${r.data.length} (cumulative ${written}/${total})`);
    if (page * PAGE_SIZE + r.data.length >= total) break;
    page++;
    await sleep(500);
    if (page > 50) { console.warn('[Appstle] page cap'); break; }
  }
  return { rows: written, errors, total };
}

module.exports = { syncAppstleContracts };
