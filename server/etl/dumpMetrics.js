require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const TW_SUMMARY_URL = 'https://api.triplewhale.com/api/v2/summary-page/get-data';

async function main() {
  const shopDomain = process.env.NOBL_TW_SHOP_ID;
  const apiKey     = process.env.NOBL_TW_API_KEY;

  const body = {
    shopDomain,
    period: {
      start: '2026-04-28T00:00:00.000Z',
      end:   '2026-04-28T23:59:59.000Z',
    },
    todayHour: 25,
  };

  const res = await fetch(TW_SUMMARY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  const metrics = json.metrics ?? [];
  console.log(`Total metrics: ${metrics.length}`);

  // Look for revenue/order/sales/spend related metrics
  const keywords = ['order', 'revenue', 'sales', 'spend', 'gross', 'net', 'amazon', 'shopify', 'refund', 'channel'];

  console.log('\n=== ALL METRIC IDs ===');
  for (const m of metrics) {
    const idLower = (m.id || '').toLowerCase();
    const titleLower = (m.title || m.label || '').toLowerCase();
    const isRelevant = keywords.some(k => idLower.includes(k) || titleLower.includes(k));

    // Get the value for Apr 28
    let val = 'N/A';
    if (m.stats?.current) val = m.stats.current;
    else if (m.charts?.current?.length > 0) {
      // Sum all chart points (it's a date range)
      val = m.charts.current.reduce((s, p) => s + (p.y || 0), 0).toFixed(2);
    }

    if (isRelevant) {
      console.log(`[RELEVANT] id="${m.id}" title="${m.title || m.label}" value=${val}`);
    }
  }

  console.log('\n=== ALL IDs (for reference) ===');
  metrics.forEach(m => process.stdout.write(`${m.id} `));
  console.log('');
}

main().catch(console.error);
