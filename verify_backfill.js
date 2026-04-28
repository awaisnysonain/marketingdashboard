/**
 * Final backfill verification — run this after the full backfill completes
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { pgQuery } = require('./server/db/postgres');

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL VERIFICATION');
  console.log('='.repeat(60));

  // TW Summary
  for (const brand of ['NOBL', 'FLO']) {
    const r = await pgQuery(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE total_revenue > 0) as has_rev,
        COUNT(*) FILTER (WHERE total_spend > 0) as has_spend,
        COUNT(*) FILTER (WHERE total_orders > 0) as has_orders,
        MIN(date) as min_date,
        MAX(date) as max_date,
        ROUND(SUM(total_revenue)::numeric, 0) as total_rev,
        ROUND(SUM(total_spend)::numeric, 0) as total_spend,
        ROUND(SUM(total_orders)::numeric, 0) as total_orders,
        ROUND(SUM(new_customer_orders)::numeric, 0) as total_nc_orders
      FROM tw_summary_daily WHERE brand=$1
    `, [brand]);
    const row = r.rows[0];
    console.log(`\n${brand} TW Summary:`);
    console.log(`  Range: ${row.min_date?.toISOString().slice(0,10)} → ${row.max_date?.toISOString().slice(0,10)}`);
    console.log(`  Rows: ${row.total} (rev>0: ${row.has_rev}, spend>0: ${row.has_spend}, orders>0: ${row.has_orders})`);
    console.log(`  Total Revenue: $${parseInt(row.total_rev).toLocaleString()}`);
    console.log(`  Total Spend:   $${parseInt(row.total_spend).toLocaleString()}`);
    console.log(`  Total Orders:  ${parseInt(row.total_orders).toLocaleString()}`);
    console.log(`  NC Orders:     ${parseInt(row.total_nc_orders).toLocaleString()}`);

    // Sample recent data
    const recent = await pgQuery(`
      SELECT date, total_revenue, total_spend, mer, total_orders
      FROM tw_summary_daily WHERE brand=$1 ORDER BY date DESC LIMIT 5
    `, [brand]);
    console.log('  Recent data:');
    recent.rows.forEach(row => {
      const date = row.date?.toISOString?.()?.slice(0,10) || row.date;
      console.log(`    ${date}: rev=$${Math.round(row.total_revenue||0).toLocaleString()} spend=$${Math.round(row.total_spend||0).toLocaleString()} mer=${parseFloat(row.mer||0).toFixed(2)} orders=${row.total_orders||0}`);
    });
  }

  // Klaviyo
  const kl = await pgQuery(`
    SELECT brand,
      COUNT(*) as rows,
      COUNT(*) FILTER (WHERE emails_sent > 0) as rows_with_data,
      COALESCE(SUM(emails_sent), 0) as total_sent,
      MIN(date) as min_date, MAX(date) as max_date
    FROM klaviyo_daily GROUP BY brand ORDER BY brand
  `);
  console.log('\nKlaviyo:');
  kl.rows.forEach(r => {
    const md = r.min_date?.toISOString?.()?.slice(0,10) || r.min_date;
    const xd = r.max_date?.toISOString?.()?.slice(0,10) || r.max_date;
    console.log(`  ${r.brand}: ${r.rows} rows, ${r.rows_with_data} with data, total_sent=${r.total_sent}, range: ${md}→${xd}`);
  });

  console.log('\n' + '='.repeat(60));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
