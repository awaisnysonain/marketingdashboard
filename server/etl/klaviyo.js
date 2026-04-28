require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2024-02-15';

function klaviyoHeaders() {
  return {
    'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    'revision': KLAVIYO_REVISION,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generic Klaviyo GET with retry + exponential backoff.
 */
async function klaviyoGet(path, maxRetries = 3) {
  const url = path.startsWith('http') ? path : `${KLAVIYO_BASE}${path}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: klaviyoHeaders(),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
        const wait = retryAfter * 1000 || Math.pow(2, attempt) * 1000;
        console.warn(`[Klaviyo] Rate limited, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Klaviyo HTTP ${res.status} GET ${url}: ${text.slice(0, 200)}`);
      }

      return await res.json();

    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.pow(2, attempt) * 1500;
      console.warn(`[Klaviyo] Error attempt ${attempt}/${maxRetries}: ${err.message}. Retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Generic Klaviyo POST with retry.
 */
async function klaviyoPost(path, bodyObj, maxRetries = 3) {
  const url = `${KLAVIYO_BASE}${path}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`[Klaviyo] Rate limited, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Klaviyo HTTP ${res.status} POST ${url}: ${text.slice(0, 200)}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.pow(2, attempt) * 1500;
      console.warn(`[Klaviyo] Error attempt ${attempt}/${maxRetries}: ${err.message}. Retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Paginate through all pages of a Klaviyo cursor-paginated endpoint.
 * Returns all items[].
 */
async function klaviyoPaginateAll(startPath) {
  const items = [];
  let nextUrl = startPath.startsWith('http') ? startPath : `${KLAVIYO_BASE}${startPath}`;

  while (nextUrl) {
    const json = await klaviyoGet(nextUrl);
    const data = json.data ?? [];
    items.push(...data);
    nextUrl = json.links?.next ?? null;
  }

  return items;
}

// Module-level cache so we only fetch metric IDs once per process
let _metricIdsCache = null;

/**
 * Find metric IDs for email events we care about.
 * Fetches ALL metrics (no filter) and matches by name.
 * Returns { sent, opened, clicked, revenue } metric IDs (strings).
 * Result is cached for the lifetime of the process.
 */
async function getEmailMetricIds() {
  if (_metricIdsCache) return _metricIdsCache;

  // Fetch all metrics — no filter since integration filter doesn't work reliably
  const metrics = await klaviyoPaginateAll('/metrics/');

  const find = (names) => {
    const lc = names.map(n => n.toLowerCase());
    const found = metrics.find(m => lc.includes((m.attributes?.name || '').toLowerCase()));
    return found?.id ?? null;
  };

  const ids = {
    sent:    find(['Received Email', 'Sent Email', 'Email Sent', 'Delivered Email']),
    opened:  find(['Opened Email',   'Email Opened',  'Email Open']),
    clicked: find(['Clicked Email',  'Email Clicked', 'Clicked Link in Email', 'Email Click']),
    revenue: find(['Placed Order',   'Order Placed']),
  };

  console.log('[Klaviyo] Metric IDs resolved:', ids);
  _metricIdsCache = ids;
  return ids;
}

/**
 * Fetch metric aggregate values for a single metric over a date range.
 * Returns a map of { 'YYYY-MM-DD': value }.
 */
async function fetchMetricAggregates(metricId, startDate, endDate, measurement = 'count') {
  if (!metricId) return {};

  const body = {
    data: {
      type: 'metric-aggregate',
      attributes: {
        metric_id: metricId,
        measurements: [measurement],
        interval: 'day',
        page_size: 500,
        filter: [
          `greater-or-equal(datetime,${startDate}T00:00:00)`,
          `less-than(datetime,${endDate}T23:59:59)`,
        ],
        timezone: 'UTC',
      },
    },
  };

  try {
    const json = await klaviyoPost('/metric-aggregates/', body);
    const dates = json?.data?.attributes?.dates ?? [];
    const values = json?.data?.attributes?.values ?? [];

    const result = {};
    dates.forEach((d, i) => {
      const dateStr = d.slice(0, 10);
      result[dateStr] = (result[dateStr] || 0) + (values[i]?.[0] ?? 0);
    });
    return result;
  } catch (e) {
    console.error(`[Klaviyo] fetchMetricAggregates(${metricId}) error:`, e.message);
    return {};
  }
}

/**
 * Fetch daily email metrics for a brand and write to klaviyo_daily table.
 *
 * @param {string} brand      e.g. 'NOBL' or 'FLO'
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {Promise<{rows: number, errors: string[]}>}
 */
async function syncKlaviyoDaily(brand, startDate, endDate) {
  const { pgRun } = require('../db/postgres');
  const errors = [];

  console.log(`[Klaviyo] Syncing ${brand} ${startDate} → ${endDate}`);

  // Step 1: discover metric IDs
  let metricIds;
  try {
    metricIds = await getEmailMetricIds();
    console.log('[Klaviyo] Metric IDs:', metricIds);
  } catch (e) {
    const msg = `Failed to fetch metric IDs: ${e.message}`;
    console.error('[Klaviyo]', msg);
    errors.push(msg);
    return { rows: 0, errors };
  }

  // Step 2: fetch aggregates for each metric in parallel
  const [sentMap, openedMap, clickedMap, revenueMap] = await Promise.all([
    fetchMetricAggregates(metricIds.sent,    startDate, endDate, 'count'),
    fetchMetricAggregates(metricIds.opened,  startDate, endDate, 'count'),
    fetchMetricAggregates(metricIds.clicked, startDate, endDate, 'count'),
    fetchMetricAggregates(metricIds.revenue, startDate, endDate, 'sum_value'),
  ]);

  // Step 3: build the union of all dates and upsert
  const allDates = new Set([
    ...Object.keys(sentMap),
    ...Object.keys(openedMap),
    ...Object.keys(clickedMap),
    ...Object.keys(revenueMap),
  ]);

  // Also generate every date in range so we fill gaps with zeros
  const start = new Date(startDate);
  const end   = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    allDates.add(d.toISOString().slice(0, 10));
  }

  let written = 0;
  for (const date of [...allDates].sort()) {
    const sent    = sentMap[date]    || 0;
    const opened  = openedMap[date]  || 0;
    const clicked = clickedMap[date] || 0;
    const revenue = revenueMap[date] || 0;

    const openRate  = sent > 0 ? (opened  / sent) : null;
    const clickRate = sent > 0 ? (clicked / sent) : null;

    try {
      await pgRun(`
        INSERT INTO klaviyo_daily
          (date, brand, emails_sent, emails_opened, emails_clicked, open_rate, click_rate, revenue)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (date, brand) DO UPDATE SET
          emails_sent    = EXCLUDED.emails_sent,
          emails_opened  = EXCLUDED.emails_opened,
          emails_clicked = EXCLUDED.emails_clicked,
          open_rate      = EXCLUDED.open_rate,
          click_rate     = EXCLUDED.click_rate,
          revenue        = EXCLUDED.revenue
      `, [date, brand, sent, opened, clicked, openRate, clickRate, revenue]);
      written++;
    } catch (e) {
      const msg = `Row upsert ${date}/${brand}: ${e.message}`;
      console.error('[Klaviyo]', msg);
      errors.push(msg);
    }
  }

  console.log(`[Klaviyo] ${brand}: ${written} rows upserted, ${errors.length} errors`);
  return { rows: written, errors };
}

module.exports = { syncKlaviyoDaily, getEmailMetricIds, fetchMetricAggregates, klaviyoGet };
