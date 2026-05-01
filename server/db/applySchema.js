// Idempotent schema applier — reads the .sql file and runs it as one batch.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('./postgres');

(async () => {
  const sqlFile = path.join(__dirname, 'nobl_air_schema.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  console.log('[Schema] Applying', path.basename(sqlFile));
  // pg's `query` accepts multi-statement strings when no parameters are passed.
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[Schema] Applied successfully');
  } finally {
    client.release();
  }
  process.exit(0);
})().catch(e => { console.error('[Schema] FAILED:', e.message); process.exit(1); });
