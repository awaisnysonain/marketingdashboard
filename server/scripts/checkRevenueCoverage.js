require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

(async () => {
  const r = await pgQuery(`
    SELECT brand,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE gross_minus_discounts IS NOT NULL AND gross_minus_discounts > 0)::int AS with_gmd,
           MIN(date)::text AS first_date,
           MAX(date)::text AS last_date
    FROM tw_summary_daily
    GROUP BY brand ORDER BY brand`);
  console.log('Coverage:', r.rows);

  const gaps = await pgQuery(`
    SELECT brand, COUNT(*)::int AS missing
    FROM tw_summary_daily
    WHERE gross_minus_discounts IS NULL OR gross_minus_discounts = 0
    GROUP BY brand`);
  console.log('Rows missing gmd:', gaps.rows);

  const nulls = await pgQuery(`
    SELECT brand,
           COUNT(*) FILTER (WHERE gross_minus_discounts IS NULL)::int AS null_gmd,
           COUNT(*) FILTER (WHERE gross_minus_discounts = 0)::int AS zero_gmd
    FROM tw_summary_daily GROUP BY brand`);
  console.log('NULL vs zero gmd:', nulls.rows);
})().catch(e => { console.error(e); process.exit(1); });
