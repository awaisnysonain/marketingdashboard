const express = require('express');
const router = express.Router();
const { pgQuery } = require('../db/postgres');

// ── Schema context string for AI prompts ──────────────────────────
const SCHEMA_CONTEXT = `
AVAILABLE DATABASE TABLES (PostgreSQL):

1. nobl_brand_tw_summary_daily — NOBL Air daily brand totals
   Columns: date, brand, total_revenue, total_spend, mer, total_orders, new_customer_orders, returning_customer_orders
   NOTE: mer = total_revenue / total_spend (already computed by TW)
   NOTE: total_orders = new_customer_orders + returning_customer_orders

2. flo_brand_tw_summary_daily — Pilates FLO daily brand totals
   Columns: date, brand, total_revenue, total_spend, mer, total_orders, new_customer_orders, returning_customer_orders

3. nobl_brand_tw_channel_daily — NOBL Air channel breakdown
   Columns: date, brand, channel (META/GOOGLE/TIKTOK/SNAPCHAT/PINTEREST/APPLOVIN/BING/X),
            spend_1d, revenue_1d, purchases_1d, roas_1d, spend_7d,
            new_cust_orders, cac, portable_cac, wooden_cac, metal_cac

4. flo_brand_tw_channel_daily — FLO channel breakdown
   Columns: same as nobl_brand_tw_channel_daily

5. nobl_brand_tw_geo_daily — NOBL Air geographic breakdown
   Columns: date, brand, region (TOTAL/US/CA/AUS/DUBAI/EU), revenue_actual, spend_actual, mer

6. flo_brand_tw_geo_daily — FLO geographic breakdown
   Columns: same as nobl_brand_tw_geo_daily

7. flo_brand_tw_product_daily — FLO product-line performance
   Columns: date, brand, product_line (portable/wooden/metal),
            spend, new_cust_orders, revenue,
            meta_spend, google_spend, tiktok_spend, snap_spend,
            pinterest_spend, bing_spend, applovin_spend

8. nobl_air_sub_revenue_daily — NOBL Air subscription revenue
   Columns: date, shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
            rebill_revenue, new_sub_revenue, sub_revenue_actual

9. appstle_subscriptions — individual subscriber records
   Columns: id, appstle_id, created_at_appstle, total_successful_orders,
            last_order_date, last_order_amount, status (active/cancelled/trialing/converted),
            customer_name, customer_email, next_billing_date, activated_on, cancelled_on

COMPUTED METRICS (use in columns as SQL expressions with aliases):
- MER:  "total_revenue / NULLIF(total_spend, 0) AS mer"  (only if mer not already in table)
- AOV:  "total_revenue / NULLIF(total_orders, 0) AS aov" (summary tables)
- NC%:  "new_customer_orders * 100.0 / NULLIF(total_orders, 0) AS nc_pct" (summary tables)
- ROAS: "revenue_1d / NULLIF(spend_1d, 0) AS roas_1d"   (channel tables)
- CAC:  "spend_1d / NULLIF(new_cust_orders, 0) AS cac"  (channel tables)
- CVR:  "purchases_1d / NULLIF(new_cust_orders, 0) AS cvr" (channel tables)
- AOV_CH: "revenue_1d / NULLIF(purchases_1d, 0) AS aov" (channel tables)

Date range: Data available from 2025-01-01. All amounts in USD.
`;

// ── Dashboard generation system prompts ───────────────────────────
function getClarifyPrompt(today) {
  return `You are an AI dashboard builder for the Nysonian Marketing Hub (NOBL Air & Pilates FLO).

Today's date is ${today}.

When a user requests a dashboard, FIRST ask 2-4 short clarifying questions:
1. Which brand: NOBL Air, Pilates FLO, or both?
2. Time period: last 7/30/60/90 days, specific month, YTD, or custom dates?
3. Key metrics: revenue, spend, MER, ROAS, channel breakdown, product breakdown, subscriptions?
4. Any specific filter: single channel, region, product line?

Ask as a numbered list. Keep it short and friendly. Once you have their answers, say exactly:
"Got it! Generating your dashboard now..."
Then output ONLY a valid JSON config (no markdown, no explanation) in this format:

{
  "title": "...",
  "description": "...",
  "sections": [ ... ]
}

${SCHEMA_CONTEXT}

SECTION FORMATS you may use:

KPI row (summary numbers):
{
  "type": "kpi_row",
  "title": "Section Title",
  "items": [
    { "label": "Total Revenue", "field": "total_revenue", "format": "currency" },
    { "label": "Total Spend",   "field": "total_spend",   "format": "currency" },
    { "label": "MER",           "field": "mer",           "format": "number" }
  ],
  "query": {
    "table": "nobl_brand_tw_summary_daily",
    "columns": ["COALESCE(SUM(total_revenue),0) AS total_revenue", "COALESCE(SUM(total_spend),0) AS total_spend", "ROUND(SUM(total_revenue)/NULLIF(SUM(total_spend),0),2) AS mer"],
    "filters": { "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" }
  }
}

Time-series chart:
{
  "type": "line_chart",
  "title": "Revenue vs Spend",
  "xField": "date",
  "series": [
    { "field": "total_revenue", "label": "Revenue", "color": "#3b5bdb" },
    { "field": "total_spend",   "label": "Spend",   "color": "#cc8a00" }
  ],
  "query": {
    "table": "nobl_brand_tw_summary_daily",
    "columns": ["date", "total_revenue", "total_spend"],
    "filters": { "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
    "order_by": "date",
    "limit": 365
  }
}

Bar chart by channel:
{
  "type": "bar_chart",
  "title": "Spend by Channel",
  "xField": "channel",
  "series": [{ "field": "total_spend", "label": "Spend", "color": "#3b5bdb" }],
  "query": {
    "table": "nobl_brand_tw_channel_daily",
    "columns": ["channel", "COALESCE(SUM(spend_1d),0) AS total_spend"],
    "filters": { "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
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
    "table": "nobl_brand_tw_summary_daily",
    "columns": ["date", "total_revenue", "total_spend", "mer"],
    "filters": { "start_date": "DYNAMIC_START", "end_date": "DYNAMIC_TODAY" },
    "order_by": "-date",
    "limit": 90
  }
}

RULES:
- ONLY use columns that exist in the table you selected (see schema above)
- Use COALESCE(SUM(...), 0) for all aggregated numeric KPI columns to avoid nulls
- Use "DYNAMIC_TODAY" for end_date, "DYNAMIC_START" for default start (30 days ago)
- For specific periods like "April 2026", use "2026-04-01" / "2026-04-30"
- For channel tables: spend column is "spend_1d", revenue is "revenue_1d"
- For summary tables: spend column is "total_spend", revenue is "total_revenue"
- Use field aliases that EXACTLY match the "field" in items/series/columns arrays
- Include 3–5 sections. Always include at least one KPI row and one chart
- Respond ONLY with the JSON when generating (no markdown, no text before/after)
- Colors: NOBL=#3b5bdb, FLO=#2f9e6c, META=#1877f2, GOOGLE=#ea4335, TIKTOK=#000000, SNAPCHAT=#f59e0b`;
}

// ── Allowed tables and their allowed columns ──────────────────────
const ALLOWED_TABLES = {
  nobl_brand_tw_summary_daily:  ['date','brand','total_revenue','total_spend','mer','total_orders','new_customer_orders','returning_customer_orders'],
  flo_brand_tw_summary_daily:   ['date','brand','total_revenue','total_spend','mer','total_orders','new_customer_orders','returning_customer_orders'],
  nobl_brand_tw_channel_daily:  ['date','brand','channel','spend_1d','revenue_1d','purchases_1d','roas_1d','spend_7d','new_cust_orders','cac','portable_cac','wooden_cac','metal_cac'],
  flo_brand_tw_channel_daily:   ['date','brand','channel','spend_1d','revenue_1d','purchases_1d','roas_1d','spend_7d','new_cust_orders','cac','portable_cac','wooden_cac','metal_cac'],
  nobl_brand_tw_geo_daily:      ['date','brand','region','revenue_actual','spend_actual','mer'],
  flo_brand_tw_geo_daily:       ['date','brand','region','revenue_actual','spend_actual','mer'],
  flo_brand_tw_product_daily:   ['date','brand','product_line','spend','new_cust_orders','revenue','meta_spend','google_spend','tiktok_spend','snap_spend','pinterest_spend','bing_spend','applovin_spend'],
  nobl_air_sub_revenue_daily:   ['date','shopify_sub_gross','shopify_sub_disc','shopify_sub_refunds','rebill_revenue','new_sub_revenue','sub_revenue_actual'],
  appstle_subscriptions:        ['id','appstle_id','created_at_appstle','total_successful_orders','last_order_date','last_order_amount','status','customer_name','customer_email','next_billing_date','activated_on','cancelled_on'],
};

function validateTable(name) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TABLES, name);
}

// Replace DYNAMIC_* date placeholders
function resolveDates(filters, windowDays = 30) {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setDate(start.getDate() - windowDays);
  const startStr = start.toISOString().slice(0, 10);

  const out = { ...filters };
  if (out.start_date === 'DYNAMIC_START' || !out.start_date) out.start_date = startStr;
  if (out.end_date   === 'DYNAMIC_TODAY' || !out.end_date)   out.end_date   = today;
  // Replace any ISO date-like dynamic strings
  for (const k of Object.keys(out)) {
    if (String(out[k]).startsWith('DYNAMIC')) out[k] = k.includes('start') ? startStr : today;
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
function buildSectionQuery(query, defaultWindowDays = 30) {
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

  const filters = resolveDates(rawFilters, defaultWindowDays);
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

  let effectiveGroupBy = (rawGroupBy && Array.isArray(rawGroupBy))
    ? rawGroupBy.map(c => c.trim()).filter(c => ALLOWED_TABLES[table].includes(c.toLowerCase()))
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

  // WHERE
  const whereParts = [];
  if (filters.start_date) { whereParts.push(`date >= $${paramIdx++}`); params.push(filters.start_date); }
  if (filters.end_date)   { whereParts.push(`date <= $${paramIdx++}`); params.push(filters.end_date);   }
  if (filters.brand)      { whereParts.push(`brand = $${paramIdx++}`); params.push(filters.brand);      }
  if (filters.channel) {
    if (Array.isArray(filters.channel)) {
      whereParts.push(`channel = ANY($${paramIdx++})`); params.push(filters.channel);
    } else {
      whereParts.push(`channel = $${paramIdx++}`); params.push(filters.channel);
    }
  }
  if (filters.region)       { whereParts.push(`region = $${paramIdx++}`);       params.push(filters.region);       }
  if (filters.product_line) { whereParts.push(`product_line = $${paramIdx++}`); params.push(filters.product_line); }
  if (filters.status)       { whereParts.push(`status = $${paramIdx++}`);       params.push(filters.status);       }
  if (whereParts.length > 0) sql += ` WHERE ${whereParts.join(' AND ')}`;

  // GROUP BY
  if (effectiveGroupBy.length > 0) {
    sql += ` GROUP BY ${effectiveGroupBy.map(c => `"${c}"`).join(', ')}`;
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
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const r = await pgQuery(
      `SELECT id, name, description, config, is_public, created_at, updated_at
       FROM ai_dashboards WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.session.userId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[Dashboards GET /]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Create dashboard ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { name, description = '', config = {}, is_public = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const r = await pgQuery(
      `INSERT INTO ai_dashboards (user_id, name, description, config, is_public)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, config, is_public, created_at, updated_at`,
      [req.session.userId, name, description, JSON.stringify(config), is_public]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[Dashboards POST /]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Update dashboard ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { name, description, config, is_public } = req.body;
  const { id } = req.params;
  try {
    const existing = await pgQuery(
      `SELECT id FROM ai_dashboards WHERE id = $1 AND user_id = $2`,
      [id, req.session.userId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Dashboard not found' });
    const r = await pgQuery(
      `UPDATE ai_dashboards
       SET name=$1, description=$2, config=COALESCE($3,config), is_public=COALESCE($4,is_public), updated_at=NOW()
       WHERE id=$5 AND user_id=$6
       RETURNING id, name, description, config, is_public, created_at, updated_at`,
      [name||null, description||null, config ? JSON.stringify(config) : null, is_public ?? null, id, req.session.userId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[Dashboards PUT /:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete dashboard ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { id } = req.params;
  try {
    await pgQuery(
      `DELETE FROM ai_dashboards WHERE id=$1 AND user_id=$2`,
      [id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[Dashboards DELETE /:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Execute dashboard config ──────────────────────────────────────
router.post('/execute', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { config } = req.body;
  if (!config || !Array.isArray(config.sections)) {
    return res.status(400).json({ error: 'config.sections array is required' });
  }

  const results = {};
  const errors  = {};

  await Promise.all(
    config.sections.map(async (section, idx) => {
      if (!section.query) { results[idx] = []; return; }
      try {
        const { sql, params } = buildSectionQuery(section.query);
        console.log(`[Execute §${idx}]`, sql.slice(0, 200), params);
        const r = await pgQuery(sql, params);
        results[idx] = fmtRows(r.rows);
        console.log(`[Execute §${idx}] → ${r.rows.length} rows`);
      } catch (e) {
        console.error(`[Execute §${idx}]`, e.message);
        errors[idx] = e.message;
        results[idx] = [];
      }
    })
  );

  res.json({
    results,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  });
});

module.exports = { router, SCHEMA_CONTEXT, getClarifyPrompt };
