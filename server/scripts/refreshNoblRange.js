require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { refreshBrand } = require('../etl/tripleWhaleSQL');

const START = process.argv[2] || '2026-03-29';
const END = process.argv[3] || '2026-06-02';

(async () => {
  console.log(`Refreshing NOBL ${START} → ${END}…`);
  const t0 = Date.now();
  const r = await refreshBrand('NOBL', START, END);
  console.log('Done', r, `[${((Date.now() - t0) / 1000).toFixed(0)}s]`);
})().catch((e) => { console.error(e); process.exit(1); });
