// Idempotent schema applier — reads the .sql file and runs it as one batch.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('./postgres');

// All schema files are idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this is
// safe to re-run. Add new schema files here.
const SCHEMA_FILES = ['nobl_air_schema.sql', 'iap_schema.sql'];

(async () => {
  // pg's `query` accepts multi-statement strings when no parameters are passed.
  const client = await pool.connect();
  try {
    for (const f of SCHEMA_FILES) {
      const sql = fs.readFileSync(path.join(__dirname, f), 'utf8');
      console.log('[Schema] Applying', f);
      await client.query(sql);
    }
    console.log('[Schema] Applied successfully');
  } finally {
    client.release();
  }
  process.exit(0);
})().catch(e => { console.error('[Schema] FAILED:', e.message); process.exit(1); });
