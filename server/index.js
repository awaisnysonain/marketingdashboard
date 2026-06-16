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
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const OpenAI = require('openai').default;
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const { pool: pgPool, sessionPool, pgRun, pgQuery, cleanupStaleConnections } = require('./db/postgres');
const PgSession = require('connect-pg-simple')(session);
const analyticsRouter = require('./routes/analytics');
const { router: dashRouter, SCHEMA_CONTEXT, getClarifyPrompt } = require('./routes/aiDashboards');
const syncStatusRouter = require('./routes/syncStatus');
const syncEngine = require('./etl/syncEngine');
const { ensureNoblAirRegionDailyTable } = require('./etl/noblAirAggregate');
const { ensureNoblAirMetaAdDailyTable } = require('./etl/noblAirMetaAdDaily');
const { ensureNoblAirTtpSnapshotTable } = require('./etl/noblAirTtpSnapshot');
const { ensureBrandTwViews } = require('./etl/ensureBrandTwViews');
const { isAuthBypassEnabled, getDevBypassUser, isAdminSession, effectiveUserId } = require('./auth');
const twRouter    = require('./routes/triplewhale');
const storeRouter = require('./routes/store');
const commentsRouter = require('./routes/comments');

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

// App tables (users / annotations / highlights / settings / sessions) live in Postgres now —
// see initPostgresTables() below. SQLite has been retired.

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
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_ads_meta_perf ON tw_ads_daily (brand, platform, date DESC)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS meta_ads_daily (
        id BIGSERIAL PRIMARY KEY,
        brand TEXT NOT NULL,
        date DATE NOT NULL,
        platform TEXT NOT NULL DEFAULT 'META',
        campaign_id TEXT NOT NULL DEFAULT '',
        campaign_name TEXT,
        adset_id TEXT NOT NULL DEFAULT '',
        adset_name TEXT,
        ad_id TEXT NOT NULL,
        ad_name TEXT,
        impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0,
        spend NUMERIC(14,4) DEFAULT 0,
        purchases INT DEFAULT 0,
        revenue NUMERIC(14,4) DEFAULT 0,
        link_clicks BIGINT DEFAULT 0,
        add_to_cart BIGINT DEFAULT 0,
        initiate_checkout BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, date, platform, ad_id)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_meta_ads_brand_date ON meta_ads_daily (brand, date DESC)`);

    await pgRun(`
      CREATE TABLE IF NOT EXISTS tw_air_order_attribution (
        id                 BIGSERIAL PRIMARY KEY,
        brand              TEXT        NOT NULL,
        date               DATE        NOT NULL,
        order_id           TEXT        NOT NULL,
        order_name         TEXT,
        channel            TEXT        NOT NULL,
        model              TEXT        NOT NULL,
        attribution_window TEXT        NOT NULL,
        campaign_id        TEXT        NOT NULL DEFAULT '',
        campaign_name      TEXT,
        adset_id           TEXT        NOT NULL DEFAULT '',
        adset_name         TEXT,
        ad_id              TEXT        NOT NULL DEFAULT '',
        ad_name            TEXT,
        linear_weight      NUMERIC(14,6) DEFAULT 1,
        order_revenue      NUMERIC(14,4) DEFAULT 0,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (brand, order_id, channel, model, attribution_window, campaign_id, adset_id, ad_id)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_brand_date ON tw_air_order_attribution (brand, date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_channel ON tw_air_order_attribution (brand, channel, date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_adset ON tw_air_order_attribution (brand, adset_id, date DESC)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_perf ON tw_air_order_attribution (brand, channel, model, attribution_window, date DESC)`);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS flo_appstle_subscribers (
        appstle_id TEXT PRIMARY KEY,
        graph_subscription_contract_id TEXT,
        subscription_contract_id TEXT,
        customer_id TEXT,
        customer_email TEXT,
        customer_name TEXT,
        order_name TEXT,
        graph_order_id TEXT,
        status TEXT,
        contract_amount NUMERIC(14,4),
        order_amount NUMERIC(14,4),
        billing_policy_interval TEXT,
        billing_policy_interval_count INT,
        currency_code TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        next_billing_date TIMESTAMPTZ,
        last_billing_date TIMESTAMPTZ,
        cancelled_on TIMESTAMPTZ,
        is_mature BOOLEAN DEFAULT FALSE,
        is_converted BOOLEAN DEFAULT FALSE,
        is_same_day_cancel BOOLEAN DEFAULT FALSE,
        raw_json JSONB,
        etl_fetched_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_created_at ON flo_appstle_subscribers (created_at)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_order_name ON flo_appstle_subscribers (order_name)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_status ON flo_appstle_subscribers (status)`);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS flo_appstle_billing_attempts (
        subscription_appstle_id TEXT NOT NULL,
        attempt_key TEXT NOT NULL,
        attempt_id TEXT,
        order_id TEXT,
        order_name TEXT,
        attempt_status TEXT,
        attempt_date TIMESTAMPTZ,
        amount NUMERIC(14,4),
        currency_code TEXT,
        is_successful BOOLEAN DEFAULT FALSE,
        is_initial_order BOOLEAN DEFAULT FALSE,
        raw_json JSONB,
        etl_fetched_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (subscription_appstle_id, attempt_key)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_date ON flo_appstle_billing_attempts (attempt_date)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_success ON flo_appstle_billing_attempts (is_successful, is_initial_order, attempt_date)`);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_flo_appstle_attempt_order_id ON flo_appstle_billing_attempts (order_id)`);
    await pgRun(`
      CREATE TABLE IF NOT EXISTS flo_appstle_revenue_daily (
        date DATE PRIMARY KEY,
        shopify_sub_gross NUMERIC(14,4) DEFAULT 0,
        shopify_sub_disc NUMERIC(14,4) DEFAULT 0,
        shopify_sub_refunds NUMERIC(14,4) DEFAULT 0,
        rebill_revenue NUMERIC(14,4) DEFAULT 0,
        new_sub_revenue NUMERIC(14,4) DEFAULT 0,
        sub_revenue_actual NUMERIC(14,4) DEFAULT 0,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_air_sub_order_name ON nobl_air_subscribers (order_name)`).catch(() => {});
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_air_sub_graph_order_id ON nobl_air_subscribers (graph_order_id)`).catch(() => {});
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_air_sub_created_at ON nobl_air_subscribers (created_at)`).catch(() => {});
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_air_sub_status ON nobl_air_subscribers (LOWER(TRIM(status)))`).catch(() => {});
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_nobl_air_daily_date ON nobl_air_daily (date DESC)`).catch(() => {});
    await ensureNoblAirRegionDailyTable();
    await ensureNoblAirMetaAdDailyTable();
    await ensureNoblAirTtpSnapshotTable();

    await ensureBrandTwViews();

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

    // ── App-internal tables (formerly SQLite) ─────────────────────
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
      CREATE TABLE IF NOT EXISTS dashboard_comments (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        page_key      TEXT NOT NULL,
        target_type   TEXT NOT NULL,
        target_key    TEXT NOT NULL,
        comment_text  TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (page_key, target_type, target_key)
      )
    `);
    await pgRun(`CREATE INDEX IF NOT EXISTS idx_dashboard_comments_page ON dashboard_comments(page_key)`);
    await pgRun(`ALTER TABLE dashboard_comments ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team'`);
    await pgRun(`ALTER TABLE dashboard_comments ADD COLUMN IF NOT EXISTS author_name TEXT`);
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

    console.log('[PG] Tables initialized');
  } catch (e) {
    console.error('[PG] Table init failed:', e.message);
  }
}

// ── Middleware ──────────────────────────────────────────────────
app.use(compression());
// Allow the ERP (and self) to iframe us; disable the default X-Frame-Options
// (which is SAMEORIGIN) and instead set CSP frame-ancestors via a small
// middleware so we don't fight helmet's CSP default-src requirement.
const ERP_FRAME_ANCESTOR = process.env.ERP_FRAME_ANCESTOR || 'https://erp.nysonik.com';
app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${ERP_FRAME_ANCESTOR}`);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));
// In production we run inside the ERP iframe (cross-site), so the session
// cookie must be SameSite=None + Secure. In dev (NODE_ENV !== 'production')
// we keep Lax so plain http://localhost works.
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
  store: new PgSession({ pool: sessionPool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false, saveUninitialized: false,
  cookie: {
    maxAge: 30*24*60*60*1000,
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure:   isProd, // SameSite=None requires Secure
  }
}));

// ── App-level auth middleware ────────────────────────────────────
// Accepts EITHER:
//   - req.session.erp     — ERP-issued session (from POST /auth/erp-verify)
//   - req.session.userId  — legacy local app_users session (kept for backward compat)
// In dev (NODE_ENV !== 'production'), auth is bypassed as a fake admin.
function requireAppAuth(req, res, next) {
  if (isAuthBypassEnabled()) return next();
  // ERP session — verify it hasn't passed its issued expires_at.
  if (req.session?.erp) {
    const exp = Number(req.session.erp.expires_at || 0);
    if (exp > 0 && exp * 1000 < Date.now()) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'ERP session expired', loginRequired: true });
    }
    return next();
  }
  if (req.session?.userId) return next();
  return res.status(401).json({ error: 'Not authenticated', loginRequired: true });
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
app.get('/auth/app-status', async (req, res) => {
  if (isAuthBypassEnabled()) {
    return res.json({ authenticated: true, user: getDevBypassUser() });
  }

  // ERP session — preferred when present
  if (req.session?.erp) {
    const e = req.session.erp;
    const now = Math.floor(Date.now() / 1000);
    if (Number(e.expires_at || 0) > 0 && e.expires_at < now) {
      req.session.destroy(() => {});
      return res.json({ authenticated: false, expired: true });
    }
    return res.json({
      authenticated: true,
      user: {
        id:       e.id,
        email:    e.email,
        name:     e.name,
        role:     e.role || 'viewer',
        nav_group:           e.nav_group || null,
        portals:             e.portals || [],
        content_permissions: e.content_permissions || {},
        theme:               e.theme || 'dark',
        expires_at:          e.expires_at || null,
        source:              'erp',
      },
    });
  }

  // Legacy local-account fallback (kept so existing app_users sessions don't break)
  if (req.session?.userId) {
    const r = await pgQuery('SELECT id, email, name, role FROM app_users WHERE id=$1', [req.session.userId]);
    const user = r.rows[0];
    if (!user) { req.session.destroy(() => {}); return res.json({ authenticated: false }); }
    return res.json({ authenticated: true, user: { ...user, source: 'local' } });
  }

  return res.json({ authenticated: false });
});

// ── ERP token verification ────────────────────────────────────────
// Frontend POSTs { token, theme } here when the dashboard is opened from
// the ERP iframe with ?_erp_token=...&theme=light|dark. We POST the token
// to the ERP verify endpoint server-side, then mint a session cookie that
// lives until the ERP-issued expires_at.
const ERP_VERIFY_URL = process.env.ERP_VERIFY_URL || 'https://erp.nysonik.com/api/dashboard-token-verify.php';

function normalizeTheme(t) {
  const s = String(t || '').toLowerCase().trim();
  return s === 'light' ? 'light' : 'dark';
}

app.post('/auth/erp-verify', authLimiter, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const theme = normalizeTheme(req.body?.theme);
  if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });

  try {
    // Forward to ERP as multipart form-data (matches the Postman spec)
    const form = new URLSearchParams();
    form.set('token', token);
    const upstream = await fetch(ERP_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!data || data.valid !== true) {
      return res.status(401).json({ ok: false, error: data?.error || 'Invalid or expired ERP token' });
    }

    const emp = data.employee || {};
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number(data.expires_at || (now + 7200));

    // Stash on session
    req.session.erp = {
      id:                  emp.id || null,
      email:               String(emp.email || '').toLowerCase().trim(),
      name:                emp.name || '',
      role:                roleForEmail(emp.email) === 'admin' ? 'admin' : 'viewer',
      nav_group:           data.nav_group || null,
      portals:             Array.isArray(data.portals) ? data.portals : [],
      content_permissions: data.content_permissions || {},
      theme,
      issued_at:           Number(data.issued_at || now),
      expires_at:          expiresAt,
    };

    // Trim cookie lifetime to the ERP token's own expiry (cap at 2h)
    const ttlMs = Math.max(60_000, (expiresAt - now) * 1000);
    req.session.cookie.maxAge = ttlMs;

    res.json({
      ok: true,
      user: {
        id:                  req.session.erp.id,
        email:               req.session.erp.email,
        name:                req.session.erp.name,
        role:                req.session.erp.role,
        nav_group:           req.session.erp.nav_group,
        portals:             req.session.erp.portals,
        content_permissions: req.session.erp.content_permissions,
        theme:               req.session.erp.theme,
        expires_at:          req.session.erp.expires_at,
        source:              'erp',
      },
    });
  } catch (e) {
    console.error('[ERP verify]', e.message);
    res.status(502).json({ ok: false, error: 'ERP verify request failed' });
  }
});

// Single admin email — everyone else is 'viewer' regardless of signup order.
// This is intentional: admin powers (sync trigger, future settings) only ever
// belong to this address. To grant elsewhere, change ADMIN_EMAIL env or add an
// explicit role-update endpoint.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'muhammad.awais@nysonian.com').toLowerCase().trim();

function roleForEmail(email) {
  return String(email || '').toLowerCase().trim() === ADMIN_EMAIL ? 'admin' : 'viewer';
}

app.post('/auth/app-signup', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Name, email, and password are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const emailLow = email.toLowerCase().trim();
  if (!emailLow.endsWith('@nysonian.com'))
    return res.status(403).json({ error: 'Only @nysonian.com email addresses can create an account.' });
  try {
    const existing = await pgQuery('SELECT id FROM app_users WHERE email=$1', [emailLow]);
    if (existing.rows.length) return res.status(400).json({ error: 'An account with this email already exists' });
    // Role is determined by email, not by signup order.
    const role = roleForEmail(emailLow);
    const hash = bcrypt.hashSync(password, 12);
    const ins = await pgQuery(
      `INSERT INTO app_users (email, password_hash, name, role)
       VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role`,
      [emailLow, hash, name.trim(), role]
    );
    const user = ins.rows[0];
    req.session.userId = user.id;
    res.json({ ok: true, user });
  } catch(e) {
    console.error('[Signup]', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Could not create account' });
  }
});

app.post('/auth/app-login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });
  const emailLow = email.toLowerCase().trim();
  const r = await pgQuery('SELECT * FROM app_users WHERE email=$1', [emailLow]);
  const user = r.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  // Re-assert role at every login — guarantees only ADMIN_EMAIL is admin
  // (handles legacy accounts and prevents accidental promotions).
  const expectedRole = roleForEmail(user.email);
  if (user.role !== expectedRole) {
    await pgRun('UPDATE app_users SET role=$1 WHERE id=$2', [expectedRole, user.id]);
    user.role = expectedRole;
  }
  await pgRun('UPDATE app_users SET last_login = NOW() WHERE id=$1', [user.id]);
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

// ── Dashboard comments (KPI / cell notes) ─────────────────────────
app.use('/api/comments', requireAppAuth, commentsRouter);

// ── Annotations ─────────────────────────────────────────────────
app.get('/api/annotations', async (req, res) => {
  const r = req.query.tab
    ? await pgQuery('SELECT * FROM app_annotations WHERE tab=$1 ORDER BY created_at DESC', [req.query.tab])
    : await pgQuery('SELECT * FROM app_annotations ORDER BY created_at DESC', []);
  res.json(r.rows);
});
app.post('/api/annotations', async (req, res) => {
  const { tab, row_key, metric, note, color, author } = req.body;
  if (!tab||!row_key||!note) return res.status(400).json({ error:'tab, row_key, note required' });
  const r = await pgQuery(
    `INSERT INTO app_annotations (tab, row_key, metric, note, color, author)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tab, row_key, metric||'', note, color||'yellow', author||'user']
  );
  res.json(r.rows[0]);
});
app.put('/api/annotations/:id', async (req, res) => {
  const { note, color } = req.body;
  const r = await pgQuery(
    `UPDATE app_annotations SET note=$1, color=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
    [note, color||'yellow', req.params.id]
  );
  res.json(r.rows[0] || null);
});
app.delete('/api/annotations/:id', async (req, res) => {
  await pgRun('DELETE FROM app_annotations WHERE id=$1', [req.params.id]);
  res.json({ ok:true });
});

// ── Highlights ──────────────────────────────────────────────────
app.post('/api/highlights', async (req, res) => {
  const { tab, row_key, color } = req.body;
  if (!tab||!row_key) return res.status(400).json({ error:'tab, row_key required' });
  await pgRun(
    `INSERT INTO app_highlights (tab, row_key, color) VALUES ($1,$2,$3)
     ON CONFLICT (tab, row_key) DO UPDATE SET color = EXCLUDED.color`,
    [tab, row_key, color||'yellow']
  );
  res.json({ ok:true });
});
app.delete('/api/highlights', async (req, res) => {
  await pgRun('DELETE FROM app_highlights WHERE tab=$1 AND row_key=$2', [req.body.tab, req.body.row_key]);
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

PILATES FLO (pilatesflo.com): Pilates equipment — Portable Reformer, Home Reformer (metal), Studio Reformer (wooden). The dashboard's FLO totals are FLO US only. FLO EU is a separate Shopify store and is excluded from FLO total_revenue/total_spend.

━━━ DATABASE TABLES ━━━
tw_summary_daily(id, brand, date, total_revenue, total_spend, mer, total_orders, new_customer_orders, returning_customer_orders, order_revenue, gross_minus_discounts, shopify_revenue, amazon_revenue, total_sales, refund_amount, refund_count)
  → brand = 'NOBL' or 'FLO' | date is a DATE column (use date BETWEEN $1::date AND $2::date)
  → order_revenue/total_revenue = Gross Product Sales + Shipping + Taxes − Discounts (canonical revenue metric for MER)
  → total_spend = SUM(ads_table.spend) via tw_refresh (tw_order_revenue does NOT overwrite spend)
  → Use COALESCE(order_revenue, total_revenue) only if you need compatibility with older rows
  → total_sales = order_revenue - refund_amount (net, after refunds)
  → amazon_revenue = total Amazon marketplace order revenue (orders_table; Seller Central OPS basis)
  → Note: order_revenue populated by tw_order_revenue ETL task (NULL until backfill runs)

tw_channel_daily(id, brand, date, channel, spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d, new_cust_orders, cac)
  → spend_1d = ads_table.spend by channel (facebook-ads→META, etc.; AMAZON included for NOBL)
  → revenue_1d / purchases_1d = pixel_joined_tvf Triple Attribution 1_day (NOT ads_table revenue)
  → AMAZON exception: revenue_1d = ads_table.conversion_value (Amazon Ads platform-attributed OPS)
  → channel values: 'META','GOOGLE','APPLOVIN','TIKTOK','SNAPCHAT','BING','PINTEREST','X','AMAZON'
  → Use MAX(date) to determine latest available data; do not assume wall-clock today has synced.

tw_channel_daily_all(id, brand, date, tw_channel, spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d, new_cust_orders, cac)
  → tw_channel values: 'facebook-ads','google-ads','applovin','tiktok-ads','snapchat-ads','bing','pinterest-ads','twitter-ads'

tw_geo_daily(id, brand, date, region, revenue_actual, spend_actual, mer)
  → revenue_actual = Shopify orders_table by shipping country
  → spend_actual = ads_table country breakdown (US/CA/AUS/Dubai/EU actual; OTHER = no country breakout)
  → region values: 'US','CA','AUS','DUBAI','EU','OTHER','TOTAL'
  → Use this for regional MER, revenue by country

tw_store_summary_daily(id, brand, store_key, shop_id, date, total_revenue, total_spend, mer)
  → store_key: 'NOBL_MAIN','FLO_MAIN','FLO_EU'

klaviyo_daily(id, date, brand, emails_sent, emails_opened, emails_clicked, open_rate, click_rate, revenue)
  → brand = 'NOBL' or 'FLO'

nobl_air_subscribers(appstle_id, customer_email, customer_name, order_name, status, contract_amount, order_amount, billing_policy_interval, currency_code, created_at, last_billing_date, next_billing_date, cancelled_on, is_mature, is_converted, is_same_day_cancel)
  → 18,779+ Appstle subscription contracts. Date column is created_at (TIMESTAMPTZ).
  → contract_amount = the monthly tier (49, 79, 89, 99, 109, 119, 129, 139, 149, 159).
  → status values: 'active','cancelled','paused'.
  → is_converted = the customer was actually billed (lastSuccessfulOrder.orderAmount > 0).
  → is_mature = created >= 14 days ago. TTP rate = converted / mature within cohort.

nobl_air_daily(date, total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders, same_day_cancels, attach_rate, ttp_rate, activation_rate, tag_net_sales, sub_net_sales, rebill_revenue, new_sub_revenue, combined_net_revenue, new_49..new_159, rebill_49..rebill_159)
  → NOBL Air daily metrics — mirrors the technical doc's "Daily Input" tab.
  → No brand filter (NOBL Air-only product). Data starts 2026-02 (product launched March 2026).
  → attach_rate / ttp_rate / activation_rate are decimals (0.0–1.0). Multiply by 100 for %.

shopify_product_daily(brand, date, product_title, sku_prefix, units_sold, order_count, gross_revenue, discounts, net_revenue, refunds)
  → Per-product daily aggregation for BOTH brands, derived from Shopify line items.
  → Use this for product breakdowns ("top NOBL products", "FLO subscription revenue", etc.).

shopify_orders_raw(brand, store_key, order_id, order_name, created_at, date_key, customer_email, total_price, shipping_country, has_air, has_luggage, is_rebill, has_paid_air, tag_gross, sub_gross)
  → Per-order detail. Date column is date_key (DATE). 600K+ rows.
  → has_air = order contains a NOBLAIR-prefixed SKU. is_rebill = NOBLAIR with no luggage SKU.

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

━━━ REVENUE — USE DASHBOARD-CANONICAL FIELDS ━━━
For current dashboard tables, total_revenue and order_revenue are kept aligned for brand-level KPIs.

order_revenue / total_revenue  (CANONICAL — USE for MER, AOV, all KPIs)
  = Gross Product Sales + Shipping + Taxes − Discounts
  = Triple Whale "Order Revenue" — after discounts, before refunds
  = Shopify + Amazon combined for NOBL. shopify_revenue and amazon_revenue show the split.
  ⚠️ FLO is FLO US only. Do not add FLO_EU unless the user explicitly asks for the separate EU store.

total_sales
  = order_revenue - refund_amount (net revenue actually kept)
  = What you "take to the bank"

shopify_revenue  = Shopify-only orders (order_revenue minus Amazon)
amazon_revenue   = Amazon channel only (NOBL has ~$10-15k/day from Amazon)

━━━ KEY METRICS & FORMULAS ━━━
MER = SUM(order_revenue) / NULLIF(SUM(total_spend),0)  [target ≥2.0, red <1.8]
ROAS = channel_revenue / channel_spend  (spend_1d from ads_table; revenue_1d from attribution)
NC ROAS = new_customer_revenue / spend
NVP% = new_visitors / total_visitors [target ≥50%]
CAC = spend / new_customer_orders
AOV = SUM(total_revenue) / NULLIF(SUM(total_orders),0)
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
1. NEVER ask clarifying questions — just answer with the data using query_database.
2. Always show specific numbers, not vague answers.
3. When returning data for charts/tables, format it as clean JSON in chartData.
4. Be concise — executives want bullet points and numbers.
5. Date filtering: most tables use a 'date' column (DATE). Use BETWEEN '$1'::date AND '$2'::date.
   - shopify_orders_raw uses date_key.
   - nobl_air_subscribers uses created_at (cast via DATE(created_at)).
6. For "latest", "yesterday", or default ranges, first use MAX(date) from the relevant table/brand and anchor the answer to that latest synced date. Do not assume current_date has data.
7. Return chartHint as: "line_chart", "bar_chart", "table", or "kpi_cards" based on what data you return.

━━━ COMMON QUERIES ━━━
- Daily revenue NOBL current month-to-date:
    WITH latest AS (SELECT MAX(date) AS d FROM tw_summary_daily WHERE brand='NOBL')
    SELECT date, total_revenue FROM tw_summary_daily, latest
    WHERE brand='NOBL' AND date BETWEEN DATE_TRUNC('month', latest.d)::date AND latest.d ORDER BY date
- META spend/revenue NOBL Apr 2026:
    SELECT date, spend_1d, revenue_1d, roas_1d FROM tw_channel_daily
    WHERE brand='NOBL' AND channel='META' AND date BETWEEN '2026-04-01'::date AND '2026-04-30'::date
- NOBL Air attach rate trend:
    SELECT date, attach_rate, ttp_rate FROM nobl_air_daily ORDER BY date DESC LIMIT 60
- Active subscribers by tier:
    SELECT contract_amount AS tier, COUNT(*) FILTER (WHERE status='active')::int AS active
    FROM nobl_air_subscribers WHERE contract_amount IN (49,79,89,99,109,119,129,139,149,159)
    GROUP BY tier ORDER BY tier
- Top NOBL products current month-to-date:
    SELECT product_title, SUM(units_sold)::int AS units, SUM(net_revenue)::numeric(14,2) AS revenue
    FROM shopify_product_daily
    WHERE brand='NOBL' AND date >= DATE_TRUNC('month', current_date)::date
    GROUP BY product_title HAVING SUM(units_sold) > 50 ORDER BY revenue DESC LIMIT 20`;

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

function prepareAiSelectSql(sql) {
  let cleaned = String(sql || '').trim().replace(/;\s*$/g, '');
  if (!/^(SELECT|WITH)\b/i.test(cleaned)) throw new Error('Only SELECT/WITH queries are allowed');
  if (/;/.test(cleaned)) throw new Error('Multiple SQL statements are not allowed');
  if (/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER|CREATE|GRANT|REVOKE)\b/i.test(cleaned)) {
    throw new Error('Only read-only SELECT queries are allowed');
  }
  if (!/\bLIMIT\s+\d+\b/i.test(cleaned)) cleaned += ' LIMIT 200';
  return cleaned;
}

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
      const toolMessages = [];
      const querySummaries = [];

      for (const toolCall of r1msg.tool_calls) {
        const { sql, description } = JSON.parse(toolCall.function.arguments || '{}');
        let dbRows = [], dbColumns = [], dbError = null, preparedSql = sql;
        try {
          preparedSql = prepareAiSelectSql(sql);
          const result = await pgQuery(preparedSql);
          dbColumns = result.fields?.map(f => f.name) || Object.keys(result.rows[0] || {});
          dbRows = result.rows.map(r => dbColumns.map(c => r[c]));
          queryResult = { columns: dbColumns, rows: dbRows, description, sql: preparedSql };
        } catch (e) {
          dbError = e.message;
          console.error('[AI DB Query]', e.message, '\nSQL:', sql);
        }

        const toolResultContent = dbError
          ? `Query error: ${dbError}`
          : `Query returned ${dbRows.length} rows.\nColumns: ${dbColumns.join(', ')}\nData (first 20 rows): ${JSON.stringify(dbRows.slice(0, 20))}`;
        toolMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResultContent });
        querySummaries.push({ description, sql: preparedSql, error: dbError, rowCount: dbRows.length, columns: dbColumns });
      }

      // Round 2: feed results back to AI for final answer
      const round2 = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          ...allMessages,
          r1msg,
          ...toolMessages
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
      } else if (queryResult?.rows?.length > 0) {
        // Auto-detect chart type
        const dbColumns = queryResult.columns || [];
        const dbRows = queryResult.rows || [];
        if (dbColumns.includes('date') || dbColumns.some(c => c.includes('date'))) chartHint = 'line_chart';
        else if (dbRows.length === 1 && dbColumns.length <= 8) chartHint = 'kpi_cards';
        else if (dbRows.length > 1 && dbColumns.some(c => c.includes('channel') || c.includes('region') || c.includes('brand'))) chartHint = 'bar_chart';
        else chartHint = 'table';
      }

      return res.json({ reply, queryResult, chartHint, querySummaries });
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

    // Try to extract a JSON config from the response. The AI sometimes returns:
    //   (a) a wrapped object   →  {"title":"...", "sections":[...]}
    //   (b) a bare sections array  →  [{"type":"line_chart", ...}]   ← we auto-wrap
    //   (c) a chat reply with embedded JSON (after "Got it! Generating...")
    function extractJsonConfig(text) {
      // Look for the first balanced JSON value (object or array) anywhere in the text
      const candidates = [];
      // Object form
      const objIdx = text.search(/\{[\s\S]*?"sections"\s*:/);
      if (objIdx !== -1) candidates.push({ type: 'object', start: objIdx });
      // Array form — first '[' that's followed by an object containing "type" and "query"
      const arrMatch = text.match(/\[\s*\{[\s\S]*?"type"[\s\S]*?"query"/);
      if (arrMatch) candidates.push({ type: 'array', start: text.indexOf(arrMatch[0]) });
      if (candidates.length === 0) return null;

      // Try each candidate; balanced-brace scan to find the closing token
      for (const c of candidates.sort((a,b) => a.start - b.start)) {
        const open = c.type === 'object' ? '{' : '[';
        const close = c.type === 'object' ? '}' : ']';
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = c.start; i < text.length; i++) {
          const ch = text[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === open) depth++;
          else if (ch === close) {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end === -1) continue;
        const slice = text.slice(c.start, end);
        try {
          const parsed = JSON.parse(slice);
          if (c.type === 'array') {
            // Auto-wrap into the canonical config shape
            const sections = Array.isArray(parsed) ? parsed : [];
            const firstTitle = sections[0]?.title || 'Custom dashboard';
            return { title: firstTitle, description: '', sections };
          }
          if (parsed && Array.isArray(parsed.sections)) return parsed;
        } catch { /* try next candidate */ }
      }
      return null;
    }

    const config = extractJsonConfig(cleaned);

    if (config && Array.isArray(config.sections) && config.sections.length > 0) {
      console.log('[AI Dashboard Gen] Config generated:', config.title, `(${config.sections.length} section(s))`);
      // Strip the JSON from the user-facing message — keep only any prose before it
      // (e.g. "Got it! Generating your dashboard now...")
      const messageOnly = (raw.split(/\{[\s\S]*"sections"|\[\s*\{[\s\S]*"type"/)[0] || '').trim() ||
                          'Dashboard generated.';
      return res.json({ config, message: messageOnly });
    }

    // Couldn't extract a usable config. If the response LOOKS like JSON but was
    // malformed, tell the user — otherwise treat as a clarification question.
    if (/\{[\s\S]*"sections"|\[\s*\{[\s\S]*"type"/.test(cleaned)) {
      console.error('[AI Dashboard Gen] Could not parse JSON. Raw:', cleaned.slice(0, 400));
      return res.json({
        message: 'I generated a dashboard config but it had a JSON error. Could you try again? You can be more specific (e.g. "compare NOBL daily revenue 2025 vs 2026 — show as line chart").'
      });
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
    if (syncEngine.isSyncRunning()) {
      return res.json({
        ok: true,
        already_running: true,
        message: 'Sync already in progress — skipping duplicate trigger',
      });
    }

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

// ── Daily cron: 11:00 AM Asia/Karachi (Pakistan Standard Time) ──────────────
// Each run:
//   1. Auto-cleanup any stuck "running" entries from previous failures
//   2. Find missing days in the last 14d and include them in the range
//   3. Run ALL 9 ETL tasks
//   4. Email muhammad.awais@nysonian.com on errors / stuck runs / missing data
//   5. Full timeout protection (60-min hard cap on the whole run)
//
// Robustness guarantees:
//   - Per-task try/catch — one failure doesn't block the rest
//   - Hard 60-min wall-clock timeout — won't sit "running" forever
//   - Stale "running" entries (>3h old) get auto-marked errored on cron startup
//   - Post-run validation: if today's date isn't present in tw_summary_daily for both
//     brands, fire a critical alert
const ALL_DAILY_TASKS = [
  'klaviyo',
  'tw_refresh',          // brand-level summary (TW Summary API)
  'tw_order_revenue',    // canonical revenue split (Shopify + Amazon)
  'meta_ads',            // Meta Marketing API — NOBL ad spend (TW fallback at read)
  'tw_ads',              // campaign/adset/ad performance from TW
  'tw_air_attribution',  // NOBL Air order-level attribution
  'shopify_orders',      // per-order detail + product line items (NOBL + FLO)
  'appstle_contracts',   // subscription contracts (NOBL + FLO)
  'nobl_air_aggregate',  // recompute nobl_air_daily
  'product_daily',       // recompute shopify_product_daily
];

const CRON_HARD_TIMEOUT_MS = 90 * 60 * 1000; // 90 min — TW API is serialized with retries

// In-process flag prevents double-firing if cron + manual click overlap
let cronRunning = false;
let lastCronRunAt = null;
let lastCronStatus = null; // { runId, ok, errors, ts }

try {
  const cron = require('node-cron');
  const { pgQuery, pgRun } = require('./db/postgres');
  const { sendAlert, ensureSchema: ensureAlertsSchema } = require('./etl/alerts');

  // Initialize alerts table on boot
  ensureAlertsSchema().catch(e => console.warn('[Alerts] schema init failed:', e.message));

  async function cleanupStuckRuns() {
    try {
      const r = await pgRun(`
        UPDATE etl_run_log
        SET status='error', error_message='auto-cleanup: stuck >3h', finished_at=NOW()
        WHERE status='running' AND started_at < NOW() - interval '3 hours'
      `);
      if (r.rowCount > 0) {
        await sendAlert({
          severity: 'warn',
          subject: `Auto-cleaned ${r.rowCount} stuck ETL run(s)`,
          body: `${r.rowCount} ETL entries had status='running' for >3 hours and were marked errored.`,
        });
      }
      return r.rowCount;
    } catch (e) {
      console.error('[Cron cleanup]', e.message);
      return 0;
    }
  }

  async function validateRunCompleteness(yStr) {
    // After a cron run, verify yesterday's data actually landed for both brands.
    const checks = [
      { table: 'tw_summary_daily', sql: `SELECT brand, COUNT(*)::int n FROM tw_summary_daily WHERE date = $1::date GROUP BY brand`, expect: 2 },
      { table: 'shopify_orders_raw', sql: `SELECT brand, COUNT(*)::int n FROM shopify_orders_raw WHERE date_key = $1::date GROUP BY brand`, expect: 1 }, // NOBL min
      { table: 'nobl_air_daily', sql: `SELECT 'na' AS brand, COUNT(*)::int n FROM nobl_air_daily WHERE date = $1::date`, expect: 1 },
    ];
    const issues = [];
    for (const c of checks) {
      try {
        const r = await pgQuery(c.sql, [yStr]);
        if (r.rows.length < c.expect || r.rows.some(x => !x.n)) {
          issues.push(`${c.table}: only ${r.rows.length} brand row(s), expected ≥${c.expect}`);
        }
      } catch (e) {
        issues.push(`${c.table}: query failed — ${e.message}`);
      }
    }
    return issues;
  }

  async function runDailySync(opts = {}) {
    if (cronRunning) {
      console.log('[Cron] Already running — skip');
      return { skipped: true };
    }
    cronRunning = true;
    const t0 = Date.now();

    try {
      // Step 0: clean up any stuck runs first
      await cleanupStuckRuns();

      const today = new Date();
      const yStr = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);

      // Step 1: find missing days in the last 14 (we'll catch holes)
      let missing = [];
      try {
        const lookback = 7;
        const startBack = new Date(today.getTime() - lookback * 86400000).toISOString().slice(0, 10);
        const r = await pgQuery(`
          WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS d)
          SELECT d FROM days
          WHERE NOT EXISTS (SELECT 1 FROM nobl_air_daily WHERE date = days.d)
          ORDER BY d
        `, [startBack, yStr]);
        missing = r.rows.map(x => x.d.toISOString().slice(0, 10));
      } catch (e) {
        console.warn('[Cron] Missing-day scan failed:', e.message);
      }

      const startDate = missing.length ? missing[0] : yStr;
      const endDate   = yStr;
      const runId = opts.runId || `cron_daily_${endDate}_${Date.now()}`;
      console.log(`[Cron] ▶ ${runId} | ${startDate} → ${endDate} | missing=${missing.length}`);

      // Step 2: run with 60-min hard timeout
      const syncPromise = syncEngine.runSync({
        runId,
        tasks:  ALL_DAILY_TASKS,
        startDate, endDate,
        brands: ['NOBL', 'FLO'],
      });
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Cron timed out after ${CRON_HARD_TIMEOUT_MS/60000} min`)), CRON_HARD_TIMEOUT_MS)
      );

      let syncResult, syncErr;
      try {
        syncResult = await Promise.race([syncPromise, timeoutPromise]);
      } catch (e) {
        syncErr = e.message;
        await sendAlert({
          severity: 'critical',
          subject: `Cron failed/timed out: ${runId}`,
          body: `The daily cron sync errored: ${e.message}`,
          context: { runId, startDate, endDate, elapsed_min: ((Date.now()-t0)/60000).toFixed(1) },
        });
      }

      // Step 3: validate completeness
      const issues = await validateRunCompleteness(yStr);
      if (issues.length) {
        await sendAlert({
          severity: 'error',
          subject: `Cron data validation failed for ${yStr}`,
          body: `After cron run ${runId}, the following data is missing or incomplete:\n\n${issues.join('\n')}`,
          context: { runId, yStr, issues },
        });
      }

      // Step 4: check for any error rows in this cron run
      try {
        const errs = await pgQuery(
          `SELECT task, brand, error_message FROM etl_run_log
           WHERE run_id = $1 AND status = 'error' LIMIT 10`,
          [runId]
        );
        if (errs.rows.length) {
          await sendAlert({
            severity: 'error',
            subject: `Cron task errors in ${runId}`,
            body: errs.rows.map(r => `• ${r.task} (${r.brand}): ${r.error_message?.slice(0, 200)}`).join('\n'),
            context: { runId, errorCount: errs.rows.length },
          });
        }
      } catch {}

      const elapsed = ((Date.now()-t0)/60000).toFixed(1);
      lastCronRunAt = new Date().toISOString();
      lastCronStatus = {
        runId, ok: !syncErr && !issues.length,
        errors: (syncErr ? 1 : 0) + issues.length,
        elapsed_min: elapsed, ts: lastCronRunAt
      };
      console.log(`[Cron] ✓ Done ${runId} in ${elapsed}min — ${lastCronStatus.ok ? 'OK' : `${lastCronStatus.errors} issue(s)`}`);
      return { runId, ...lastCronStatus };
    } finally {
      cronRunning = false;
    }
  }

  // Schedule: 11:00 AM Asia/Karachi every day (Pakistan Standard Time)
  cron.schedule('0 11 * * *', () => {
    runDailySync().catch(e => console.error('[Cron unhandled]', e));
  }, { timezone: 'Asia/Karachi' });

  console.log('[Cron] Scheduled: 11:00 AM Asia/Karachi (PKT) daily — 9 tasks with 14-day backfill window');

  // ── Manual sync trigger — admin only, single-flight, rate-limited ────────
  // Tracks per-user manual triggers in this Map; purges every hour
  const manualTriggerLog = new Map(); // userId → [timestamps]
  const MAX_MANUAL_PER_HOUR = 6;

  function requireAdmin(req, res, next) {
    if (isAdminSession(req)) return next();
    if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
    pgQuery(`SELECT role FROM app_users WHERE id = $1`, [req.session.userId])
      .then(r => {
        if (r.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
        next();
      })
      .catch(e => res.status(500).json({ error: e.message }));
  }

  app.post('/api/sync/trigger-daily', requireAdmin, async (req, res) => {
    const userId = effectiveUserId(req);
    const now = Date.now();

    // Rate limit
    const userHits = (manualTriggerLog.get(userId) || []).filter(t => now - t < 3600000);
    if (userHits.length >= MAX_MANUAL_PER_HOUR) {
      return res.status(429).json({
        error: `Rate limit: max ${MAX_MANUAL_PER_HOUR} manual triggers per hour. Try again in ${
          Math.ceil((userHits[0] + 3600000 - now) / 60000)
        } min.`
      });
    }
    userHits.push(now);
    manualTriggerLog.set(userId, userHits);

    // Single-flight: if a cron run from the last 30 min is still running, return its run_id
    if (cronRunning) {
      return res.json({
        ok: true,
        msg: 'Sync already running — joining existing run',
        run_id: 'in-progress',
        already_running: true,
      });
    }
    try {
      const recent = await pgQuery(
        `SELECT run_id FROM etl_run_log
         WHERE status = 'running' AND started_at > NOW() - interval '30 minutes'
         ORDER BY started_at DESC LIMIT 1`
      );
      if (recent.rows.length) {
        return res.json({
          ok: true,
          msg: 'Sync already running — joining existing run',
          run_id: recent.rows[0].run_id,
          already_running: true,
        });
      }
    } catch {}

    // Spawn background
    runDailySync({ runId: `manual_${Date.now()}` }).catch(e => console.error('[Manual sync]', e));
    res.json({ ok: true, msg: 'Sync started in background', run_id: `manual_${Date.now()}` });
  });

  // Public status endpoint — anyone authed can read sync status
  app.get('/api/sync/last-cron', requireAppAuth, (req, res) => {
    res.json({
      running: cronRunning,
      last_run_at: lastCronRunAt,
      last_status: lastCronStatus,
      next_scheduled: 'Daily at 11:00 AM Asia/Karachi (Pakistan time)',
    });
  });
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
app.use(express.static(clientBuild, {
  setHeaders(res, filePath) {
    // Always revalidate index.html so new hashed JS/CSS bundles load after deploy
    if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith('/index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*', (req, res) => res.sendFile(path.join(clientBuild, 'index.html')));

// ── Start ────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`\n  NOBL Analytics Dashboard → http://localhost:${PORT}\n`);
  if (isAuthBypassEnabled()) {
    console.log('  [Auth] Local bypass active — ERP sign-in not required (production uses real auth)\n');
  }
  await cleanupStaleConnections();
  await initPostgresTables();
  pgRun(`
    UPDATE etl_run_log
    SET status='error', error_message='auto-cleanup: stuck on boot', finished_at=NOW()
    WHERE status='running' AND started_at < NOW() - interval '3 hours'
  `).catch(() => {});
});

function shutdown(signal) {
  console.log(`[Shutdown] ${signal} — closing HTTP server and DB pool`);
  server.close(() => {
    Promise.all([pgPool.end(), sessionPool.end()])
      .catch(err => console.error('[Shutdown] pool.end error:', err.message))
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[UNCAUGHT] listen EADDRINUSE: address already in use :::${PORT}`, err);
    console.error(`  Another process is using port ${PORT}. Stop other "npm run dev" windows, or run:`);
    console.error(`  netstat -ano | findstr :${PORT}`);
    console.error(`  taskkill /PID <pid> /F`);
    process.exit(1);
  }
  throw err;
});
