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
const { google } = require('googleapis');
const { Database } = require('node-sqlite3-wasm');
const cron = require('node-cron');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const OpenAI = require('openai').default;

// ── OpenAI setup ────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const AI_SYSTEM_PROMPT = `You are an expert analytics assistant embedded inside the NOBL Air & Pilates Flo executive dashboard. You have deep knowledge of both companies:

NOBL AIR (nobltravel.com):
- Sells AirTag holders, travel accessories, and luggage products via Shopify
- Key business model: customers buy products AND optionally subscribe to "Air" subscription
- Critical KPIs: Orders, Air Orders, Attach Rate (% of orders with subscription), Trial-to-Paid (TTP) conversion rate, New Subscribers, Rebill Revenue, Tag Revenue
- Price tiers: $79, $99, $119, $129, $139, $149 per year
- Channels: Facebook Ads, organic, email, referral
- Important metrics: Cohort retention, weekly trends, product mix, channel attribution

PILATES FLO (pilatesflo.com):
- Pilates studio and fitness business
- Tracks class attendance, memberships, revenue

YOUR EXPERTISE:
- E-commerce analytics & Shopify metrics
- Subscription SaaS/DTC business KPIs and benchmarks
- Facebook/Meta advertising performance analysis
- Financial forecasting and revenue modeling
- Cohort analysis and customer retention
- Product performance and inventory analysis
- Marketing attribution and ROAS analysis
- General business strategy for DTC brands

BEHAVIOR:
- Be concise, direct, and actionable — this is used by finance, marketing, and management
- Highlight anomalies, trends, and opportunities immediately
- Use bullet points for lists, be specific with numbers
- When you don't have enough data, say so and suggest what to look at
- Proactively notice problems or opportunities in the data
- Format currency as $X,XXX and percentages clearly`;

const app = express();
const PORT = process.env.PORT || 3001;

// ── SQLite setup ────────────────────────────────────────────────
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

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY CHECK(id=1),
    tokens TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Settings helpers ────────────────────────────────────────────
function getSetting(key, fallback='') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : fallback;
}
function setSetting(key, value) {
  const v = String(value == null ? '' : value);
  try {
    db.prepare('UPDATE settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?').run(v, key);
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!r) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, v);
  } catch(e) {
    console.error('[Settings] setSetting error:', e.message);
  }
}
function getActiveSpreadsheetId() {
  return getSetting('spreadsheet_id', process.env.SPREADSHEET_ID || '');
}

// ── Cache ───────────────────────────────────────────────────────
const cache = {
  data: {},
  spreadsheetId: null,
  spreadsheetTitle: null,
  tabNames: [],
  lastFetched: null,
  ttl: (parseInt(process.env.CACHE_TTL_SECONDS) || 300) * 1000,
  isStale() { return !this.lastFetched || Date.now() - this.lastFetched > this.ttl; }
};

// ── OAuth2 client ───────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

function saveTokens(t) {
  db.prepare(`INSERT INTO oauth_tokens(id,tokens) VALUES(1,?)
    ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,updated_at=CURRENT_TIMESTAMP`)
    .run(JSON.stringify(t));
}
function loadTokens() {
  const r = db.prepare('SELECT tokens FROM oauth_tokens WHERE id=1').get();
  return r ? JSON.parse(r.tokens) : null;
}

const saved = loadTokens();
if (saved) { oauth2Client.setCredentials(saved); console.log('[Auth] Restored tokens'); }
oauth2Client.on('tokens', t => { saveTokens({ ...oauth2Client.credentials, ...t }); });

// ── Header row detection ────────────────────────────────────────
function findHeaderRow(rows) {
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i] || [];
    const nonEmpty = row.filter(v => v !== '' && v !== null && v !== undefined);
    if (nonEmpty.length < 2) continue;
    if (typeof nonEmpty[0] !== 'string') continue;
    const stringCount = nonEmpty.filter(v => typeof v === 'string').length;
    const score = nonEmpty.length + stringCount;
    if (score > best.score) best = { idx: i, score };
  }
  return best.score >= 0 ? best.idx : 0;
}

// ── Fetch all tabs from a spreadsheet ──────────────────────────
async function getSpreadsheetMeta(sid) {
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sid,
    fields: 'properties.title,sheets.properties.title'
  });
  const title = meta.data.properties?.title || sid;
  const tabs = meta.data.sheets.map(s => s.properties.title);
  return { title, tabs };
}

async function fetchAllTabs(sid) {
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const { title, tabs } = await getSpreadsheetMeta(sid);
  cache.spreadsheetTitle = title;
  cache.tabNames = tabs;

  const result = {};
  await Promise.all(tabs.map(async tab => {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `'${tab}'`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      });
      const rows = res.data.values || [];
      if (rows.length < 2) { result[tab] = { headers: rows[0]||[], rows: [] }; return; }
      const hi = findHeaderRow(rows);
      const headers = rows[hi].map(String);
      result[tab] = {
        headers,
        rows: rows.slice(hi + 1).map(r => {
          const o = {}; headers.forEach((h, i) => o[h] = r[i] ?? ''); return o;
        })
      };
    } catch(e) {
      console.warn(`[Sheets] "${tab}": ${e.message}`);
      result[tab] = { headers:[], rows:[], error: e.message };
    }
  }));
  return result;
}

async function refreshCache(newSid) {
  const creds = oauth2Client.credentials;
  if (!creds?.access_token && !creds?.refresh_token) { console.warn('[Cache] Not authenticated'); return; }
  const sid = newSid || getActiveSpreadsheetId();
  if (!sid) { console.warn('[Cache] No spreadsheet ID'); return; }
  try {
    console.log(`[Cache] Refreshing "${sid}"...`);
    cache.data = await fetchAllTabs(sid);
    cache.spreadsheetId = sid;
    cache.lastFetched = Date.now();
    console.log(`[Cache] Done — ${Object.keys(cache.data).length} tabs from "${cache.spreadsheetTitle}"`);
  } catch(e) { console.error('[Cache] Failed:', e.message); }
}

// ── Middleware ──────────────────────────────────────────────────
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  store: new FileStore({ path: path.join(__dirname,'../data/sessions'), ttl: 30*24*60*60, retries: 0, logFn: ()=>{} }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30*24*60*60*1000 }
}));

function requireAuth(req, res, next) {
  const c = oauth2Client.credentials;
  if (!c?.access_token && !c?.refresh_token)
    return res.status(401).json({ error:'Not authenticated', authUrl:'/auth/login' });
  next();
}

// ── Auth routes ─────────────────────────────────────────────────
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

app.get('/auth/login', (req, res) => {
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: SCOPES
  }));
});

app.get('/auth/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/?auth=error');
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    await refreshCache();
    res.redirect('/?auth=success');
  } catch(e) { console.error('[Auth]', e.message); res.redirect('/?auth=error'); }
});

app.get('/auth/status', (req, res) => {
  const c = oauth2Client.credentials;
  res.json({
    authenticated: !!(c?.access_token || c?.refresh_token),
    lastFetched: cache.lastFetched ? new Date(cache.lastFetched).toISOString() : null,
    tabsLoaded: Object.keys(cache.data).length,
    spreadsheetId: cache.spreadsheetId || getActiveSpreadsheetId(),
    spreadsheetTitle: cache.spreadsheetTitle || null,
  });
});

app.post('/auth/logout', (req, res) => {
  db.prepare('DELETE FROM oauth_tokens WHERE id=1').run();
  oauth2Client.setCredentials({});
  cache.data = {}; cache.lastFetched = null; cache.spreadsheetTitle = null; cache.tabNames = [];
  res.json({ ok: true });
});

// ── Drive — list all user's spreadsheets ────────────────────────
app.get('/api/drive/sheets', requireAuth, async (req, res) => {
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const result = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'files(id,name,modifiedTime,owners)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
    });
    res.json(result.data.files || []);
  } catch(e) {
    console.error('[Drive]', e.message);
    // If scope not granted, return empty list with hint
    res.json({ error: e.message, needsReauth: e.message.toLowerCase().includes('insufficient') || e.message.toLowerCase().includes('permission') || e.message.toLowerCase().includes('forbidden') });
  }
});

// ── Spreadsheet management ──────────────────────────────────────
app.get('/api/spreadsheet', requireAuth, (req, res) => {
  res.json({
    id: cache.spreadsheetId || getActiveSpreadsheetId(),
    title: cache.spreadsheetTitle,
    tabs: cache.tabNames,
    lastFetched: cache.lastFetched ? new Date(cache.lastFetched).toISOString() : null,
  });
});

app.post('/api/spreadsheet/select', requireAuth, async (req, res) => {
  const { spreadsheetId } = req.body;
  if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });
  try {
    setSetting('spreadsheet_id', spreadsheetId);
    await refreshCache(spreadsheetId);
    res.json({
      ok: true,
      id: spreadsheetId,
      title: cache.spreadsheetTitle,
      tabs: cache.tabNames,
    });
  } catch(e) {
    console.error('[Select]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sheets API ──────────────────────────────────────────────────
app.get('/api/sheets/refresh', requireAuth, async (req, res) => {
  await refreshCache();
  res.json({ ok: true, lastFetched: new Date(cache.lastFetched).toISOString(), tabs: cache.tabNames });
});

app.get('/api/sheets/tabs', requireAuth, (req, res) => res.json(Object.keys(cache.data)));

app.get('/api/sheets/:tab', requireAuth, async (req, res) => {
  if (cache.isStale()) await refreshCache();
  const tab = decodeURIComponent(req.params.tab);
  const d = cache.data[tab];
  if (!d) return res.status(404).json({ error:`Tab "${tab}" not found` });
  const annotations = db.prepare('SELECT * FROM annotations WHERE tab=? ORDER BY created_at DESC').all(tab);
  const highlights = db.prepare('SELECT * FROM highlights WHERE tab=?').all(tab);
  const hlKeys = new Set(highlights.map(h=>h.row_key));
  const enriched = d.rows.map((row, i) => {
    const rk = String(row['Date']||row['Tier']||row['Variant']||row['Channel']||row['Week (Mon)']||row['Cohort Week']||row['Day']||row['Product / Bundle']||row['Campaign Name']||i);
    return { ...row, _rowKey:rk, _highlighted:hlKeys.has(rk)?highlights.find(h=>h.row_key===rk)?.color||'yellow':null, _annotations:annotations.filter(a=>a.row_key===rk) };
  });
  res.json({ tab, headers:d.headers, rows:enriched, lastFetched: cache.lastFetched?new Date(cache.lastFetched).toISOString():null });
});

// ── Annotations ─────────────────────────────────────────────────
app.get('/api/annotations', requireAuth, (req, res) => {
  const rows = req.query.tab
    ? db.prepare('SELECT * FROM annotations WHERE tab=? ORDER BY created_at DESC').all(req.query.tab)
    : db.prepare('SELECT * FROM annotations ORDER BY created_at DESC').all();
  res.json(rows);
});
app.post('/api/annotations', requireAuth, (req, res) => {
  const { tab, row_key, metric, note, color, author } = req.body;
  if (!tab||!row_key||!note) return res.status(400).json({ error:'tab, row_key, note required' });
  const r = db.prepare('INSERT INTO annotations(tab,row_key,metric,note,color,author) VALUES(?,?,?,?,?,?)')
    .run(tab, row_key, metric||'', note, color||'yellow', author||'user');
  res.json(db.prepare('SELECT * FROM annotations WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/annotations/:id', requireAuth, (req, res) => {
  const { note, color } = req.body;
  db.prepare('UPDATE annotations SET note=?,color=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(note, color||'yellow', req.params.id);
  res.json(db.prepare('SELECT * FROM annotations WHERE id=?').get(req.params.id));
});
app.delete('/api/annotations/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM annotations WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── Highlights ──────────────────────────────────────────────────
app.post('/api/highlights', requireAuth, (req, res) => {
  const { tab, row_key, color } = req.body;
  if (!tab||!row_key) return res.status(400).json({ error:'tab, row_key required' });
  db.prepare('INSERT INTO highlights(tab,row_key,color) VALUES(?,?,?) ON CONFLICT(tab,row_key) DO UPDATE SET color=excluded.color')
    .run(tab, row_key, color||'yellow');
  res.json({ ok:true });
});
app.delete('/api/highlights', requireAuth, (req, res) => {
  db.prepare('DELETE FROM highlights WHERE tab=? AND row_key=?').run(req.body.tab, req.body.row_key);
  res.json({ ok:true });
});

// ── AI Chat ─────────────────────────────────────────────────────
app.post('/api/ai/chat', requireAuth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { messages = [], context = '', tab = '' } = req.body;
    const tabData = tab && cache.data[tab] ? cache.data[tab] : null;
    let contextBlock = context || '';
    if (tabData) {
      const sample = (tabData.rows || []).slice(0, 30);
      contextBlock += `\n\nUser is currently viewing tab: "${tab}"\nHeaders: ${JSON.stringify(tabData.headers)}\nSample data (first 30 rows): ${JSON.stringify(sample)}`;
    }
    const systemContent = contextBlock
      ? `${AI_SYSTEM_PROMPT}\n\n--- CURRENT DASHBOARD CONTEXT ---\n${contextBlock}`
      : AI_SYSTEM_PROMPT;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemContent }, ...messages],
      max_tokens: 1200,
      temperature: 0.7,
    });
    res.json({ reply: response.choices[0].message.content });
  } catch(e) {
    console.error('[AI Chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI Insights (per-tab analysis) ──────────────────────────────
app.post('/api/ai/insights', requireAuth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { tab, headers, rows } = req.body;
    const sample = (rows || []).slice(0, 40);
    const prompt = `Analyze this dashboard data tab named "${tab}" and give 3-4 sharp business insights.
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

// ── AI Field Helper (for data entry) ────────────────────────────
app.post('/api/ai/field-help', requireAuth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  try {
    const { tab, field, currentValue, allFields } = req.body;
    const prompt = `The user is entering data in the "${tab}" tab of the NOBL Air dashboard.
They are filling in the field: "${field}"
Current value: ${currentValue || '(empty)'}
All fields in this form: ${JSON.stringify(allFields)}

In 2-3 sentences, explain: what this field means, what a good value looks like, and any tips for entering it correctly. Be specific to NOBL Air's business.`;

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

// ── Cron ────────────────────────────────────────────────────────
cron.schedule(process.env.REFRESH_CRON||'0 8 * * *', () => {
  console.log('[Cron] Scheduled refresh');
  refreshCache();
});

// ── Serve React ─────────────────────────────────────────────────
const clientBuild = path.join(__dirname,'../client/build');
app.use(express.static(clientBuild));
app.get('*', (req,res) => res.sendFile(path.join(clientBuild,'index.html')));

app.listen(PORT, () => {
  console.log(`\n  NOBL Air Dashboard → http://localhost:${PORT}`);
  console.log(`   Google Auth → http://localhost:${PORT}/auth/login\n`);
  if (saved) refreshCache();
});
