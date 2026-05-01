// One-shot migration: SQLite -> PostgreSQL
// Reads /data/nobl.db via Python (avoids native binding issues on Node 24),
// then creates app tables in PG and copies over users/annotations/highlights/settings/oauth_tokens.
// Idempotent: safe to re-run; skips rows that already exist (UPSERT on natural keys).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { execFileSync } = require('child_process');
const path = require('path');
const { pgRun, pgQuery } = require('./postgres');

const SQLITE_PATH = path.join(__dirname, '../../data/nobl.db');

function dumpSqlite() {
  const py = `
import sqlite3, json, sys
db = sqlite3.connect(${JSON.stringify(SQLITE_PATH)})
db.row_factory = sqlite3.Row
out = {}
tables = ['users','annotations','highlights','settings','oauth_tokens']
for t in tables:
    try:
        out[t] = [dict(r) for r in db.execute(f'SELECT * FROM "{t}"')]
    except sqlite3.OperationalError:
        out[t] = []
print(json.dumps(out, default=str))
`;
  const stdout = execFileSync('python', ['-c', py], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function createTables() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS app_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT DEFAULT 'viewer',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      last_login    TIMESTAMPTZ
    )
  `);
  await pgRun(`
    CREATE TABLE IF NOT EXISTS app_annotations (
      id          SERIAL PRIMARY KEY,
      tab         TEXT NOT NULL,
      row_key     TEXT NOT NULL,
      metric      TEXT DEFAULT '',
      note        TEXT NOT NULL,
      color       TEXT DEFAULT 'yellow',
      author      TEXT DEFAULT 'user',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_app_ann_tab ON app_annotations(tab, row_key)`);
  await pgRun(`
    CREATE TABLE IF NOT EXISTS app_highlights (
      id          SERIAL PRIMARY KEY,
      tab         TEXT NOT NULL,
      row_key     TEXT NOT NULL,
      color       TEXT DEFAULT 'yellow',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tab, row_key)
    )
  `);
  await pgRun(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgRun(`
    CREATE TABLE IF NOT EXISTS app_oauth_tokens (
      id          SERIAL PRIMARY KEY,
      tokens      TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // connect-pg-simple session table (its standard schema)
  await pgRun(`
    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire)`);

  console.log('[MIGRATE] tables ready');
}

async function copyData(data) {
  // users
  for (const u of data.users || []) {
    await pgRun(
      `INSERT INTO app_users (id, email, password_hash, name, role, created_at, last_login)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         name          = EXCLUDED.name,
         role          = EXCLUDED.role,
         last_login    = EXCLUDED.last_login`,
      [u.id, u.email, u.password_hash, u.name, u.role, u.created_at, u.last_login]
    );
  }
  if ((data.users || []).length) {
    await pgRun(`SELECT setval('app_users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM app_users))`);
  }
  console.log(`[MIGRATE] users: ${(data.users || []).length}`);

  // annotations
  for (const a of data.annotations || []) {
    await pgRun(
      `INSERT INTO app_annotations (id, tab, row_key, metric, note, color, author, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [a.id, a.tab, a.row_key, a.metric, a.note, a.color, a.author, a.created_at, a.updated_at]
    );
  }
  if ((data.annotations || []).length) {
    await pgRun(`SELECT setval('app_annotations_id_seq', (SELECT COALESCE(MAX(id), 1) FROM app_annotations))`);
  }
  console.log(`[MIGRATE] annotations: ${(data.annotations || []).length}`);

  // highlights
  for (const h of data.highlights || []) {
    await pgRun(
      `INSERT INTO app_highlights (id, tab, row_key, color, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tab, row_key) DO UPDATE SET color = EXCLUDED.color`,
      [h.id, h.tab, h.row_key, h.color, h.created_at]
    );
  }
  if ((data.highlights || []).length) {
    await pgRun(`SELECT setval('app_highlights_id_seq', (SELECT COALESCE(MAX(id), 1) FROM app_highlights))`);
  }
  console.log(`[MIGRATE] highlights: ${(data.highlights || []).length}`);

  // settings
  for (const s of data.settings || []) {
    await pgRun(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [s.key, s.value, s.updated_at]
    );
  }
  console.log(`[MIGRATE] settings: ${(data.settings || []).length}`);

  // oauth_tokens (preserve only)
  for (const t of data.oauth_tokens || []) {
    await pgRun(
      `INSERT INTO app_oauth_tokens (id, tokens, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [t.id, t.tokens, t.updated_at]
    );
  }
  if ((data.oauth_tokens || []).length) {
    await pgRun(`SELECT setval('app_oauth_tokens_id_seq', (SELECT COALESCE(MAX(id), 1) FROM app_oauth_tokens))`);
  }
  console.log(`[MIGRATE] oauth_tokens: ${(data.oauth_tokens || []).length}`);
}

(async () => {
  console.log('[MIGRATE] reading SQLite from', SQLITE_PATH);
  const data = dumpSqlite();
  console.log('[MIGRATE] dumped:', Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v.length])
  ));

  await createTables();
  await copyData(data);

  const c = await pgQuery(
    `SELECT
       (SELECT COUNT(*)::int FROM app_users) AS users,
       (SELECT COUNT(*)::int FROM app_annotations) AS annotations,
       (SELECT COUNT(*)::int FROM app_highlights) AS highlights,
       (SELECT COUNT(*)::int FROM app_settings) AS settings,
       (SELECT COUNT(*)::int FROM app_oauth_tokens) AS oauth_tokens,
       (SELECT COUNT(*)::int FROM session) AS sessions`,
    []
  );
  console.log('[MIGRATE] final counts:', c.rows[0]);
  process.exit(0);
})().catch(e => { console.error('[MIGRATE] FAILED:', e); process.exit(1); });
