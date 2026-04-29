require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const TW_SUMMARY_URL = 'https://api.triplewhale.com/api/v2/summary-page/get-data';

// The exact value we expect to find for Apr 28
const TARGET = 531679.46;
const TOLERANCE = 5000; // within $5k

function extractDailyMap(metrics, metricId, baseYear) {
  const metric = metrics.find(m => m.id === metricId);
  if (!metric?.charts?.current?.length) return {};

  let prevX = null, currentYear = baseYear;
  const result = {};
  for (const point of metric.charts.current) {
    const { x, y } = point;
    let year = currentYear;
    if (prevX !== null && x < prevX && prevX > 300 && x < 100) year = currentYear + 1;
    currentYear = year; prevX = x;
    const d = new Date(Date.UTC(year, 0, x));
    const date = d.toISOString().slice(0, 10);
    result[date] = (result[date] ?? 0) + (y ?? 0);
  }
  return result;
}

async function main() {
  const shopDomain = process.env.NOBL_TW_SHOP_ID;
  const apiKey     = process.env.NOBL_TW_API_KEY;

  // Query a wider range around Apr 28 to ensure we get the right data
  const body = {
    shopDomain,
    period: { start: '2026-04-27T00:00:00.000Z', end: '2026-04-28T23:59:59.000Z' },
    todayHour: 25,
  };

  const res = await fetch(TW_SUMMARY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const metrics = json.metrics ?? [];
  const baseYear = 2026;

  console.log(`Total metrics: ${metrics.length}`);
  console.log(`Looking for value ~$${TARGET} for Apr 28\n`);

  const candidates = [];

  for (const m of metrics) {
    const map = extractDailyMap(metrics, m.id, baseYear);
    for (const [date, val] of Object.entries(map)) {
      if (Math.abs(val - TARGET) < TOLERANCE && val > 0) {
        candidates.push({ id: m.id, title: m.title || m.label, date, val: val.toFixed(2) });
      }
    }
  }

  console.log('=== Candidates close to $531,679 ===');
  candidates.forEach(c => console.log(`  id="${c.id}" title="${c.title}" date=${c.date} val=${c.val}`));

  // Also check specific revenue-related metrics for Apr 27 & Apr 28
  const revIds = ['sales', 'grossSales', 'netSales', 'totalRefunds', 'amazonSales',
    'blendedSales', 'topKpiGrossSales', 'topKpiNetRevenue', 'totalOrdersCombinedGrossSales',
    'totalOrdersCombinedNetRevenue', 'shopifyOrders', 'orders'];

  console.log('\n=== Revenue metrics by date ===');
  for (const id of revIds) {
    const map = extractDailyMap(metrics, id, baseYear);
    if (Object.keys(map).length > 0) {
      console.log(`  ${id}:`, JSON.stringify(map));
    }
  }
}

main().catch(console.error);
