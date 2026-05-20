require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { refreshNoblAirMetaAdDaily } = require('../etl/noblAirMetaAdDaily');

const start = process.argv[2] || '2026-03-01';
const end = process.argv[3] || '2026-05-20';

refreshNoblAirMetaAdDaily(start, end)
  .then((r) => {
    console.log(`nobl_air_meta_ad_daily backfill: ${r.rows} rows (${start} → ${end})`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
