require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');
(async () => {
  const r = await pgQuery(`
    SELECT COUNT(*)::int AS missing
    FROM tw_summary_daily
    WHERE brand = 'NOBL'
      AND date >= '2025-01-01'::date
      AND order_revenue > 100
      AND (gross_minus_discounts IS NULL OR gross_minus_discounts = 0)
  `);
  const ok = await pgQuery(`
    SELECT COUNT(*)::int AS ok FROM tw_summary_daily
    WHERE brand = 'NOBL' AND date >= '2025-01-01'::date AND gross_minus_discounts > 0
  `);
  console.log('NOBL 2025+ rows with gmd>0:', ok.rows[0].ok);
  console.log('NOBL 2025+ rows missing gmd (order_revenue>100):', r.rows[0].missing);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
