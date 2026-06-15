require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

const TW = {
  total: 347006.15,
  channels: {
    META: 256526.42,
    GOOGLE: 43991.46,
    APPLOVIN: 26990.11,
    TIKTOK: 10695.01,
    SNAPCHAT: 6678.53,
    BING: 1156.10,
    PINTEREST: 757.43,
    AMAZON: 211.09,
  },
  geo: {
    US: 310036.88,
    CA: 20121.02,
    AUS: 8944.61,
  },
  noCountryBreakout: 7903.64,
};

async function main() {
  const d = '2026-06-14';
  const brand = 'NOBL';

  const sum = await pgQuery(
    `SELECT total_spend::float, total_revenue::float FROM tw_summary_daily WHERE brand = $1 AND date = $2::date`,
    [brand, d],
  );
  const ch = await pgQuery(
    `SELECT channel, spend_1d::float, revenue_1d::float FROM tw_channel_daily WHERE brand = $1 AND date = $2::date ORDER BY spend_1d DESC NULLS LAST`,
    [brand, d],
  );
  const geo = await pgQuery(
    `SELECT region, spend_actual::float, revenue_actual::float FROM tw_geo_daily WHERE brand = $1 AND date = $2::date ORDER BY region`,
    [brand, d],
  );

  console.log('\n=== REFERENCE (Triple Whale Jun 14) ===');
  console.log('Total spend:', TW.total);
  console.log('Channels:', TW.channels);
  console.log('Geo US/CA/AUS:', TW.geo);

  console.log('\n=== DATABASE ===');
  console.log('tw_summary_daily:', sum.rows[0] || 'NO ROW');

  console.log('\ntw_channel_daily:');
  let chSum = 0;
  for (const r of ch.rows) {
    chSum += r.spend_1d || 0;
    const ref = TW.channels[r.channel];
    const delta = ref != null ? (r.spend_1d - ref).toFixed(2) : 'n/a';
    console.log(`  ${r.channel}: $${(r.spend_1d || 0).toFixed(2)}  (TW ref: ${ref != null ? '$' + ref : 'n/a'}, delta: ${delta})`);
  }
  console.log(`  SUM channels: $${chSum.toFixed(2)}  (TW total: $${TW.total}, delta: $${(chSum - TW.total).toFixed(2)})`);

  console.log('\ntw_geo_daily:');
  for (const r of geo.rows) {
    const ref = TW.geo[r.region];
    console.log(`  ${r.region}: spend=$${(r.spend_actual || 0).toFixed(2)} revenue=$${(r.revenue_actual || 0).toFixed(2)}${ref != null ? ` (TW ref spend: $${ref})` : ''}`);
  }

  const dbTotal = parseFloat(sum.rows[0]?.total_spend || 0);
  console.log('\n=== DELTAS vs TW UI screenshot ===');
  console.log(`total_spend: DB $${dbTotal.toFixed(2)} vs TW $${TW.total} => delta $${(dbTotal - TW.total).toFixed(2)}`);

  const meta = await pgQuery(
    `SELECT updated_at FROM tw_summary_daily WHERE brand = $1 AND date = $2::date`,
    [brand, d],
  );
  console.log('\nLast DB update (summary):', meta.rows[0]?.updated_at);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
