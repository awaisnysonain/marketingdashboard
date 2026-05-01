require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

/**
 * ══════════════════════════════════════════════════════════════════
 *  TripleWhale Willy / SQL API Wrapper
 *
 *  Endpoint: POST https://api.triplewhale.com/api/v2/willy/run-query
 *  Auth:     x-api-key header
 *  Body:     { query: "<ClickHouse SQL>", shopId: "store.myshopify.com" }
 *
 *  ClickHouse dialect notes:
 *    - Date filtering:  date >= toDate('YYYY-MM-DD') AND date < toDate('YYYY-MM-DD')
 *    - Table functions: blended_stats_tvf('start', 'end')
 *    - NULLIF(x,0)  for division
 * ══════════════════════════════════════════════════════════════════
 */

// Working TW SQL endpoint per Brad's Apps Script (the /willy/ path is dead, but
// /orcabase/api/sql works for our keys). Body shape:
//   { period: { startDate, endDate }, currency, shopId, query }
const TW_SQL_URL = process.env.TW_SQL_URL
  || 'https://api.triplewhale.com/api/v2/orcabase/api/sql';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve shop credentials from brand key.
 * @param {'NOBL'|'FLO'|'FLO_EU'} brand
 * @returns {{ shopId: string, apiKey: string }}
 */
function brandCreds(brand) {
  switch (brand) {
    case 'FLO_EU':
      return {
        shopId: process.env.FLO_EU_TW_SHOP_ID,
        apiKey: process.env.FLO_EU_TW_API_KEY,
      };
    case 'FLO':
      return {
        shopId: process.env.FLO_TW_SHOP_ID,
        apiKey: process.env.FLO_TW_API_KEY,
      };
    case 'NOBL_EU':
      // Separate TW workspace pointed at the same nobltravel.myshopify.com shop.
      return {
        shopId: process.env.NOBL_EU_TW_SHOP_ID || process.env.NOBL_TW_SHOP_ID,
        apiKey: process.env.NOBL_EU_TW_API_KEY,
      };
    case 'NOBL':
    default:
      return {
        shopId: process.env.NOBL_TW_SHOP_ID,
        apiKey: process.env.NOBL_TW_API_KEY,
      };
  }
}

/**
 * Run a ClickHouse SQL query against TripleWhale's Willy SQL API.
 *
 * @param {string} brand   'NOBL' | 'FLO' | 'FLO_EU'
 * @param {string} sql     ClickHouse SQL query
 * @param {number} maxRetries
 * @returns {Promise<Array<object>>}  array of row objects
 */
async function twSqlQuery(brand, sql, opts = {}, maxRetries = 3) {
  const { shopId, apiKey } = brandCreds(brand);

  if (!shopId || !apiKey) {
    throw new Error(`[TW SQL] Missing credentials for brand ${brand}`);
  }

  // Body shape per Brad's Apps Script: { period: {startDate, endDate}, currency, shopId, query }
  const body = {
    query:    sql,
    shopId,
    currency: opts.currency || 'USD',
    period:   opts.period || undefined,
  };
  if (!body.period) delete body.period;

  console.log(`[TW SQL] ${brand} query (${sql.slice(0, 80).replace(/\s+/g,' ')}...)`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(TW_SQL_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    apiKey,
          'accept':       'application/json',
        },
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),  // 3-minute timeout per query
      });

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 3000;
        console.warn(`[TW SQL] Rate limited — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`[TW SQL] Auth error ${res.status} for ${brand} — check TW_SQL_URL and API key`);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[TW SQL] HTTP ${res.status}: ${text.slice(0, 400)}`);
      }

      const json = await res.json();

      // The orcabase endpoint returns the rows array DIRECTLY, not wrapped.
      const rows = Array.isArray(json) ? json
        : (json.data || json.rows || json.results || json.result || null);

      if (!rows) {
        console.warn(`[TW SQL] Unexpected response shape:`, Object.keys(json).join(', '));
        return [];
      }

      console.log(`[TW SQL] ${brand}: ${rows.length} rows returned`);
      return rows;

    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`[TW SQL] Failed after ${maxRetries} attempts:`, err.message);
        throw err;
      }
      const wait = Math.pow(2, attempt) * 2000;
      console.warn(`[TW SQL] Attempt ${attempt}/${maxRetries} error: ${err.message}. Retry in ${wait}ms`);
      await sleep(wait);
    }
  }
  return [];
}

/**
 * Convenience: run a query and return rows, returning [] instead of throwing.
 * Use when partial data is acceptable (fire-and-forget style syncs).
 */
async function twSqlSafe(brand, sql, opts = {}) {
  try {
    return await twSqlQuery(brand, sql, opts);
  } catch (e) {
    console.error(`[TW SQL safe] ${brand}:`, e.message);
    return [];
  }
}

/**
 * Test connectivity to the TW SQL API.
 * Returns { ok: boolean, brand, rows, error? }
 */
async function testTwSql(brand = 'NOBL') {
  try {
    const today = new Date().toISOString().slice(0,10);
    const rows = await twSqlQuery(brand,
      `SELECT toDate(now()) AS today, 'ok' AS status LIMIT 1`,
      { period: { startDate: today, endDate: today } },
      1);
    return { ok: true, brand, rows };
  } catch (e) {
    return { ok: false, brand, error: e.message };
  }
}

/**
 * Build a safe half-open ClickHouse date range string.
 * e.g. startDate='2026-04-01', endDate='2026-04-28'
 * → "date >= toDate('2026-04-01') AND date < toDate('2026-04-29')"
 */
function chDateRange(field, startDate, endDate) {
  // endDate is inclusive → we want exclusive upper bound (< next day)
  const d = new Date(endDate);
  d.setUTCDate(d.getUTCDate() + 1);
  const exclusiveEnd = d.toISOString().slice(0, 10);
  return `${field} >= toDate('${startDate}') AND ${field} < toDate('${exclusiveEnd}')`;
}

module.exports = { twSqlQuery, twSqlSafe, testTwSql, brandCreds, chDateRange };
