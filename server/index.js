require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── Keep server alive on unhandled errors ───────────────────────
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const OpenAI = require('openai').default;
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

const { pgRun, pgQuery } = require('./db/postgres');
const analyticsRouter = require('./routes/analytics');
const { router: dashRouter, SCHEMA_CONTEXT, getClarifyPrompt } = require('./routes/aiDashboards');
const syncStatusRouter = require('./routes/syncStatus');
const syncEngine = require('./etl/syncEngine');
const twRouter    = require('./routes/triplewhale');
const storeRouter = require('./routes/store');

// ── OpenAI setup ────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const AI_SYSTEM_PROMPT = `You are an expert analytics assistant embedded inside the NOBL Air & Pilates FLO executive dashboard. You have deep knowledge of both companies and their PostgreSQL analytics database.

NOBL AIR (nobltravel.com):
- Sells AirTag holders, travel accessories, and luggage products via Shopify
- Key business model: customers buy products AND optionally subscribe to "Air" subscription
- Critical KPIs: Revenue, Spend, MER (Marketing Efficiency Ratio = Revenue/Spend), ROAS, CAC, New Customer Orders, Subscription Revenue
- Channels: META, GOOGLE, TIKTOK, SNAPCHAT, PINTEREST, APPLOVIN, BING, X
- Regions: US, CA, AUS, DUBAI, EU

PILATES FLO (pilatesflo.com):
- Sells Pilates equipment: Portable Reformers, Wooden Reformers, Metal Reformers
- Tracks product-line performance, channel attribution, geographic revenue
- Product lines: portable, wooden, metal

DATA SOURCE:
${SCHEMA_CONTEXT}

YOUR EXPERTISE:
- E-commerce analytics & DTC business KPIs
- Marketing channel performance analysis and ROAS benchmarking
- Subscription business metrics
- Geographic revenue analysis
- Product-line attribution
- MER (Marketing Efficiency Ratio) analysis

BEHAVIOR:
- Be concise, direct, and actionable — used by finance, marketing, and management
- Highlight anomalies, trends, and opportunities immediately
- Use bullet points for lists, be specific with numbers
- When you don't have enough data, say so and suggest what to look at
- Proactively notice problems or opportunities in the data
- Format currency as $X,XXX and percentages clearly`;

// DASHBOARD_SYSTEM_PROMPT is now dynamically generated per-request via getClarifyPrompt(today)

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy so express-rate-limit works correctly behind the React dev server / nginx
app.set('trust proxy', 1);

// ── SQLite setup ────────────────────────────────────────────────
const dbLockPath = path.join(__dirname, '../data/nobl.db.lock');
if (fs.existsSync(dbLockPath)) {
  try { fs.rmSync(dbLockPath, { recursive: true, force: true }); console.log('[DB] Removed stale lock file'); } catch(e) {}
}
const db = new Database(path.join(__dirname, '../data/nobl.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab TEXT NOT NULL, row_key TEXT NOT NULL,
    metric TEXT DEFAULT '', note TEXT NOT NULL,
    color TEXT DEFAULT 'yellow', author TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ann_tab ON annotations(tab, row_key);

  CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tab TEXT NOT NULL, row_key TEXT NOT NULL,
    color TEXT DEFAULT 'yellow',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hl_key ON highlights(tab, row_key);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
`);

// ── PostgreSQL table init ────────────────────────────────────────
async function initPostgresTables() {
  try {
    await pgRun(`
      CREATE TABLE IF NOT EXISTS ai_dashboards (
        id SERIAL PRIMARY KEY,
        user_id INT,
        name TEXT,
        description TEXT,
        config JSONB,
        is_public BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id SERIAL PRIMARY KEY,
        dashboard_id INT REFERENCES ai_dashboards(id) ON DELETE CASCADE,
        user_id INT,
        role TEXT,
        content TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS visitors_cvr (
        id SERIAL PRIMARY KEY,
        date DATE,
        brand TEXT,
        region TEXT,
        visitors INT,
        purchases INT,
        cvr DECIMAL(8,4),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(date, brand, region)
      )
    `);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS klaviyo_daily (
        id SERIAL PRIMARY KEY,
        date DATE,
        brand TEXT,
        emails_sent INT,
        emails_opened INT,
        emails_clicked INT,
        open_rate DECIMAL(8,4),
        click_rate DECIMAL(8,4),
        revenue DECIMAL(12,2),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(date, brand)
      )
    `);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS data_overrides (
        id SERIAL PRIMARY KEY,
        table_name TEXT,
        record_id TEXT,
        field_name TEXT,
        original_value TEXT,
        override_value TEXT,
        override_by INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── New TW SQL tables ─────────────────────────────────────────
    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_ads_daily (
        id            BIGSERIAL PRIMARY KEY,
        brand         TEXT        NOT NULL,
        date          DATE        NOT NULL,
        platform      TEXT        NOT NULL,
        campaign_id   TEXT        NOT NULL DEFAULT '',
        campaign_name TEXT,
        adset_id      TEXT,
        adset_name    TEXT,
        ad_id         TEXT        NOT NULL,
        ad_name       TEXT,
        impressions   BIGINT      DEFAULT 0,
        clicks        BIGINT      DEFAULT 0,
        spend         NUMERIC(14,4) DEFAULT 0,
        purchases     INT         DEFAULT 0,
        revenue       NUMERIC(14,4) DEFAULT 0,
        link_clicks   BIGINT      DEFAULT 0,
        add_to_cart   BIGINT      DEFAULT 0,
        initiate_checkout BIGINT  DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date, platform, ad_id)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_ads_brand_date    ON tw_ads_daily (brand, date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_ads_brand_platform ON tw_ads_daily (brand, platform)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_orders_detail (
        id                    BIGSERIAL PRIMARY KEY,
        brand                 TEXT        NOT NULL,
        order_id              TEXT        NOT NULL,
        order_number          INT,
        order_date            DATE,
        created_at_ts         TIMESTAMPTZ,
        customer_id           TEXT,
        financial_status      TEXT,
        fulfillment_status    TEXT,
        total_price           NUMERIC(14,4) DEFAULT 0,
        subtotal_price        NUMERIC(14,4) DEFAULT 0,
        total_discounts       NUMERIC(14,4) DEFAULT 0,
        total_tax             NUMERIC(14,4) DEFAULT 0,
        shipping_price        NUMERIC(14,4) DEFAULT 0,
        country               TEXT,
        province              TEXT,
        city                  TEXT,
        utm_source            TEXT,
        utm_medium            TEXT,
        utm_campaign          TEXT,
        is_first_order        BOOLEAN     DEFAULT FALSE,
        customer_order_number INT,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, order_id)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_orders_brand_date     ON tw_orders_detail (brand, order_date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_orders_brand_customer  ON tw_orders_detail (brand, customer_id)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_sessions_daily (
        id                   BIGSERIAL PRIMARY KEY,
        brand                TEXT        NOT NULL,
        date                 DATE        NOT NULL,
        total_sessions       BIGINT      DEFAULT 0,
        new_sessions         BIGINT      DEFAULT 0,
        returning_sessions   BIGINT      DEFAULT 0,
        bounced_sessions     BIGINT      DEFAULT 0,
        bounce_rate          NUMERIC(8,4),
        converted_sessions   BIGINT      DEFAULT 0,
        conversion_rate      NUMERIC(8,4),
        avg_duration_seconds INT,
        revenue              NUMERIC(14,4) DEFAULT 0,
        device_mobile        BIGINT      DEFAULT 0,
        device_desktop       BIGINT      DEFAULT 0,
        device_tablet        BIGINT      DEFAULT 0,
        total_pageviews      BIGINT      DEFAULT 0,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_sessions_brand_date ON tw_sessions_daily (brand, date DESC)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_customers (
        id                   BIGSERIAL PRIMARY KEY,
        brand                TEXT        NOT NULL,
        customer_id          TEXT        NOT NULL,
        total_orders         INT         DEFAULT 0,
        total_spent          NUMERIC(14,4) DEFAULT 0,
        average_order_value  NUMERIC(14,4),
        first_order_date     DATE,
        last_order_date      DATE,
        days_since_last_order INT,
        country              TEXT,
        cohort_month         DATE,
        first_order_source   TEXT,
        accepts_marketing    BOOLEAN     DEFAULT FALSE,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, customer_id)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_customers_brand         ON tw_customers (brand)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_customers_brand_country  ON tw_customers (brand, country)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_customers_cohort         ON tw_customers (brand, cohort_month)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_customer_segments (
        id                   BIGSERIAL PRIMARY KEY,
        brand                TEXT        NOT NULL,
        customer_id          TEXT        NOT NULL,
        segment_date         DATE        NOT NULL,
        rfm_segment          TEXT,
        recency_score        INT,
        frequency_score      INT,
        monetary_score       INT,
        days_since_last_order INT,
        total_orders         INT         DEFAULT 0,
        total_spent          NUMERIC(14,4) DEFAULT 0,
        churn_risk           TEXT,
        churn_probability    NUMERIC(8,4),
        segment_label        TEXT,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, customer_id, segment_date)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_segments_brand_date ON tw_customer_segments (brand, segment_date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_segments_rfm        ON tw_customer_segments (brand, rfm_segment)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_refunds_daily (
        id                 BIGSERIAL PRIMARY KEY,
        brand              TEXT        NOT NULL,
        date               DATE        NOT NULL,
        refund_count       INT         DEFAULT 0,
        refund_amount      NUMERIC(14,4) DEFAULT 0,
        avg_refund_amount  NUMERIC(14,4),
        avg_days_to_refund NUMERIC(8,2),
        units_refunded     INT         DEFAULT 0,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_refunds_brand_date ON tw_refunds_daily (brand, date DESC)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_email_sms_daily (
        id             BIGSERIAL PRIMARY KEY,
        brand          TEXT        NOT NULL,
        date           DATE        NOT NULL,
        platform       TEXT        NOT NULL DEFAULT '',
        channel        TEXT        NOT NULL DEFAULT 'email',
        campaign_name  TEXT        NOT NULL DEFAULT '',
        message_type   TEXT        NOT NULL DEFAULT 'campaign',
        sent           BIGINT      DEFAULT 0,
        delivered      BIGINT      DEFAULT 0,
        opens          BIGINT      DEFAULT 0,
        unique_opens   BIGINT      DEFAULT 0,
        clicks         BIGINT      DEFAULT 0,
        unique_clicks  BIGINT      DEFAULT 0,
        unsubscribes   BIGINT      DEFAULT 0,
        conversions    BIGINT      DEFAULT 0,
        revenue        NUMERIC(14,4) DEFAULT 0,
        open_rate      NUMERIC(8,4),
        click_rate     NUMERIC(8,4),
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date, platform, campaign_name, message_type)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_email_brand_date     ON tw_email_sms_daily (brand, date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_email_brand_platform  ON tw_email_sms_daily (brand, platform)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_benchmarks (
        id             BIGSERIAL PRIMARY KEY,
        brand          TEXT        NOT NULL,
        date           DATE        NOT NULL,
        vertical       TEXT        NOT NULL DEFAULT '',
        revenue_tier   TEXT,
        metric_name    TEXT        NOT NULL,
        metric_value   NUMERIC(14,6),
        percentile_25  NUMERIC(14,6),
        percentile_50  NUMERIC(14,6),
        percentile_75  NUMERIC(14,6),
        percentile_90  NUMERIC(14,6),
        sample_size    INT,
        benchmark_type TEXT        DEFAULT 'performance',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date, vertical, metric_name)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_benchmarks_brand_date ON tw_benchmarks (brand, date DESC)`);

    console.log('[PG] Tables initialized');
  } catch (e) {
    console.error('[PG] Table init failed:', e.message);
  }
}

// ── Middleware ──────────────────────────────────────────────────
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  store: new FileStore({ path: path.join(__dirname,'../data/sessions'), ttl: 30*24*60*60, retries: 0, logFn: ()=>{} }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false, saveUninitialized: false,
  cookie: {
    maxAge: 30*24*60*60*1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  }
}));

// ── App-level auth middleware ────────────────────────────────────
function requireAppAuth(req, res, next) {
  if (!req.session?.userId)
    return res.status(401).json({ error: 'Not authenticated', loginRequired: true });
  next();
}

// ── Rate limiter for auth endpoints ─────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

// ── Apply requireAppAuth globally to all API routes ──────────────
app.use('/api', requireAppAuth);

// ── App-level auth routes ─────────────────────────────────────────
app.get('/auth/app-status', (req, res) => {
  if (!req.session?.userId) return res.json({ authenticated: false });
  const user = db.prepare('SELECT id, email, name, role FROM users WHERE id=?').get([req.session.userId]);
  if (!user) { req.session.destroy(() => {}); return res.json({ authenticated: false }); }
  res.json({ authenticated: true, user });
});

app.post('/auth/app-signup', authLimiter, (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Name, email, and password are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const emailLow = email.toLowerCase().trim();
  if (!emailLow.endsWith('@nysonian.com'))
    return res.status(403).json({ error: 'Only @nysonian.com email addresses can create an account.' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get([emailLow]);
  if (existing) return res.status(400).json({ error: 'An account with this email already exists' });
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  const role = count.n === 0 ? 'admin' : 'viewer';
  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare('INSERT INTO users(email,password_hash,name,role) VALUES(?,?,?,?)').run([emailLow, hash, name.trim(), role]);
    const user = db.prepare('SELECT id,email,name,role FROM users WHERE email=?').get([emailLow]);
    if (!user) return res.status(500).json({ error: 'Account created but could not retrieve user' });
    req.session.userId = user.id;
    res.json({ ok: true, user });
  } catch(e) {
    console.error('[Signup]', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Could not create account' });
  }
});

app.post('/auth/app-login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get([email.toLowerCase().trim()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  db.prepare('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run([user.id]);
  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post('/auth/app-logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// ── Analytics routes ────────────────────────────────────────────
app.use('/api/analytics', requireAppAuth, analyticsRouter);

// ── AI Dashboard routes ─────────────────────────────────────────
app.use('/api/dashboards', requireAppAuth, dashRouter);

// ── Annotations ─────────────────────────────────────────────────
app.get('/api/annotations', (req, res) => {
  const rows = req.query.tab
    ? db.prepare('SELECT * FROM annotations WHERE tab=? ORDER BY created_at DESC').all([req.query.tab])
    : db.prepare('SELECT * FROM annotations ORDER BY created_at DESC').all();
  res.json(rows);
});
app.post('/api/annotations', (req, res) => {
  const { tab, row_key, metric, note, color, author } = req.body;
  if (!tab||!row_key||!note) return res.status(400).json({ error:'tab, row_key, note required' });
  const r = db.prepare('INSERT INTO annotations(tab,row_key,metric,note,color,author) VALUES(?,?,?,?,?,?)')
    .run([tab, row_key, metric||'', note, color||'yellow', author||'user']);
  res.json(db.prepare('SELECT * FROM annotations WHERE id=?').get([r.lastInsertRowid]));
});
app.put('/api/annotations/:id', (req, res) => {
  const { note, color } = req.body;
  db.prepare('UPDATE annotations SET note=?,color=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run([note, color||'yellow', req.params.id]);
  res.json(db.prepare('SELECT * FROM annotations WHERE id=?').get([req.params.id]));
});
app.delete('/api/annotations/:id', (req, res) => {
  db.prepare('DELETE FROM annotations WHERE id=?').run([req.params.id]);
  res.json({ ok:true });
});

// ── Highlights ──────────────────────────────────────────────────
app.post('/api/highlights', (req, res) => {
  const { tab, row_key, color } = req.body;
  if (!tab||!row_key) return res.status(400).json({ error:'tab, row_key required' });
  db.prepare('INSERT INTO highlights(tab,row_key,color) VALUES(?,?,?) ON CONFLICT(tab,row_key) DO UPDATE SET color=excluded.color')
    .run([tab, row_key, color||'yellow']);
  res.json({ ok:true });
});
app.delete('/api/highlights', (req, res) => {
  db.prepare('DELETE FROM highlights WHERE tab=? AND row_key=?').run([req.body.tab, req.body.row_key]);
  res.json({ ok:true });
});

// ── AI Chat (Smart — DB query capable) ──────────────────────────
const SMART_AI_SYSTEM = `You are the executive analytics AI for NOBL Air and Pilates FLO. You have DIRECT access to the PostgreSQL analytics database via the query_database tool. Use it freely — don't ask for permission, just query and answer.

━━━ COMPANIES ━━━
NOBL TRAVEL (nobltravel.com): Premium luggage & travel accessories. AirTag holders, carry-ons, check-in bags. Sells via Shopify + Amazon. Has NOBL Air subscription product (Appstle). Channels: Meta, Google, AppLovin, TikTok, Snapchat, Pinterest, Bing, X.

⚠️ CRITICAL RULE — NOBL TRAVEL + EU ARE ONE COMBINED ENTITY:
NOBL Travel operates ONE Shopify store that serves ALL regions including Europe (EU).
Due to TripleWhale regional tracking, EU appears as region='EU' in geo tables — but it is NOT a separate brand.
When querying NOBL data: WHERE brand='NOBL' already includes EU in all summary/channel metrics.
NEVER show NOBL without EU. NEVER compare NOBL vs NOBL EU. They are ALWAYS summed together.
EU contributes ~0.5–1% of NOBL revenue and appears as a region breakdown in tw_geo_daily — that is the ONLY place to see EU separately, and only for breakdown purposes.

PILATES FLO (pilatesflo.com): Pilates equipment — Portable Reformer, Home Reformer (metal), Studio Reformer (wooden). Sells via Shopify US + EU store (afmjag-r2.myshopify.com). FLO EU IS a separate Shopify store with its own brand tracking. EU revenue in EUR × 1.16 = USD.

━━━ DATABASE TABLES ━━━
tw_summary_daily(id, brand, date, total_revenue, total_spend, mer, total_orders, new_customer_orders, returning_customer_orders, order_revenue, shopify_revenue, amazon_revenue, total_sales, refund_amount, refund_count)
  → brand = 'NOBL' or 'FLO' | date is a DATE column (use date BETWEEN $1::date AND $2::date)
  → order_revenue = canonical revenue (Shopify+Amazon orders, before refunds) — USE THIS
  → total_revenue = TW attributed revenue — AVOID using for KPIs
  → total_sales = order_revenue - refund_amount (net, after refunds)
  → amazon_revenue ≈ $10-15k/day for NOBL; shopify_revenue = rest
  → Note: order_revenue populated by tw_order_revenue ETL task (NULL until backfill runs)

tw_channel_daily(id, brand, date, channel, spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d, new_cust_orders, cac)
  → channel values: 'META','GOOGLE','APPLOVIN','TIKTOK','SNAPCHAT','BING','PINTEREST','X'
  → Latest: 2026-04-22

tw_channel_daily_all(id, brand, date, tw_channel, spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d, new_cust_orders, cac)
  → tw_channel values: 'facebook-ads','google-ads','applovin','tiktok-ads','snapchat-ads','bing','pinterest-ads','twitter-ads'

tw_geo_daily(id, brand, date, region, revenue_actual, spend_actual, mer)
  → region values: 'US','CA','AUS','DUBAI','EU','TOTAL'
  → Use this for regional MER, revenue by country

tw_store_summary_daily(id, brand, store_key, shop_id, date, total_revenue, total_spend, mer)
  → store_key: 'NOBL_MAIN','FLO_MAIN','FLO_EU'

klaviyo_daily(id, date, brand, emails_sent, emails_opened, emails_clicked, open_rate, click_rate, revenue)
  → brand = 'NOBL' or 'FLO'

appstle_subscriptions(id, subscription_id, customer_id, status, product_title, sku, price, billing_interval, created_at, updated_at, next_billing_date)
  → status: 'active','paused','cancelled'
  → This is NOBL Air subscription data

nobl_air_sub_revenue_daily(id, date, revenue, orders, aov, created_at)
  → Daily NOBL Air subscription revenue

etl_run_log(id, run_id, brand, task, start_date, end_date, status, rows_written, error_message, started_at, finished_at)
  → Track ETL sync health

tw_ads_daily(id, brand, date, platform, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, impressions, clicks, spend, purchases, revenue, link_clicks, add_to_cart, initiate_checkout)
  → Campaign/adset/ad level performance from TW ads_table
  → platform values same as tw_channel_daily (META, GOOGLE, etc.)
  → UNIQUE(brand, date, platform, ad_id)

tw_orders_detail(id, brand, order_id, order_number, order_date, created_at_ts, customer_id, financial_status, fulfillment_status, total_price, subtotal_price, total_discounts, total_tax, shipping_price, country, province, city, utm_source, utm_medium, utm_campaign, is_first_order, customer_order_number)
  → Order-level detail from TW orders_table
  → financial_status: 'paid','partially_refunded','refunded'
  → is_first_order: boolean — true = new customer order

tw_sessions_daily(id, brand, date, total_sessions, new_sessions, returning_sessions, bounced_sessions, bounce_rate, converted_sessions, conversion_rate, avg_duration_seconds, revenue, device_mobile, device_desktop, device_tablet, total_pageviews)
  → Daily aggregated session/traffic data from TW sessions_table
  → bounce_rate and conversion_rate are decimals (0.xx format)

tw_customers(id, brand, customer_id, total_orders, total_spent, average_order_value, first_order_date, last_order_date, days_since_last_order, country, cohort_month, first_order_source, accepts_marketing)
  → Customer LTV snapshot from TW customers_table
  → cohort_month: DATE of first purchase month

tw_customer_segments(id, brand, customer_id, segment_date, rfm_segment, recency_score, frequency_score, monetary_score, days_since_last_order, total_orders, total_spent, churn_risk, churn_probability, segment_label)
  → RFM segmentation snapshot from TW customer_segmentation_table
  → rfm_segment / segment_label: e.g. 'Champions','Loyal','At Risk','Lost'
  → churn_risk: 'low','medium','high'
  → Refreshed daily (segment_date = today)

tw_refunds_daily(id, brand, date, refund_count, refund_amount, avg_refund_amount, avg_days_to_refund, units_refunded)
  → Daily refund aggregates from TW refunds_table
  → Refund rate = refund_amount / revenue from tw_summary_daily on same date

tw_email_sms_daily(id, brand, date, platform, channel, campaign_name, message_type, sent, delivered, opens, unique_opens, clicks, unique_clicks, unsubscribes, conversions, revenue, open_rate, click_rate)
  → Email/SMS campaign performance from TW email_sms_table
  → channel: 'email' or 'sms'
  → open_rate / click_rate are decimals (unique_opens/delivered, unique_clicks/delivered)

tw_benchmarks(id, brand, date, vertical, revenue_tier, metric_name, metric_value, percentile_25, percentile_50, percentile_75, percentile_90, sample_size, benchmark_type)
  → Industry benchmark data from TW benchmarks_table (monthly)
  → Compare brand metrics against industry percentiles

━━━ REVENUE — TWO METRICS, USE THE CORRECT ONE ━━━
⚠️ CRITICAL: total_revenue ≠ actual revenue. There are TWO revenue fields:

order_revenue  (CANONICAL — USE THIS for MER, AOV, all KPIs)
  = SUM of all actual Shopify + Amazon orders (total_price), BEFORE refunds
  = "Order Revenue" as shown in TW UI: "Revenue from orders after discounts, before refunds"
  = Shopify + Amazon combined. shopify_revenue and amazon_revenue show the split.
  ⚠️ FALLBACK: If order_revenue IS NULL (backfill not run yet), use total_revenue

total_revenue  (TW ATTRIBUTED — secondary, do NOT use for MER)
  = TripleWhale pixel-attributed/blended revenue
  = DIFFERENT from Shopify orders — attribution windows cause discrepancies
  = Example: Apr 28 NOBL: total_revenue=$515,707 but order_revenue=$531,679

total_sales
  = order_revenue - refund_amount (net revenue actually kept)
  = What you "take to the bank"

shopify_revenue  = Shopify-only orders (order_revenue minus Amazon)
amazon_revenue   = Amazon channel only (NOBL has ~$10-15k/day from Amazon)

━━━ KEY METRICS & FORMULAS ━━━
MER = COALESCE(order_revenue, total_revenue) / total_spend  [target ≥2.0, red <1.8]
ROAS = channel_revenue / channel_spend
NC ROAS = new_customer_revenue / spend
NVP% = new_visitors / total_visitors [target ≥50%]
CAC = spend / new_customer_orders
AOV = COALESCE(order_revenue, total_revenue) / total_orders
NC Rate = new_customer_orders / total_orders
Refund Rate = refund_amount / order_revenue
Net MER = total_sales / total_spend (after refunds)

━━━ THRESHOLDS (color coding) ━━━
MER Global/US/CA/AU/EU: red <1.8, yellow 1.8–2.0, green ≥2.0
MER Dubai/UAE: red <1.6, yellow 1.6–1.8, green ≥1.8
ROAS Meta: red <1.6, yellow 1.6–1.8, green ≥1.8
ROAS Google: red <2.0, yellow 2.0–3.0, green ≥3.0
ROAS AppLovin: red <2.0, yellow 2.0–2.2, green ≥2.2
ROAS TikTok/Snap/Pinterest: red <1.8, yellow 1.8–2.0, green ≥2.0
NVP%: red <45%, yellow 45–50%, green ≥50%
Refund Rate: red >13%, yellow 6–13%, green ≤6%
Returning Customer%: red <17%, yellow 17–23%, green ≥23%

━━━ CHANNELS ━━━
In tw_channel_daily: META, GOOGLE, APPLOVIN, TIKTOK, SNAPCHAT, BING, PINTEREST, X
In tw_channel_daily_all: facebook-ads, google-ads, applovin, tiktok-ads, snapchat-ads, bing, pinterest-ads, twitter-ads

━━━ REGIONS ━━━
US = United States, CA = Canada, AUS = Australia, DUBAI = UAE/Dubai, EU = European Union, TOTAL = all regions combined

━━━ BEHAVIOR RULES ━━━
1. NEVER ask clarifying questions — just answer with the data
2. If the user asks about a metric, query the database and show the actual numbers
3. Always show specific numbers, not vague answers
4. When returning data for charts/tables, format it as clean JSON in chartData
5. Be concise — executives want bullet points and numbers
6. Today is 2026-04-29. "Yesterday" = 2026-04-27 (latest available)
7. For date filtering: use DATE(date AT TIME ZONE 'UTC') = 'YYYY-MM-DD'::date
8. Return chartHint as: "line_chart", "bar_chart", "table", or "kpi_cards" based on what data you return`;

const DB_TOOL = {
  type: 'function',
  function: {
    name: 'query_database',
    description: 'Execute a SQL query against the PostgreSQL analytics database. Use this to answer any question about metrics, trends, channel performance, etc.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The PostgreSQL SQL query to execute. Always LIMIT results to 200 rows max.' },
        description: { type: 'string', description: 'Brief description of what this query fetches' }
      },
      required: ['sql']
    }
  }
};

app.post('/api/ai/chat', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { messages = [], activeTab = '' } = req.body;

    const systemMsg = {
      role: 'system',
      content: SMART_AI_SYSTEM + (activeTab ? `\n\nUser is currently viewing: "${activeTab}" tab.` : '')
    };

    const allMessages = [systemMsg, ...messages];
    let queryResult = null;
    let chartHint = null;

    // Round 1: let AI decide if it needs to query
    const round1 = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: allMessages,
      tools: [DB_TOOL],
      tool_choice: 'auto',
      max_tokens: 2000,
      temperature: 0.2,
    });

    const r1msg = round1.choices[0].message;

    // If AI wants to query the database
    if (r1msg.tool_calls?.length) {
      const toolCall = r1msg.tool_calls[0];
      const { sql, description } = JSON.parse(toolCall.function.arguments);

      let dbRows = [], dbColumns = [], dbError = null;
      try {
        // Safety: block destructive queries
        const upper = sql.trim().toUpperCase();
        if (/^(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER|CREATE)\s/.test(upper)) {
          throw new Error('Only SELECT queries are allowed');
        }
        const result = await pgQuery(sql + (sql.trim().toUpperCase().includes('LIMIT') ? '' : ' LIMIT 200'));
        dbColumns = result.fields?.map(f => f.name) || Object.keys(result.rows[0] || {});
        dbRows = result.rows.map(r => dbColumns.map(c => r[c]));
        queryResult = { columns: dbColumns, rows: dbRows, description, sql };
      } catch (e) {
        dbError = e.message;
        console.error('[AI DB Query]', e.message, '\nSQL:', sql);
      }

      // Round 2: feed results back to AI for final answer
      const toolResultContent = dbError
        ? `Query error: ${dbError}`
        : `Query returned ${dbRows.length} rows.\nColumns: ${dbColumns.join(', ')}\nData (first 20 rows): ${JSON.stringify(dbRows.slice(0, 20))}`;

      const round2 = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          ...allMessages,
          r1msg,
          { role: 'tool', tool_call_id: toolCall.id, content: toolResultContent }
        ],
        max_tokens: 1500,
        temperature: 0.2,
      });

      let reply = round2.choices[0].message.content || '';

      // Extract chartHint if AI included it
      const hintMatch = reply.match(/CHART_HINT:\s*(line_chart|bar_chart|table|kpi_cards)/i);
      if (hintMatch) {
        chartHint = hintMatch[1].toLowerCase();
        reply = reply.replace(/CHART_HINT:\s*(line_chart|bar_chart|table|kpi_cards)/i, '').trim();
      } else if (dbRows.length > 0) {
        // Auto-detect chart type
        if (dbColumns.includes('date') || dbColumns.some(c => c.includes('date'))) chartHint = 'line_chart';
        else if (dbRows.length <= 15 && dbColumns.length <= 4) chartHint = 'kpi_cards';
        else if (dbRows.length > 1 && dbColumns.some(c => c.includes('channel') || c.includes('region') || c.includes('brand'))) chartHint = 'bar_chart';
        else chartHint = 'table';
      }

      return res.json({ reply, queryResult, chartHint });
    }

    // No DB query needed — just return the text
    res.json({ reply: r1msg.content || '', queryResult: null, chartHint: null });

  } catch(e) {
    console.error('[AI Chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI Insights ──────────────────────────────────────────────────
app.post('/api/ai/insights', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { tab, headers, rows } = req.body;
    const sample = (rows || []).slice(0, 50);
    const prompt = `Analyze this analytics data named "${tab}" and give 3-4 sharp business insights.
Headers: ${JSON.stringify(headers)}
Data (${rows.length} rows, showing first 40): ${JSON.stringify(sample)}

Respond ONLY with valid JSON, no markdown, no code blocks:
{"insights":[{"type":"positive|negative|neutral|warning","title":"Short title max 6 words","text":"1-2 sentence insight with specific numbers"}],"summary":"One sentence executive summary"}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 700,
      temperature: 0.3,
    });
    let content = response.choices[0].message.content.trim();
    content = content.replace(/```json\n?|\n?```/g, '').trim();
    res.json(JSON.parse(content));
  } catch(e) {
    console.error('[AI Insights]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI Field Helper ────────────────────────────────────────────────────────
app.post('/api/ai/field-help', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { tab, field, currentValue, allFields } = req.body;
    const prompt = `The user is viewing the "${tab}" analytics section.
They are looking at the field: "${field}"
Current value: ${currentValue || '(empty)'}
All fields: ${JSON.stringify(allFields)}

In 2-3 sentences, explain what this metric means, what a good value looks like, and any context for NOBL Air or Pilates FLO's business.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      max_tokens: 200,
      temperature: 0.4,
    });
    res.json({ help: response.choices[0].message.content });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Dashboard Generator (clarify + generate) ──────────────────
app.post('/api/ai/dashboard-generate', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { messages = [] } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = getClarifyPrompt(today);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: 4000,
      temperature: 0.15,
    });

    let raw = response.choices[0].message.content.trim();

    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Detect if this is a JSON config or a natural-language clarification question
    const jsonStart = cleaned.search(/\{[\s\S]*"sections"/);

    if (jsonStart !== -1) {
      // AI generated a config — parse and validate it
      const jsonStr = cleaned.slice(jsonStart);
      let config;
      try {
        config = JSON.parse(jsonStr);
      } catch(parseErr) {
        console.error('[AI Dashboard Gen] Parse error:', parseErr.message, '\nRaw:', cleaned.slice(0, 300));
        // Return as a conversational message so user knows what happened
        return res.json({ message: raw + '\n\n(Note: JSON parse error — please try again with clearer requirements)' });
      }
      if (!config?.sections) {
        return res.json({ message: raw });
      }
      console.log('[AI Dashboard Gen] Config generated:', config.title, `(${config.sections.length} sections)`);
      return res.json({ config, message: raw });
    }

    // Natural language response (clarification questions or acknowledgement)
    console.log('[AI Dashboard Gen] Clarification response');
    res.json({ message: raw });

  } catch(e) {
    console.error('[AI Dashboard Gen]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sync trigger (manual + backfill) ─────────────────────────────
app.post('/api/sync/trigger', requireAppAuth, async (req, res) => {
  try {
    const {
      tasks     = ['klaviyo', 'appstle', 'tw_refresh'],
      startDate = null,
      endDate   = null,
      brands    = ['NOBL', 'FLO'],
      mode      = 'manual',
    } = req.body || {};

    // Determine date range
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
    const start = startDate || yesterday;
    const end   = endDate   || today;

    const runId = `${mode}_${Date.now()}`;
    syncEngine.runSync({ runId, tasks, startDate: start, endDate: end, brands })
      .catch(e => console.error('[Sync]', e.message));

    console.log(`[Sync] ${mode} started: ${runId} | tasks=${tasks.join(',')} | ${start}→${end}`);
    res.json({ ok: true, run_id: runId, message: `Sync started (${mode})`, tasks, startDate: start, endDate: end });
  } catch(e) {
    console.error('[Sync trigger]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sync status ──────────────────────────────────────────────────
app.use('/api/sync/status', requireAppAuth, syncStatusRouter);

// ── TripleWhale live data ─────────────────────────────────────────
app.use('/api/tw',    requireAppAuth, twRouter);
app.use('/api/store', requireAppAuth, storeRouter);

// ── Daily cron: 11:00 AM GMT+5 = 06:00 UTC ───────────────────────
// Fetches yesterday's data from all APIs and loads it into the DB.
try {
  const cron = require('node-cron');

  // '0 6 * * *' = 06:00 UTC = 11:00 AM Asia/Karachi (GMT+5)
  cron.schedule('0 6 * * *', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    const runId = `cron_daily_${yStr}_${Date.now()}`;
    console.log(`[Cron] ▶ Daily sync for ${yStr} → ${runId}`);
    syncEngine.runSync({
      runId,
      tasks: [
        'klaviyo', 'appstle', 'tw_refresh',
        'tw_channels', 'tw_geo',
        'tw_ads', 'tw_orders', 'tw_sessions',
        'tw_refunds', 'tw_email_sms',
        'tw_order_revenue',          // ← canonical revenue: Shopify+Amazon, before refunds
        'tw_customers', 'tw_segments', 'tw_benchmarks',
      ],
      startDate: yStr,
      endDate:   yStr,
      brands:    ['NOBL', 'FLO'],
    }).catch(e => console.error('[Cron sync error]', e.message));
  }, { timezone: 'UTC' });

  console.log('[Cron] Daily sync scheduled: 06:00 UTC (11:00 AM GMT+5)');
} catch(e) {
  console.warn('[Cron] node-cron unavailable:', e.message);
}

// ── Google Sheets utility helpers ────────────────────────────────

/**
 * Find the best header row index.
 * Strategy: find the first row where col 0-2 contains a real date (data start),
 * then pick the last non-empty row before it that has 3+ text-label cells.
 * Falls back to first row with 3+ non-empty cells.
 */
function findHeaderRow(values) {
  const looksLikeDate = (s) =>
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) ||
    /^\d{4}-\d{2}-\d{2}$/.test(s) ||
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(s);

  const looksLikeTextLabel = (s) => {
    if (!s || s.length < 2) return false;
    if (looksLikeDate(s)) return false;
    // Not a pure number or currency value
    const cleaned = s.replace(/[$,% ]/g, '');
    return isNaN(parseFloat(cleaned)) || cleaned === '';
  };

  // Step 1: find first row where column 0 or 1 contains a date → start of data
  // (Only check col 0-1 so we don't confuse date-range metadata in later columns)
  let dataStartIdx = -1;
  for (let i = 1; i < Math.min(values.length, 25); i++) {
    const row = values[i] || [];
    const col0 = String(row[0] || '').trim();
    const col1 = String(row[1] || '').trim();
    if (looksLikeDate(col0) || looksLikeDate(col1)) {
      dataStartIdx = i;
      break;
    }
  }

  if (dataStartIdx > 0) {
    // Step 2: scan backwards from dataStartIdx to find the best header row
    // Pick the row with the most text-label cells (not dates/numbers)
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = Math.max(0, dataStartIdx - 5); i < dataStartIdx; i++) {
      const row = values[i] || [];
      const score = row.filter(c => looksLikeTextLabel(String(c || '').trim())).length;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore >= 2) return bestIdx;
  }

  // Fallback: first row with 3+ non-empty cells
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    const row = values[i] || [];
    const nonEmpty = row.filter(c => c !== null && c !== undefined && String(c).trim() !== '').length;
    if (nonEmpty >= 3) return i;
  }
  return 0;
}

/**
 * Clean and deduplicate header names.
 * Empty header cells get a name inferred from data (Date, or ColA/ColB/...).
 */
function cleanHeaders(headers, firstDataRow) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const seen = {};
  return headers.map((h, i) => {
    let s = String(h || '').trim();
    if (!s) {
      // Infer from first data cell — if it looks like a date, call it "Date"
      const sample = String(firstDataRow?.[i] || '').trim();
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(sample)) {
        s = 'Date';
      } else if (sample && !/^\d+$/.test(sample)) {
        s = i < 26 ? letters[i] : `Col${i}`;
      } else {
        s = i < 26 ? letters[i] : `Col${i}`;
      }
    }
    const base = s;
    if (seen[base] !== undefined) {
      seen[base]++;
      s = `${base}_${seen[base]}`;
    } else {
      seen[base] = 0;
    }
    return s;
  });
}

/**
 * Filter data rows — skip rows that are clearly section labels
 * (only 0-2 non-empty cells and no numeric values).
 */
function filterDataRows(rows, headerCount) {
  return rows.filter(row => {
    const cells = row.slice(0, Math.max(headerCount, 5));
    const nonEmpty = cells.filter(c => c !== null && c !== undefined && String(c).trim() !== '');
    const hasNumber = nonEmpty.some(c => {
      const cleaned = String(c).replace(/[$,% ]/g, '');
      return !isNaN(parseFloat(cleaned)) && cleaned !== '';
    });
    // Keep rows with 3+ non-empty cells, or rows that have at least one number
    return nonEmpty.length >= 3 || (nonEmpty.length >= 1 && hasNumber);
  });
}

// ── Google Sheets helpers ─────────────────────────────────────────
// Supports two auth modes:
//   1. GOOGLE_API_KEY  — simplest, works for any sheet shared "anyone with link can view"
//   2. GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY — service account for private sheets
async function sheetsGet(path, params = {}) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const base = `https://sheets.googleapis.com/v4/spreadsheets${path}`;

  if (apiKey) {
    // Simple API key — works for public / "anyone with link" sheets
    const qs = new URLSearchParams({ ...params, key: apiKey }).toString();
    const r = await fetch(`${base}?${qs}`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Sheets API ${r.status}`);
    }
    return r.json();
  }

  if (clientEmail && privateKey) {
    // Service account via googleapis
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    // path is like "/{id}" or "/{id}/values/{range}"
    const parts = path.replace(/^\//, '').split('/values/');
    if (parts.length === 2) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: parts[0], range: decodeURIComponent(parts[1]) });
      return r.data;
    } else {
      const r = await sheets.spreadsheets.get({ spreadsheetId: parts[0], fields: params.fields });
      return r.data;
    }
  }

  throw new Error(
    'Google Sheets not configured. Add GOOGLE_API_KEY to your .env file.\n' +
    'Share your sheet with "Anyone with the link can view", then add:\n' +
    '  GOOGLE_API_KEY=your_key_here\n' +
    'Get a free key at: https://console.cloud.google.com → APIs & Services → Credentials'
  );
}

// ── Google Sheets import endpoint ────────────────────────────────
app.post('/api/sheets/import', requireAppAuth, async (req, res) => {
  const { spreadsheetId } = req.body;
  if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });
  try {
    const meta = await sheetsGet(`/${spreadsheetId}`, { fields: 'properties,sheets.properties' });
    const title = meta.properties?.title || 'Imported Sheet';
    const tabs  = (meta.sheets || []).map(s => ({
      name:    s.properties.title,
      sheetId: s.properties.sheetId,
      rowCount:s.properties.gridProperties?.rowCount || 0,
      colCount:s.properties.gridProperties?.columnCount || 0,
    }));
    res.json({ ok: true, title, spreadsheetId, tabs });
  } catch(e) {
    console.error('[Sheets import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Sheets tab data endpoint ──────────────────────────────
app.get('/api/sheets/tab', requireAppAuth, async (req, res) => {
  const { sheetId, tabName } = req.query;
  if (!sheetId || !tabName) return res.status(400).json({ error: 'sheetId and tabName required' });
  try {
    const range = encodeURIComponent(`'${tabName}'`);
    const data  = await sheetsGet(`/${sheetId}/values/${range}`);
    const values  = data.values || [];

    // Smart header detection — many sheets have empty rows 1-7 before real headers
    const headerIdx  = findHeaderRow(values);
    const rawHeaders = values[headerIdx] || [];
    const rawRows    = values.slice(headerIdx + 1);

    // Filter data rows first so we use real data (not metadata rows) for type inference
    const filteredRaws = filterDataRows(rawRows, rawHeaders.length);
    const firstRealDataRow = filteredRaws[0] || rawRows[0] || [];

    // Clean + deduplicate header names using actual data rows for type inference
    const headers = cleanHeaders(rawHeaders, firstRealDataRow);

    res.json({ ok: true, headers, rows: filteredRaws, rowCount: filteredRaws.length, headerRowIndex: headerIdx });
  } catch(e) {
    console.error('[Sheets tab]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Sheets AI Analysis ────────────────────────────────────
app.post('/api/sheets/analyze', requireAppAuth, async (req, res) => {
  const { spreadsheetId, tabs } = req.body;
  if (!spreadsheetId || !tabs?.length) return res.status(400).json({ error: 'spreadsheetId and tabs required' });
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });

  try {
    // Fetch sample data from ALL tabs (up to 16), using smart header detection
    const tabSamples = [];
    for (const tab of tabs.slice(0, 16)) {
      try {
        const range = encodeURIComponent(`'${tab.name}'`);
        const data = await sheetsGet(`/${spreadsheetId}/values/${range}`);
        const values = data.values || [];

        // Smart header detection
        const headerIdx  = findHeaderRow(values);
        const rawHeaders = values[headerIdx] || [];
        const rawRows    = values.slice(headerIdx + 1);
        const firstDataRow = rawRows[0] || [];
        const headers = cleanHeaders(rawHeaders, firstDataRow);
        const dataRows = filterDataRows(rawRows, headers.length);

        tabSamples.push({
          name: tab.name,
          headers,
          sampleRows: dataRows.slice(0, 20),  // 20 data rows for AI context
          totalDataRows: dataRows.length,
          isEmpty: headers.length < 2 || dataRows.length === 0,
        });
      } catch(e) {
        console.warn(`[Analyze] Tab "${tab.name}": ${e.message}`);
        tabSamples.push({ name: tab.name, headers: [], sampleRows: [], totalDataRows: 0, isEmpty: true });
      }
    }

    if (!tabSamples.length) return res.status(400).json({ error: 'No readable tabs found' });

    const prompt = `You are building a beautiful, rich analytics dashboard for NOBL Air (DTC travel accessories brand) and Pilates FLO (fitness equipment brand). You have access to their Google Sheets performance data across ${tabSamples.length} tabs.

BUSINESS CONTEXT:
- NOBL Air: Sells AirTag holders, travel gear. Key KPIs: Revenue (F=Forecast, A=Actual), Spend, MER (Marketing Efficiency Ratio = Revenue/Spend), Orders, CAC, ROAS, Subscription Revenue, regional breakdown (US/CA/AUS/Dubai/EU)
- Pilates FLO: Sells Portable/Wooden/Metal Reformers. Key KPIs: Revenue, Spend, Orders, CAC, product-line breakdown, regional performance
- Channels: Meta, Google, Applovin, Snapchat, TikTok, Pinterest, Bing, X
- MER target is ~3.5x, good ROAS is 3x+, pacing = actual/forecast %

HERE ARE ALL ${tabSamples.length} TABS WITH THEIR REAL DATA:

${tabSamples.map(t => `
╔══ TAB: "${t.name}" ══ (${t.totalDataRows} data rows)
${t.isEmpty ? '(empty — no parseable data)' : `COLUMNS (${t.headers.length} total): ${t.headers.slice(0, 30).join(' | ')}
SAMPLE DATA (first 20 rows):
${t.sampleRows.slice(0, 20).map((r, ri) => `  row${ri+1}: ${r.slice(0, Math.min(t.headers.length, 20)).join(' | ')}`).join('\n')}`}
`).join('\n')}

YOUR TASK: Generate a JSON config that creates a rich, beautiful dashboard for EVERY one of these ${tabSamples.length} tabs.

CRITICAL RULES:
1. Generate an entry in "analyzedTabs" for EVERY tab — all ${tabSamples.length} of them. No exceptions.
2. Field names in your config MUST EXACTLY match the column header strings above — copy them character-for-character including spaces, parentheses, slashes.
3. For empty tabs: include them with sections:[] so they still appear in the tab strip.
4. The "Date" column (or first column with date-like values) is always the xField for time-series charts.

SECTION TYPES TO USE:
- "kpi_row": Summary cards at the top. Use aggregation="sum" for revenue/spend/orders, "latest" for current-day values, "average" for rates (MER, ROAS, CVR %).
- "area_chart": For time-series data (date on x-axis, metrics on y-axis). Max 3 series.
- "bar_chart": For categorical comparisons (Channel, Region, Product on x-axis). The renderer auto-aggregates by category.
- "line_chart": For trend comparisons with multiple lines. Max 3 series.
- "table": Always include a full data table. Show the most useful columns (max 12).

FORMAT RULES (apply to every field/item):
- "currency" → any Revenue, Spend, Budget, Cost, Sales, CAC, AOV, Variance columns
- "percent" → MER, ROAS, CVR, Rate, Pacing, %, YoY columns
- "number" → Orders, Units, Count, Clicks, Subscribers, Visitors, Purchases
- "date" → Date, Week, Month, Day columns
- "text" → Channel, Region, Product name columns

COLORS:
- Revenue/Sales: #6366f1 (indigo)
- Spend/Cost: #f59e0b (amber)
- MER/ROAS/CVR: #14b8a6 (teal)
- Orders: #8b5cf6 (violet)
- Forecast: dashed, same color
- Actual: solid
- Other series: #ef4444, #06b6d4, #1877f2, #10b981

TAB-SPECIFIC GUIDANCE based on what I can see in the data:
- Tabs with "Topline" in name: daily date rows, has Revenue (F), Revenue (A), Variance ($), Spend (F), Spend (A) columns → area_chart for Revenue (F) vs Revenue (A) trend, kpi_row for MTD totals
- Tabs with "YoY" in name: months as rows, metric categories — use bar_chart to compare 2025 vs 2026
- Tabs with "Channel" in name: has channel categories → bar_chart grouped by Channel
- Tabs with "Targets" in name: quarterly targets vs actuals → kpi_row showing pacing %
- Tabs with "Visitors" or "CVR" in name: date rows with regional visitor/CVR data → area_chart CVR trend
- "YTD/QTD" tabs: summary metrics, use kpi_row + table
- "Charts" tabs: likely already-aggregated data, use bar_chart + table

OUTPUT FORMAT — respond with ONLY this JSON (no markdown, no explanation):
{
  "title": "Nobl + Flo Performance Dashboard",
  "analyzedTabs": [
    {
      "sheetTabName": "exact tab name from above",
      "displayName": "Short Label",
      "sections": [
        {
          "type": "kpi_row",
          "title": "Key Metrics",
          "aggregation": "sum",
          "items": [
            {"label": "Total Revenue", "field": "Revenue (A)", "format": "currency"},
            {"label": "Total Spend", "field": "Spend (A)", "format": "currency"},
            {"label": "Avg MER", "field": "MER", "format": "percent", "aggregation": "average"}
          ]
        },
        {
          "type": "area_chart",
          "title": "Revenue: Forecast vs Actual",
          "xField": "Date",
          "series": [
            {"field": "Revenue (F)", "label": "Forecast", "color": "#a5b4fc"},
            {"field": "Revenue (A)", "label": "Actual", "color": "#6366f1"}
          ]
        },
        {
          "type": "bar_chart",
          "title": "Spend by Channel",
          "xField": "Channel",
          "series": [
            {"field": "Spend (A)", "label": "Spend", "color": "#f59e0b"}
          ]
        },
        {
          "type": "table",
          "title": "Daily Performance",
          "columns": [
            {"field": "Date", "label": "Date", "format": "date"},
            {"field": "Revenue (A)", "label": "Revenue", "format": "currency"},
            {"field": "Spend (A)", "label": "Spend", "format": "currency"},
            {"field": "MER", "label": "MER", "format": "percent"}
          ]
        }
      ]
    }
  ]
}

Remember: use the EXACT column names from the tab data above. Generate configs for ALL ${tabSamples.length} tabs.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 16000,
    });

    const config = JSON.parse(completion.choices[0].message.content);
    console.log(`[Sheets analyze] Generated ${config.analyzedTabs?.length || 0} tab configs for "${config.title}"`);
    res.json({ ok: true, config });
  } catch(e) {
    console.error('[Sheets analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Serve React ─────────────────────────────────────────────────
const clientBuild = path.join(__dirname,'../client/build');
app.use(express.static(clientBuild));
app.get('*', (req, res) => res.sendFile(path.join(clientBuild, 'index.html')));

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n  NOBL Analytics Dashboard → http://localhost:${PORT}\n`);
  await initPostgresTables();
});
