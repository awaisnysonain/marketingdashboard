/**
 * One-time / manual backfill for nobl_air_ttp_snapshot.
 * Usage: node server/scripts/backfillTtpSnapshot.js 2025-01-01 2026-05-20
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { refreshNoblAirTtpSnapshots } = require('../etl/noblAirTtpSnapshot');

const start = process.argv[2] || '2025-01-01';
const end = process.argv[3] || new Date().toISOString().slice(0, 10);

refreshNoblAirTtpSnapshots(start, end)
  .then((r) => {
    console.log(`TTP snapshot backfill complete: ${r.rows} days (${start} → ${end})`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
