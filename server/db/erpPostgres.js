/**
 * Read-only pool for the ERP Postgres (erp_maindb) used by the ops ETL.
 * Lives on the SAME server as the dashboard DB but is a separate database
 * with separate credentials (ERP_DB_*). Read-only enforced via SET TRANSACTION.
 */
const { Pool } = require('pg');

const ERP_POOL_OPTS = {
  host: process.env.ERP_DB_HOST,
  port: parseInt(process.env.ERP_DB_PORT || '5432', 10),
  database: process.env.ERP_DB_NAME,
  user: process.env.ERP_DB_USER,
  password: process.env.ERP_DB_PASSWORD,
  ssl: process.env.ERP_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 2,
  idleTimeoutMillis: 5000,
  allowExitOnIdle: true,
  connectionTimeoutMillis: 8000,
  application_name: 'marketingdashboard-erp',
};

let erpPool = null;

function getErpPool() {
  if (!erpPool) {
    if (!process.env.ERP_DB_HOST) {
      throw new Error('ERP_DB_HOST is not set. Configure ERP_DB_* in .env to enable ops ETL.');
    }
    erpPool = new Pool(ERP_POOL_OPTS);
    erpPool.on('error', (err) => console.error('[ERP PG] pool error:', err.message));
  }
  return erpPool;
}

/**
 * Run a query on the ERP DB. The configured user (nysonianREAD) is itself
 * read-only at the DB level, so no extra READ ONLY transaction is needed.
 */
async function erpQuery(sql, params = []) {
  const client = await getErpPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function endErpPool() {
  if (erpPool) {
    await erpPool.end();
    erpPool = null;
  }
}

module.exports = { getErpPool, erpQuery, endErpPool };
