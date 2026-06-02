require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

(async () => {
  const may = await pgQuery(`
    SELECT product_line,
           SUM(spend)::numeric(12,2) spend,
           SUM(revenue)::numeric(12,2) rev,
           SUM(new_cust_orders)::int units
    FROM tw_product_daily
    WHERE brand='FLO' AND date >= '2026-05-01' AND date < '2026-06-01'
    GROUP BY product_line ORDER BY product_line
  `);
  console.log('May 2026 tw_product_daily:', may.rows);

  const ytd = await pgQuery(`
    SELECT product_line,
           SUM(spend)::numeric(12,2) spend,
           SUM(revenue)::numeric(12,2) rev,
           SUM(new_cust_orders)::int units
    FROM tw_product_daily
    WHERE brand='FLO' AND date >= '2026-01-01' AND date <= CURRENT_DATE
    GROUP BY product_line ORDER BY product_line
  `);
  console.log('YTD 2026 tw_product_daily:', ytd.rows);

  const cnt = await pgQuery(`
    SELECT COUNT(*)::int n, MIN(date)::text min_d, MAX(date)::text max_d
    FROM tw_product_daily WHERE brand='FLO'
  `);
  console.log('FLO product row coverage:', cnt.rows[0]);

  const view = await pgQuery(`
    SELECT product_line, SUM(spend)::numeric(12,2) spend, SUM(revenue)::numeric(12,2) rev,
           SUM(new_cust_orders)::int units
    FROM flo_brand_tw_product_daily
    WHERE date >= '2026-01-01' AND date <= CURRENT_DATE
    GROUP BY product_line ORDER BY product_line
  `).catch(e => ({ rows: [], error: e.message }));
  if (view.error) console.log('View query error:', view.error);
  else console.log('YTD flo_brand_tw_product_daily view:', view.rows);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
