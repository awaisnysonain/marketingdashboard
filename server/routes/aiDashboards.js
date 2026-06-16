const express = require('express');
const router = express.Router();
const { pgQuery } = require('../db/postgres');
const { effectiveUserId } = require('../auth');

// ── Schema context string for AI prompts ──────────────────────────
// IMPORTANT: this MUST match the actual PG schema. Verified 2026-05-01.
const SCHEMA_CONTEXT = `
AVAILABLE DATABASE TABLES (PostgreSQL — use the EXACT names below):

1. tw_summary_daily — Daily totals per brand (brand-level rollup, both NOBL and FLO)
   Columns: date, brand, order_revenue, total_revenue, total_spend, mer, total_orders,
            new_customer_orders, returning_customer_orders, shopify_revenue, amazon_revenue, total_sales, refund_amount
   ▸ order_revenue = Gross Product Sales + Shipping + Taxes − Discounts (use for MER)
   ▸ ALWAYS filter by brand (use filters.brand: 'NOBL' or 'FLO').
   ▸ NOBL already includes EU customers (one Shopify store, all regions).
   ▸ FLO totals are FLO US only. FLO EU is a separate store and is excluded.

2. tw_channel_daily — Channel breakdown per brand per day
   Columns: date, brand, channel ('META'|'GOOGLE'|'TIKTOK'|'SNAPCHAT'|'PINTEREST'|'APPLOVIN'|'BING'|'X'|'AMAZON'),
            spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d, new_cust_orders, cac
   ▸ spend_1d = ads_table channel-reported spend (canonical for spend/MER denominators).
   ▸ revenue_1d is Triple Attribution (1-day window) — matches TW dashboard.
   ▸ Do NOT sum revenue_1d across channels to get total revenue.

3. tw_geo_daily — Geographic breakdown
   Columns: date, brand, region ('US'|'CA'|'AUS'|'DUBAI'|'EU'|'OTHER'|'TOTAL'),
            revenue_actual, spend_actual, mer
   ▸ spend_actual = ads_table country breakdown (US is actual US spend, not residual).

4. tw_product_daily — FLO product lines (portable/wooden/metal). NOBL not populated here.
   Columns: date, brand, product_line, spend, revenue, new_cust_orders, ...meta_spend etc.

5. klaviyo_daily — Email/SMS marketing
   Columns: date, brand, emails_sent, emails_opened, emails_clicked, open_rate, click_rate, revenue

6. nobl_air_daily — NOBL Air subscription product (launched Mar 2026; data only from 2026-02 onward)
   Columns: date, total_orders, air_orders, paid_air_orders, zero_air_orders, rebill_orders,
            same_day_cancels, attach_rate, ttp_rate, activation_rate,
            tag_net_sales, sub_net_sales, rebill_revenue, new_sub_revenue, combined_net_revenue,
            new_79, new_99, new_119, new_129, new_139, new_149 (and 49/89/109/159),
            rebill_79, rebill_99, rebill_119, rebill_129, rebill_139, rebill_149 (and 49/89/109/159)
   ▸ NO brand filter — this table is NOBL Air only.
   ▸ attach_rate / ttp_rate / activation_rate are decimals (0.0–1.0).

7. nobl_air_subscribers — Individual subscribers (18,779+ contracts)
   Columns: appstle_id, customer_email, customer_name, order_name,
            status ('active'|'cancelled'|'paused'), contract_amount (the tier — 79/99/119/etc.),
            created_at, last_billing_date, cancelled_on, is_mature, is_converted, is_same_day_cancel
   ▸ Date column is created_at (timestamp). Filter via DATE(created_at).
   ▸ TTP cohort = mature converted / mature.

8. shopify_product_daily — Per-product daily (BOTH brands)
   Columns: brand, date, product_title, sku_prefix, units_sold, order_count,
            gross_revenue, discounts, net_revenue, refunds

9. shopify_orders_raw — Per-order detail (date column is date_key)
   Columns: brand, date_key, order_name, customer_email, total_price,
            shipping_country, has_air, has_luggage, is_rebill, ...

COMPUTED METRICS (use as SQL expressions with aliases):
- MER:    SUM(total_revenue) / NULLIF(SUM(total_spend), 0) AS mer
- AOV:    SUM(total_revenue) / NULLIF(SUM(total_orders), 0) AS aov
- NC%:    new_customer_orders * 100.0 / NULLIF(total_orders, 0) AS nc_pct
- ROAS:   revenue_1d / NULLIF(spend_1d, 0) AS roas
- CAC:    spend_1d / NULLIF(new_cust_orders, 0) AS cac

Data: 2024-01-01 onward. All amounts USD. Dynamic ranges resolve to the latest synced date for each table.
`;

// ── Dashboard generation system prompts ───────────────────────────
function getClarifyPrompt(today) {
  return `You are an AI dashboard builder for the Nysonian Marketing Hub (NOBL Travel + NOBL Air subscription, and Pilates FLO).

Today's date is ${today}.

YOUR MOST IMPORTANT RULE: If the user's request already specifies the BRAND, TIME PERIOD, and a clear METRIC focus, generate the dashboard JSON IMMEDIATELY without asking any clarifying questions.

Examples of requests where you should generate immediately:
- "show me META channel for NOBL MTD"           → brand=NOBL, time=current month, focus=META channel
- "FLO product line breakdown this month"       → brand=FLO, time=current month, focus=product
- "NOBL Air attach rate trend last 90 days"     → brand=NOBL Air, time=90d, focus=attach rate
- "Compare revenue NOBL vs FLO YTD"             → both brands, time=YTD, focus=revenue
- "TTP by tier"                                 → NOBL Air, default 90d, focus=TTP/tiers

ONLY ask clarifying questions if the request is genuinely ambiguous (e.g. "show me a dashboard"
with no brand or metric). When you do ask, ask ONLY the missing pieces — never ask things the
user already specified.

When generating, output exactly the line:
  Got it! Generating your dashboard now...

Then on a new line, output ONLY a single JSON OBJECT (no markdown, no code fences,
no explanation, no array wrapper).

CRITICAL: the JSON must be a SINGLE OBJECT, NOT a bare array. The shape is:

{
  "title": "Short descriptive title",
  "description": "One-line summary",
  "sections": [
    { "type": "line_chart", ... },
    { "type": "table", ... }
  ]
}

DO NOT output a bare array like [ {...} ] — always wrap with the title/description/sections envelope.
The "sections" array goes INSIDE the object.

${SCHEMA_CONTEXT}

SECTION FORMATS you may use:

KPI row (summary numbers):
{
  "type": "kpi_row",
  "title": "Performance",
  "items": [
    { "label": "Revenue", "field": "total_revenue", "format": "currency" },
    { "label": "Spend",   "field": "total_spend",   "format": "currency" },
    { "label": "MER",     "field": "mer",           "format": "number" }
  ],
  "query": {
    "table": "tw_summary_daily",
    "columns": [
      "COALESCE(SUM(total_revenue),0) AS total_revenue",
      "COALESCE(SUM(total_spend),0) AS total_spend",
      "ROUND(SUM(total_revenue)/NULLIF(SUM(total_spend),0),2) AS mer"
    ],
    "filters": { "brand": "NOBL", "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" }
  }
}

Time-series chart (single brand):
{
  "type": "line_chart",
  "title": "NOBL Revenue vs Spend (MTD)",
  "xField": "date",
  "series": [
    { "field": "total_revenue", "label": "Revenue", "color": "#3b5bdb" },
    { "field": "total_spend",   "label": "Spend",   "color": "#cc8a00" }
  ],
  "query": {
    "table": "tw_summary_daily",
    "columns": ["date", "total_revenue", "total_spend"],
    "filters": { "brand": "NOBL", "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
    "order_by": "date",
    "limit": 400
  }
}

YEAR-OVER-YEAR comparison (e.g. "compare 2025 vs 2026 daily revenue NOBL"):
Use TWO sections, each filtered to a different year. The chart gets two lines.
[
  {
    "type": "line_chart",
    "title": "NOBL Daily Revenue — 2025 vs 2026",
    "xField": "month_day",
    "series": [
      { "field": "rev_2025", "label": "2025", "color": "#94a3b8" },
      { "field": "rev_2026", "label": "2026", "color": "#3b5bdb" }
    ],
    "query": {
      "table": "tw_summary_daily",
      "columns": [
        "TO_CHAR(date, 'MM-DD') AS month_day",
        "SUM(CASE WHEN EXTRACT(YEAR FROM date) = 2025 THEN total_revenue ELSE 0 END) AS rev_2025",
        "SUM(CASE WHEN EXTRACT(YEAR FROM date) = 2026 THEN total_revenue ELSE 0 END) AS rev_2026"
      ],
      "filters": { "brand": "NOBL", "start_date": "2025-01-01", "end_date": "DYNAMIC_TODAY" },
      "group_by": ["month_day"],
      "order_by": "month_day",
      "limit": 400
    }
  }
]

Bar chart by channel:
{
  "type": "bar_chart",
  "title": "Spend by Channel — NOBL",
  "xField": "channel",
  "series": [{ "field": "total_spend", "label": "Spend", "color": "#3b5bdb" }],
  "query": {
    "table": "tw_channel_daily",
    "columns": ["channel", "COALESCE(SUM(spend_1d),0) AS total_spend"],
    "filters": { "brand": "NOBL", "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
    "group_by": ["channel"],
    "order_by": "-total_spend"
  }
}

Detail table:
{
  "type": "table",
  "title": "Daily Summary",
  "columns": [
    { "field": "date",          "label": "Date",    "format": "date"     },
    { "field": "total_revenue", "label": "Revenue", "format": "currency" },
    { "field": "total_spend",   "label": "Spend",   "format": "currency" },
    { "field": "mer",           "label": "MER",     "format": "number"   }
  ],
  "query": {
    "table": "tw_summary_daily",
    "columns": ["date", "total_revenue", "total_spend", "mer"],
    "filters": { "brand": "NOBL", "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
    "order_by": "-date",
    "limit": 90
  }
}

RULES (read carefully):
- Use ONLY these table names: tw_summary_daily, tw_channel_daily, tw_geo_daily,
  tw_product_daily, tw_store_summary_daily, klaviyo_daily, nobl_air_daily,
  nobl_air_subscribers, shopify_product_daily, shopify_orders_raw.
  Do NOT use "nobl_brand_*" or "flo_brand_*" — apply the brand filter instead.
- ALWAYS include filters.brand for tables that have a brand column (everything except
  nobl_air_daily and nobl_air_subscribers).
- Use COALESCE(SUM(...), 0) for aggregated KPI columns to avoid nulls.
- Use "DYNAMIC_TODAY"/"DYNAMIC_START" or specific ISO dates ("2025-01-01") for filters.
  Dynamic dates are resolved by the server to the latest synced date for that table, not wall-clock today.
- For YoY/multi-year comparisons: use TO_CHAR + CASE WHEN EXTRACT(YEAR ...) pattern above.
- For channel tables: spend = spend_1d, revenue = revenue_1d.
- For summary tables: spend = total_spend, revenue = total_revenue. FLO total_revenue/total_spend exclude FLO EU.
- nobl_air_daily has no brand filter — it's NOBL Air only. Data starts Feb 2026.
- Field aliases in your SELECT columns MUST EXACTLY match the "field" in items/series/columns.
- Include 3–5 sections. Always include at least one KPI row and one chart.
- Respond ONLY with the JSON when generating (no markdown, no code fences, no extra text).

CHANNEL/BRAND COLORS:
- NOBL=#3b5bdb, FLO=#2f9e6c
- META=#1877f2, GOOGLE=#ea4335, TIKTOK=#000000, SNAPCHAT=#f59e0b
- APPLOVIN=#9333ea, BING=#0ea5e9, PINTEREST=#e60023, X=#1f2937

COMMON PATTERNS:
- "META for NOBL MTD"        → tw_channel_daily, filters={brand:'NOBL', channel:'META', start:DYNAMIC_START}
- "Compare NOBL 2025 vs 2026" → tw_summary_daily with TO_CHAR + CASE pattern shown above
- "NOBL Air attach trend"    → nobl_air_daily, columns=[date, attach_rate]
- "TTP by tier"              → nobl_air_subscribers, group_by=[contract_amount]
- "Top NOBL products"        → shopify_product_daily, filters={brand:'NOBL'}, group_by=[product_title]`;
}

// ── Allowed tables and their allowed columns ──────────────────────
// Only real tables in PG. AI's selection is constrained to this map.
const ALLOWED_TABLES = {
  tw_summary_daily:        ['date','brand','total_revenue','total_spend','mer','total_orders','new_customer_orders','returning_customer_orders','order_revenue','shopify_revenue','amazon_revenue','total_sales','refund_amount','refund_count'],
  tw_channel_daily:        ['date','brand','channel','spend_1d','revenue_1d','purchases_1d','roas_1d','spend_7d','new_cust_orders','cac','portable_cac','wooden_cac','metal_cac'],
  tw_store_summary_daily:  ['date','store_key','brand','total_revenue','total_spend','mer','total_orders'],
  tw_product_daily:        ['date','brand','product_line','spend','new_cust_orders','revenue','meta_spend','google_spend','tiktok_spend','snap_spend','pinterest_spend','bing_spend','applovin_spend'],
  klaviyo_daily:           ['date','brand','emails_sent','emails_opened','emails_clicked','open_rate','click_rate','revenue'],
  nobl_air_daily:          ['date','total_orders','air_orders','paid_air_orders','zero_air_orders','rebill_orders','same_day_cancels','attach_rate','ttp_rate','activation_rate','tag_gross','tag_discounts','tag_net_sales','tag_refunds','sub_gross','sub_discounts','sub_net_sales','sub_refunds','rebill_revenue','new_sub_revenue','combined_gross','combined_net_sales','combined_net_revenue','new_49','new_79','new_89','new_99','new_109','new_119','new_129','new_139','new_149','new_159','rebill_49','rebill_79','rebill_89','rebill_99','rebill_109','rebill_119','rebill_129','rebill_139','rebill_149','rebill_159'],
  nobl_air_subscribers:    ['appstle_id','customer_email','customer_name','order_name','status','contract_amount','order_amount','billing_policy_interval','currency_code','created_at','updated_at','starts_at','ends_at','next_billing_date','last_billing_date','cancelled_on','is_mature','is_converted','is_same_day_cancel'],
  shopify_product_daily:   ['brand','date','product_title','sku_prefix','units_sold','order_count','gross_revenue','discounts','net_revenue','refunds'],
  shopify_orders_raw:      ['brand','store_key','order_id','order_name','created_at','date_key','customer_id','customer_email','customer_name','total_price','subtotal_price','total_discounts','total_tax','shipping_country','shipping_state','shipping_city','financial_status','fulfillment_status','has_air','has_luggage','is_rebill','has_paid_air','has_zero_air','tag_gross','tag_discounts','tag_refunds','sub_gross','sub_discounts','sub_refunds'],
};

function validateTable(name) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TABLES, name);
}

function dateColumnForTable(table) {
  if (table === 'shopify_orders_raw') return 'date_key';
  if (table === 'nobl_air_subscribers') return 'DATE(created_at)';
  return 'date';
}

function startOfMonth(dateStr) {
  return `${String(dateStr).slice(0, 7)}-01`;
}

// Resolve DYNAMIC_* placeholders to the latest synced date for the selected table.
// This prevents empty charts when wall-clock today is newer than the ETL data.
async function resolveDates(filters, table, windowDays = 30) {
  const today = new Date().toISOString().slice(0, 10);
  const out = { ...filters };
  if (out.brand) out.brand = String(out.brand).toUpperCase();
  if (out.channel) out.channel = Array.isArray(out.channel)
    ? out.channel.map(v => String(v).toUpperCase())
    : String(out.channel).toUpperCase();
  if (out.region) out.region = String(out.region).toUpperCase();
  if (out.product_line) out.product_line = String(out.product_line).toLowerCase();
  const dateCol = dateColumnForTable(table);
  let latest = today;

  try {
    const params = [];
    const where = [];
    if (out.brand && (ALLOWED_TABLES[table] || []).includes('brand')) {
      params.push(String(out.brand).toUpperCase());
      where.push(`brand = $${params.length}`);
    }
    const r = await pgQuery(
      `SELECT TO_CHAR(MAX(${dateCol})::date, 'YYYY-MM-DD') AS max_date FROM "${table}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params
    );
    if (r.rows[0]?.max_date) latest = r.rows[0].max_date;
  } catch (e) {
    console.warn(`[QueryBuilder] latest-date lookup failed for ${table}:`, e.message);
  }

  const startStr = startOfMonth(latest);
  if (out.start_date === 'DYNAMIC_START' || !out.start_date) out.start_date = startStr;
  if (out.end_date === 'DYNAMIC_TODAY' || !out.end_date) out.end_date = latest;
  for (const k of Object.keys(out)) {
    if (String(out[k]).startsWith('DYNAMIC')) out[k] = k.includes('start') ? startStr : latest;
  }
  return out;
}

// Safe SQL identifier check (only allow known table columns + basic aggregates)
function isSafeExpression(expr, table) {
  // Allow complex SQL expressions (aggregates, CASE, COALESCE, arithmetic, casts, string literals)
  // Trust the AI for complex expressions — we still validate the table name
  // Only reject completely unknown bare column names (no parens = pure column ref)
  const bare = expr.replace(/^-/, '').trim();
  if (/[()/*+\-]/.test(bare)) return true; // has operators or function calls — allow
  if (/\s/.test(bare)) return true; // has spaces — probably "col AS alias" — allow
  // Bare column name — validate against schema
  return ALLOWED_TABLES[table]?.includes(bare.toLowerCase()) || bare === '*';
}

// Extract ORDER BY target — handles "col", "-col", "SUM(col)", aggregate alias
function resolveOrderBy(orderBy, table, columns) {
  if (!orderBy) return null;
  const desc = orderBy.startsWith('-');
  const raw = orderBy.replace(/^-/, '').trim();
  const dir = desc ? 'DESC' : 'ASC';

  // Check if it's a known column
  if (ALLOWED_TABLES[table]?.includes(raw.toLowerCase()) || raw === 'date') {
    return { expr: `"${raw}"`, dir };
  }

  // Check if it matches an alias in the columns list (e.g. "total_spend", "mer_computed")
  const aliasMatch = columns.find(c => {
    const asMatch = c.match(/\bAS\s+(\w+)\s*$/i);
    return asMatch && asMatch[1].toLowerCase() === raw.toLowerCase();
  });
  if (aliasMatch) {
    // Use the alias directly (PostgreSQL supports ORDER BY alias)
    return { expr: raw, dir };
  }

  // Fallback: use 1 (first column) for unknown order fields
  return null;
}

// Detect if an expression contains an aggregate function
function isAggregate(expr) {
  return /\b(SUM|AVG|COUNT|MIN|MAX|COALESCE\s*\(\s*SUM|COALESCE\s*\(\s*AVG)\s*\(/i.test(expr);
}

// Wrap bare division in NULLIF to prevent division-by-zero
// e.g.  "a / b"  →  "a / NULLIF(b, 0)"
// Already-guarded expressions (NULLIF present) are left untouched
function guardDivision(expr) {
  if (/NULLIF/i.test(expr)) return expr; // already guarded
  // Match "/ <token>" where token is a bare identifier or number (not already a function call)
  return expr.replace(/\/\s*([A-Za-z_]\w*|\d+(?:\.\d+)?)\b(?!\s*\()/g, (m, denom) => {
    return `/ NULLIF(${denom}, 0)`;
  });
}

// Build a safe parameterized query from a section query config
async function buildSectionQuery(query, defaultWindowDays = 30) {
  const {
    table,
    columns = ['*'],
    filters: rawFilters = {},
    group_by: rawGroupBy,
    order_by,
    limit = 1000,
  } = query;

  if (!validateTable(table)) {
    throw new Error(`Table "${table}" is not allowed`);
  }

  const filters = await resolveDates(rawFilters, table, defaultWindowDays);
  const params = [];
  let paramIdx = 1;

  // ── Build SELECT list ────────────────────────────────────────────
  const processedCols = [];  // final SQL expressions
  const bareNonAgg   = [];   // bare column names that are NOT aggregates (for auto GROUP BY)

  if (columns.length === 1 && (columns[0] === '*' || columns[0] === '"*"')) {
    processedCols.push('*');
  } else {
    for (const c of columns) {
      const trimmed = c.trim();
      if (!trimmed) continue;

      const isComplex = /[()/*+\-]/.test(trimmed) || /\s/.test(trimmed);

      if (isComplex) {
        // Guard division, then pass through as-is
        processedCols.push(guardDivision(trimmed));
        if (!isAggregate(trimmed)) {
          // Extract alias or bare expression for GROUP BY detection
          const aliasM = trimmed.match(/\bAS\s+(\w+)\s*$/i);
          const noAlias = aliasM ? trimmed.slice(0, aliasM.index).trim() : trimmed;
          // Only add to bareNonAgg if it looks like a simple col reference
          if (/^"?\w+"?$/.test(noAlias)) bareNonAgg.push(noAlias.replace(/"/g, ''));
        }
      } else {
        // Plain bare column name
        const lower = trimmed.toLowerCase();
        if (ALLOWED_TABLES[table].includes(lower)) {
          processedCols.push(`"${lower}"`);
          bareNonAgg.push(lower);
        } else {
          console.warn(`[QueryBuilder] Unknown column "${trimmed}" on "${table}" — skipping`);
        }
      }
    }
  }

  if (processedCols.length === 0) throw new Error(`No valid columns for table "${table}"`);

  // ── Auto-fix GROUP BY ────────────────────────────────────────────
  // If any column is an aggregate, non-aggregate bare columns must be in GROUP BY
  const hasAgg = processedCols.some(c => isAggregate(c));

  // GROUP BY: accept (a) real columns from ALLOWED_TABLES, OR (b) aliases that
  // appear in our SELECT list (the AI uses these for derived columns like month_day).
  const selectAliases = new Set(
    processedCols
      .map(c => {
        const m = c.match(/\bAS\s+(\w+)\s*$/i);
        return m ? m[1].toLowerCase() : null;
      })
      .filter(Boolean)
  );
  let effectiveGroupBy = (rawGroupBy && Array.isArray(rawGroupBy))
    ? rawGroupBy.map(c => c.trim()).filter(c =>
        ALLOWED_TABLES[table].includes(c.toLowerCase()) ||
        selectAliases.has(c.toLowerCase())
      )
    : [];

  if (hasAgg && effectiveGroupBy.length === 0) {
    // Auto-infer GROUP BY from non-aggregate columns
    const inferredGB = bareNonAgg.filter(col =>
      ALLOWED_TABLES[table].includes(col.toLowerCase())
    );
    effectiveGroupBy = inferredGB;
  }

  // ── Build SQL ────────────────────────────────────────────────────
  let sql = `SELECT ${processedCols.join(', ')} FROM "${table}"`;

  const dateCol = dateColumnForTable(table);

  // WHERE
  const whereParts = [];
  if (filters.start_date) { whereParts.push(`${dateCol} >= $${paramIdx++}`); params.push(filters.start_date); }
  if (filters.end_date)   { whereParts.push(`${dateCol} <= $${paramIdx++}`); params.push(filters.end_date);   }
  if (filters.brand && (ALLOWED_TABLES[table] || []).includes('brand')) {
    whereParts.push(`brand = $${paramIdx++}`); params.push(filters.brand);
  }
  if (filters.channel) {
    if (Array.isArray(filters.channel)) {
      whereParts.push(`channel = ANY($${paramIdx++})`); params.push(filters.channel);
    } else {
      whereParts.push(`channel = $${paramIdx++}`); params.push(filters.channel);
    }
  }
  if (filters.region)       { whereParts.push(`region = $${paramIdx++}`);       params.push(filters.region);       }
  if (filters.product_line) { whereParts.push(`product_line = $${paramIdx++}`); params.push(filters.product_line); }
  if (filters.store_key)    { whereParts.push(`store_key = $${paramIdx++}`);    params.push(filters.store_key);    }
  if (filters.status)       { whereParts.push(`status = $${paramIdx++}`);       params.push(filters.status);       }
  if (whereParts.length > 0) sql += ` WHERE ${whereParts.join(' AND ')}`;

  // GROUP BY — alias columns aren't quoted (PG resolves them positionally).
  if (effectiveGroupBy.length > 0) {
    sql += ` GROUP BY ${effectiveGroupBy
      .map(c => selectAliases.has(c.toLowerCase()) ? c : `"${c}"`)
      .join(', ')}`;
  }

  // ORDER BY
  const ob = resolveOrderBy(order_by, table, processedCols);
  if (ob) {
    sql += ` ORDER BY ${ob.expr} ${ob.dir}`;
  } else if (ALLOWED_TABLES[table].includes('date') && effectiveGroupBy.length === 0) {
    sql += ` ORDER BY date`;
  } else if (effectiveGroupBy.includes('date')) {
    sql += ` ORDER BY "date"`;
  }

  const safeLimit = Math.min(parseInt(limit) || 1000, 5000);
  sql += ` LIMIT ${safeLimit}`;

  return { sql, params };
}

// Post-process rows — parse numbers, format dates, coerce types
function fmtRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) {
        out[k] = null;
      } else if (v instanceof Date) {
        out[k] = v.toISOString().slice(0, 10);
      } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        out[k] = v.slice(0, 10);
      } else {
        const num = parseFloat(v);
        out[k] = !isNaN(num) && String(v).trim() !== '' ? num : v;
      }
    }
    return out;
  });
}

// ── List dashboards ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const r = await pgQuery(
      `SELECT id, name, description, config, is_public, created_at, updated_at
       FROM ai_dashboards WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[Dashboards GET /]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Create dashboard ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });
  const { name, description = '', config = {}, is_public = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const r = await pgQuery(
      `INSERT INTO ai_dashboards (user_id, name, description, config, is_public)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, config, is_public, created_at, updated_at`,
      [userId, name, description, JSON.stringify(config), is_public]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[Dashboards POST /]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Update dashboard ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });
  const { name, description, config, is_public } = req.body;
  const { id } = req.params;
  try {
    const existing = await pgQuery(
      `SELECT id FROM ai_dashboards WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Dashboard not found' });
    const r = await pgQuery(
      `UPDATE ai_dashboards
       SET name=$1, description=$2, config=COALESCE($3,config), is_public=COALESCE($4,is_public), updated_at=NOW()
       WHERE id=$5 AND user_id=$6
       RETURNING id, name, description, config, is_public, created_at, updated_at`,
      [name||null, description||null, config ? JSON.stringify(config) : null, is_public ?? null, id, userId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[Dashboards PUT /:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete dashboard ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });
  const { id } = req.params;
  try {
    await pgQuery(
      `DELETE FROM ai_dashboards WHERE id=$1 AND user_id=$2`,
      [id, userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[Dashboards DELETE /:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Execute dashboard config ──────────────────────────────────────
router.post('/execute', async (req, res) => {
  const userId = effectiveUserId(req);
  if (userId == null) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body;
  if (!config || !Array.isArray(config.sections)) {
    return res.status(400).json({ error: 'config.sections array is required' });
  }

  const results = {};
  const errors  = {};
  const debug   = {};

  await Promise.all(
    config.sections.map(async (section, idx) => {
      if (!section.query) {
        results[idx] = [];
        debug[idx] = { skipped: 'no query specified' };
        return;
      }
      try {
        const { sql, params } = await buildSectionQuery(section.query);
        debug[idx] = { sql, params, table: section.query.table };
        console.log(`[Execute §${idx}]`, sql.slice(0, 200), params);
        const r = await pgQuery(sql, params);
        results[idx] = fmtRows(r.rows);
        debug[idx].rowCount = r.rows.length;
        console.log(`[Execute §${idx}] → ${r.rows.length} rows`);
        if (r.rows.length === 0) {
          errors[idx] = `No data for "${section.title}". Tried ${section.query.table} with ${
            section.query.filters?.brand ? `brand=${section.query.filters.brand}, ` : ''
          }dates ${section.query.filters?.start_date || 'auto'}..${section.query.filters?.end_date || 'auto'}.`;
        }
      } catch (e) {
        console.error(`[Execute §${idx}]`, e.message);
        errors[idx] = e.message;
        results[idx] = [];
        debug[idx] = { error: e.message, query: section.query };
      }
    })
  );

  res.json({
    results,
    ...(Object.keys(errors).length > 0 ? { errors, debug } : {}),
  });
});

module.exports = { router, SCHEMA_CONTEXT, getClarifyPrompt };
