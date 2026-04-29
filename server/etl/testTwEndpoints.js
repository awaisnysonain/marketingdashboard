require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const shopId = process.env.NOBL_TW_SHOP_ID;
const apiKey = process.env.NOBL_TW_API_KEY;
const sql = `SELECT toDate(now()) AS today LIMIT 1`;

async function tryEndpoint(url, body, headers = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    console.log(`  ${res.status} → ${text.slice(0, 120)}`);
    return res.status;
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return 0;
  }
}

async function main() {
  console.log('Testing alternative TW SQL/Willy endpoints...\n');

  const endpoints = [
    ['POST /api/v2/willy/run-query (shopId)',
      'https://api.triplewhale.com/api/v2/willy/run-query',
      { query: sql, shopId }],
    ['POST /api/v2/willy/run-query (shopDomain)',
      'https://api.triplewhale.com/api/v2/willy/run-query',
      { query: sql, shopDomain: shopId }],
    ['POST /api/v2/willy/answer',
      'https://api.triplewhale.com/api/v2/willy/answer',
      { query: sql, shopId }],
    ['POST /api/v2/willy/get-query-data',
      'https://api.triplewhale.com/api/v2/willy/get-query-data',
      { query: sql, shopId }],
    ['POST /api/v2/attribution/run-query',
      'https://api.triplewhale.com/api/v2/attribution/run-query',
      { query: sql, shopId }],
    ['POST /api/v2/attribution/custom-query',
      'https://api.triplewhale.com/api/v2/attribution/custom-query',
      { query: sql, shopId }],
    ['POST /api/v1/willy/run-query',
      'https://api.triplewhale.com/api/v1/willy/run-query',
      { query: sql, shopId }],
    ['POST /api/v2/willy/run-query (shop_id key)',
      'https://api.triplewhale.com/api/v2/willy/run-query',
      { query: sql, shop_id: shopId }],
    ['POST /api/v2/store-data/query',
      'https://api.triplewhale.com/api/v2/store-data/query',
      { query: sql, shopId }],
  ];

  for (const [label, url, body] of endpoints) {
    console.log(`${label}:`);
    await tryEndpoint(url, body);
  }
}

main().catch(console.error);
