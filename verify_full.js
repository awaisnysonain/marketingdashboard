require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { pgQuery } = require('./server/db/postgres');

async function main() {
  const sep = '='.repeat(70);
  console.log('\n' + sep);
  console.log('FULL DATABASE VERIFICATION REPORT — ' + new Date().toISOString().slice(0,10));
  console.log(sep);

  // ── 1. TW SUMMARY DAILY ──────────────────────────────────────────────────
  console.log('\n━━ 1. TW SUMMARY DAILY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const brand of ['NOBL','FLO']) {
    const r = await pgQuery(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE total_revenue > 0) as has_rev,
        MIN(date) as min_d, MAX(date) as max_d,
        ROUND(SUM(total_revenue)::numeric,0) as rev,
        ROUND(SUM(total_spend)::numeric,0) as spend,
        SUM(total_orders) as orders,
        SUM(new_customer_orders) as nc_orders,
        MAX(date)-MIN(date)+1 as span
      FROM tw_summary_daily WHERE brand=$1
    `, [brand]);
    const g = await pgQuery(`
      SELECT COUNT(*) as gaps FROM (
        SELECT date - LAG(date) OVER (ORDER BY date) as diff FROM tw_summary_daily WHERE brand=$1
      ) x WHERE diff > 1
    `, [brand]);
    const row = r.rows[0];
    const ok = parseInt(g.rows[0].gaps) === 0 ? 'OK' : 'GAPS';
    console.log(`  ${brand}: [${ok}] ${row.total} rows | ${row.min_d?.toISOString().slice(0,10)} -> ${row.max_d?.toISOString().slice(0,10)} | span=${row.span}d | rev>${row.has_rev}`);
    console.log(`         Rev=$${parseInt(row.rev).toLocaleString()}  Spend=$${parseInt(row.spend).toLocaleString()}  Orders=${parseInt(row.orders||0).toLocaleString()}  NC_Orders=${parseInt(row.nc_orders||0).toLocaleString()}`);
  }

  // ── 2. TW CHANNEL DAILY ──────────────────────────────────────────────────
  console.log('\n━━ 2. TW CHANNEL DAILY — Ad Channels ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const ch = await pgQuery(`
    SELECT brand, channel,
      COUNT(*) as rows, MIN(date) as min_d, MAX(date) as max_d,
      ROUND(SUM(spend_1d)::numeric,0) as spend,
      ROUND(SUM(revenue_1d)::numeric,0) as rev,
      COUNT(*) FILTER (WHERE spend_1d > 0) as days_spend
    FROM tw_channel_daily GROUP BY brand, channel ORDER BY brand, spend DESC
  `);
  let curBrand = '';
  ch.rows.forEach(r => {
    if (r.brand !== curBrand) { console.log(`  --- ${r.brand} ---`); curBrand = r.brand; }
    const lag = Math.round((new Date('2026-04-27') - new Date(r.max_d)) / 86400000);
    const flag = lag <= 5 ? '[OK]' : `[LAG:${lag}d]`;
    console.log(`    ${flag} ${(r.brand+'/'+r.channel).padEnd(20)} ${String(r.rows).padStart(4)} rows | ${r.min_d?.toISOString().slice(0,10)} -> ${r.max_d?.toISOString().slice(0,10)} | spend=$${parseInt(r.spend||0).toLocaleString().padStart(12)}  rev=$${parseInt(r.rev||0).toLocaleString().padStart(12)}  (${r.days_spend}d active)`);
  });

  // ── 3. TW STORE SUMMARY DAILY ────────────────────────────────────────────
  console.log('\n━━ 3. TW STORE SUMMARY DAILY (per store) ━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const ss = await pgQuery(`
    SELECT brand, store_key, shop_id, COUNT(*) as rows,
      MIN(date) as min_d, MAX(date) as max_d,
      ROUND(SUM(total_revenue)::numeric,0) as rev,
      ROUND(SUM(total_spend)::numeric,0) as spend
    FROM tw_store_summary_daily GROUP BY brand, store_key, shop_id ORDER BY brand, store_key
  `);
  ss.rows.forEach(r => {
    console.log(`  ${r.brand}/${r.store_key} [${r.shop_id}]: ${r.rows} rows | ${r.min_d?.toISOString().slice(0,10)} -> ${r.max_d?.toISOString().slice(0,10)} | Rev=$${parseInt(r.rev||0).toLocaleString()}  Spend=$${parseInt(r.spend||0).toLocaleString()}`);
  });

  // ── 4. TW PRODUCT DAILY ──────────────────────────────────────────────────
  console.log('\n━━ 4. TW PRODUCT DAILY (product line breakdown) ━━━━━━━━━━━━━━━━━━━━');
  const pd = await pgQuery(`
    SELECT brand, product_line, COUNT(*) as rows,
      MIN(date) as min_d, MAX(date) as max_d,
      ROUND(SUM(revenue)::numeric,0) as rev,
      ROUND(SUM(meta_spend+google_spend+tiktok_spend+snap_spend+bing_spend+applovin_spend)::numeric,0) as channel_spend
    FROM tw_product_daily GROUP BY brand, product_line ORDER BY brand, rev DESC
  `);
  if (pd.rows.length === 0) {
    console.log('  No product daily data found');
  } else {
    pd.rows.forEach(r => {
      console.log(`  ${r.brand}/${r.product_line}: ${r.rows} rows | ${r.min_d?.toISOString().slice(0,10)} -> ${r.max_d?.toISOString().slice(0,10)} | Rev=$${parseInt(r.rev||0).toLocaleString()}  ChannelSpend=$${parseInt(r.channel_spend||0).toLocaleString()}`);
    });
  }
  const nobl_pd = await pgQuery(`SELECT COUNT(*) as c FROM tw_product_daily WHERE brand='NOBL'`);
  if (parseInt(nobl_pd.rows[0].c) === 0) {
    console.log('  NOBL: [INFO] No product-line data — product attribution not configured for NOBL in TW');
  }

  // ── 5. TW GEO DAILY ──────────────────────────────────────────────────────
  console.log('\n━━ 5. TW GEO DAILY (region breakdown) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const geo = await pgQuery(`
    SELECT brand, region, COUNT(*) as days,
      ROUND(SUM(revenue_actual)::numeric,0) as rev,
      ROUND(SUM(spend_actual)::numeric,0) as spend,
      ROUND(AVG(mer)::numeric,2) as avg_mer
    FROM tw_geo_daily GROUP BY brand, region ORDER BY brand, rev DESC
  `);
  geo.rows.forEach(r => {
    console.log(`  ${r.brand}/${r.region.padEnd(6)}: ${r.days} days | Rev=$${parseInt(r.rev||0).toLocaleString().padStart(13)}  Spend=$${parseInt(r.spend||0).toLocaleString().padStart(12)}  AvgMER=${r.avg_mer}`);
  });

  // ── 6. KLAVIYO DAILY ─────────────────────────────────────────────────────
  console.log('\n━━ 6. KLAVIYO DAILY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const kl = await pgQuery(`
    SELECT brand, COUNT(*) as rows, MIN(date) as min_d, MAX(date) as max_d,
      SUM(emails_sent) as sent, SUM(emails_opened) as opened, SUM(emails_clicked) as clicked
    FROM klaviyo_daily GROUP BY brand ORDER BY brand
  `);
  kl.rows.forEach(r => {
    const note = parseInt(r.sent) === 0 ? '[INFO: 0 sends — Klaviyo API key has no email send data for this account]' : '[OK]';
    console.log(`  ${r.brand}: ${r.rows} rows | ${r.min_d?.toISOString().slice(0,10)} -> ${r.max_d?.toISOString().slice(0,10)} | sent=${r.sent} opened=${r.opened} ${note}`);
  });

  // ── 7. NOBL SUBSCRIPTION REVENUE ─────────────────────────────────────────
  console.log('\n━━ 7. NOBL AIR SUBSCRIPTION REVENUE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const sub = await pgQuery(`
    SELECT COUNT(*) as rows, MIN(date) as min_d, MAX(date) as max_d,
      ROUND(SUM(sub_revenue_actual)::numeric,0) as total_rev,
      ROUND(SUM(rebill_revenue)::numeric,0) as rebill,
      ROUND(SUM(new_sub_revenue)::numeric,0) as new_rev
    FROM nobl_air_sub_revenue_daily
  `);
  const s = sub.rows[0];
  console.log(`  ${s.rows} rows | ${s.min_d?.toISOString().slice(0,10)} -> ${s.max_d?.toISOString().slice(0,10)} | Total=$${parseInt(s.total_rev||0).toLocaleString()}  Rebill=$${parseInt(s.rebill||0).toLocaleString()}  NewSub=$${parseInt(s.new_rev||0).toLocaleString()}`);

  // ── 8. RAW TABLES ────────────────────────────────────────────────────────
  console.log('\n━━ 8. RAW / SOURCE TABLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const rawTables = [
    { tbl: 'tw_orders_raw',   grp: ['brand','store_key'], dcol: 'event_date' },
    { tbl: 'tw_ads_raw',      grp: ['brand','channel'],   dcol: 'event_date' },
    { tbl: 'tw_pixel_raw',    grp: ['brand'],             dcol: 'event_date' },
    { tbl: 'tw_orders_minute',grp: ['brand'],             dcol: 'event_date' },
  ];
  for (const { tbl, grp, dcol } of rawTables) {
    try {
      const r = await pgQuery(`SELECT ${grp.join(', ')}, COUNT(*) as rows, MIN(${dcol}) as min_d, MAX(${dcol}) as max_d FROM ${tbl} GROUP BY ${grp.join(', ')} ORDER BY ${grp.join(', ')}`);
      r.rows.forEach(row => {
        const key = grp.map(c => row[c]).join('/');
        const md = row.min_d?.toISOString?.()?.slice(0,10) || String(row.min_d);
        const xd = row.max_d?.toISOString?.()?.slice(0,10) || String(row.max_d);
        console.log(`  [${tbl}] ${key}: ${row.rows} rows | ${md} -> ${xd}`);
      });
    } catch(e) {
      console.log(`  [${tbl}] error: ${e.message}`);
    }
  }

  // ── 9. MONTHLY BREAKDOWN (tw_summary_daily) ──────────────────────────────
  console.log('\n━━ 9. MONTHLY BREAKDOWN — NOBL (tw_summary_daily) ━━━━━━━━━━━━━━━━━━');
  const mn = await pgQuery(`
    SELECT TO_CHAR(date,'YYYY-MM') as month,
      COUNT(*) FILTER (WHERE total_revenue>0) as active_days,
      ROUND(SUM(total_revenue)::numeric,0) as rev,
      ROUND(SUM(total_spend)::numeric,0) as spend,
      ROUND(AVG(mer)::numeric,2) as avg_mer,
      SUM(total_orders) as orders
    FROM tw_summary_daily WHERE brand='NOBL'
    GROUP BY 1 ORDER BY 1
  `);
  mn.rows.forEach(r => {
    console.log(`  ${r.month}: ${String(r.active_days).padStart(2)}d | Rev=$${parseInt(r.rev||0).toLocaleString().padStart(12)}  Spend=$${parseInt(r.spend||0).toLocaleString().padStart(11)}  MER=${String(r.avg_mer).padStart(5)}  Orders=${parseInt(r.orders||0).toLocaleString().padStart(7)}`);
  });
  console.log('\n━━ 9b. MONTHLY BREAKDOWN — FLO (tw_summary_daily) ━━━━━━━━━━━━━━━━━━');
  const mf = await pgQuery(`
    SELECT TO_CHAR(date,'YYYY-MM') as month,
      COUNT(*) FILTER (WHERE total_revenue>0) as active_days,
      ROUND(SUM(total_revenue)::numeric,0) as rev,
      ROUND(SUM(total_spend)::numeric,0) as spend,
      ROUND(AVG(mer)::numeric,2) as avg_mer,
      SUM(total_orders) as orders
    FROM tw_summary_daily WHERE brand='FLO'
    GROUP BY 1 ORDER BY 1
  `);
  mf.rows.forEach(r => {
    console.log(`  ${r.month}: ${String(r.active_days).padStart(2)}d | Rev=$${parseInt(r.rev||0).toLocaleString().padStart(12)}  Spend=$${parseInt(r.spend||0).toLocaleString().padStart(11)}  MER=${String(r.avg_mer).padStart(5)}  Orders=${parseInt(r.orders||0).toLocaleString().padStart(7)}`);
  });

  console.log('\n' + sep);
  console.log('VERIFICATION COMPLETE');
  console.log(sep + '\n');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
