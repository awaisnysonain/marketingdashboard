require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { pgQuery } = require('./server/db/postgres');
pgQuery('SELECT COUNT(*) as cnt FROM tw_summary_daily', [])
  .then(r => {
    console.log('summary rows:', r.rows[0].cnt);
    return pgQuery('SELECT COUNT(*) as cnt FROM tw_channel_daily', []);
  })
  .then(r2 => {
    console.log('channel rows:', r2.rows[0].cnt);
    return pgQuery("SELECT MIN(date) as min_d, MAX(date) as max_d FROM tw_summary_daily WHERE brand='NOBL'", []);
  })
  .then(r3 => {
    console.log('NOBL date range:', r3.rows[0]);
    process.exit(0);
  })
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
