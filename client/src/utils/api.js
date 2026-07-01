import {
  cachedAnalyticsFetch,
  fetchNoblAirDataVersion as fetchNoblAirDataVersionCached,
} from './analyticsCache';

const B = '';

async function fetchJson(url, routeHint = 'API route') {
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const body = await res.text();
    const looksLikeHtml = body.trim().startsWith('<');
    throw new Error(
      looksLikeHtml
        ? `${routeHint} returned HTML instead of JSON. Restart the server, hard-refresh the dashboard, and sign in again.`
        : `Unexpected response format from ${routeHint}.`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ── App-level auth ───────────────────────────────────────────────
export const appStatus  = () => fetch(`${B}/auth/app-status`).then(r=>r.json());
export const appLogin   = (email,password) => fetch(`${B}/auth/app-login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})}).then(r=>r.json());
export const appSignup  = (email,password,name) => fetch(`${B}/auth/app-signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,name})}).then(r=>r.json());
export const appLogout  = () => fetch(`${B}/auth/app-logout`,{method:'POST'}).then(r=>r.json());
export const verifyErpToken = (token, theme) => fetch(`${B}/auth/erp-verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ token, theme }),
}).then(async r => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `ERP verify failed (${r.status})`);
  return data;
});

export const getStatus = () => fetch(`${B}/auth/status`).then(r=>r.json());
export const getSummary = () => fetch(`${B}/api/summary`).then(r=>{ if(!r.ok)throw new Error(r.status); return r.json(); });
export const getTab = t => fetch(`${B}/api/sheets/${encodeURIComponent(t)}`).then(r=>{ if(!r.ok)throw new Error(r.status); return r.json(); });
export const getTabs = () => fetch(`${B}/api/sheets/tabs`).then(r=>r.json());
export const refreshSheets = () => fetch(`${B}/api/sheets/refresh`).then(r=>r.json());
export const getDriveSheets = () => fetch(`${B}/api/drive/sheets`).then(r=>r.json());
export const getSpreadsheet = () => fetch(`${B}/api/spreadsheet`).then(r=>r.json());
export const selectSpreadsheet = (id) => fetch(`${B}/api/spreadsheet/select`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spreadsheetId:id})}).then(r=>r.json());

export const aiChat = (messages, context='', tab='') =>
  fetch(`${B}/api/ai/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,context,tab})}).then(r=>r.json());

export const aiInsights = (tab, headers, rows) =>
  fetch(`${B}/api/ai/insights`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tab,headers,rows})}).then(r=>r.json());

export const aiFieldHelp = (tab, field, currentValue, allFields) =>
  fetch(`${B}/api/ai/field-help`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tab,field,currentValue,allFields})}).then(r=>r.json());

export const addAnnotation = body => fetch(`${B}/api/annotations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
export const updateAnnotation = (id,body) => fetch(`${B}/api/annotations/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
export const deleteAnnotation = id => fetch(`${B}/api/annotations/${id}`,{method:'DELETE'}).then(r=>r.json());

export const getComments = (pageKey) => fetch(`${B}/api/comments?page_key=${encodeURIComponent(pageKey)}`, { credentials: 'include' }).then(async (r) => {
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
});
export const createComment = (body) => fetch(`${B}/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }).then(async (r) => {
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
});
export const updateComment = (id, body) => fetch(`${B}/api/comments/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }).then(async (r) => {
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
});
export const deleteComment = (id) => fetch(`${B}/api/comments/${id}`, { method: 'DELETE', credentials: 'include' }).then(async (r) => {
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
});

export const setHighlight = body => fetch(`${B}/api/highlights`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
export const removeHighlight = body => fetch(`${B}/api/highlights`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());

const INT_OPTS = { minimumFractionDigits: 0, maximumFractionDigits: 0 };

export function fmt$(n) {
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString(undefined, INT_OPTS)}`;
}

// Handles both decimal fractions (0.326 → 33%) and already-percent values (32.6 → 33%)
export function fmtPct(n) {
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  const pct = Math.abs(v) <= 1.5 ? v * 100 : v;
  return `${Math.round(pct)}%`;
}

export function fmtRatio(n) {
  const v = parseFloat(n);
  if (isNaN(v)) return '—';
  return `${v.toFixed(2)}x`;
}

export function fmtNum(n) {
  const v = Math.round(parseFloat(n) || 0);
  if (isNaN(v)) return '—';
  return v.toLocaleString(undefined, INT_OPTS);
}

export const fmtFullNum = fmtNum;
export const fmtFull$ = fmt$;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function fmtDate(val){
  const s = String(val);
  if(!DATE_RE.test(s)) return s;
  const [,mo,dy] = s.split('-');
  return `${MONTHS_SHORT[parseInt(mo,10)-1]} ${parseInt(dy,10)}`;
}

export function isPercent(header){
  const h=String(header).toLowerCase();
  if (h.includes('%') || h.includes('pct')) return true;
  if (/attach|ttp|nvp|activation/.test(h)) return true;
  if (h.includes('rate') && !h.includes('operating')) return true;
  return false;
}
export function isCurrency(header){
  const h=String(header).toLowerCase();
  if (/^cac$|customer acquisition/.test(h)) return true;
  return h.includes('revenue')||h.includes('gross')||h.includes('sales')||
    h.includes('amount')||h.includes('rev')||h.startsWith('$')||h.includes('price')||
    h.includes('spend')||h.includes('cost')||h.includes('aov')||
    h.includes('ltv')||h.includes('budget')||h.includes('profit')||h.includes('margin')||
    h.includes('refund')||h.includes('discount');
}
/** True when a column/series label is MER or ROAS — not substrings like "customer". */
export function isMerRoasLabel(text) {
  const h = String(text).toLowerCase();
  return h.includes('roas') || /\bmer\b/.test(h) || h.includes('sales per ad');
}

export function isRatio(header) {
  return isMerRoasLabel(header);
}
export function isDateField(header){
  const h=String(header).toLowerCase();
  return h==='date'||h.includes('week')||h==='cohort week';
}

// ── Analytics API ─────────────────────────────────────────────────
// Heavy read endpoints are cached client-side (sessionStorage, keyed by the
// NOBL Air data version) so re-visits and date/tab switches return instantly.
// The cache busts automatically when new data lands (version changes after a sync).
export const getOverview = (start, end) =>
  cachedAnalyticsFetch(`overview:${start}:${end}`,
    () => fetch(`${B}/api/analytics/overview?start=${start}&end=${end}`).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `Request failed (${r.status})`);
      return d;
    }),
  ).then(x => x.data);
export const getNoblTopline = (start, end) =>
  cachedAnalyticsFetch(`nobl-topline:${start}:${end}`,
    () => fetch(`${B}/api/analytics/nobl/topline?start=${start}&end=${end}`).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      return data;
    }),
  ).then(x => x.data);
export const getFloTopline = (start, end) =>
  cachedAnalyticsFetch(`flo-topline:${start}:${end}`,
    () => fetch(`${B}/api/analytics/flo/topline?start=${start}&end=${end}`).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      return data;
    }),
  ).then(x => x.data);
export const getChannels = (start, end, brand='', region='') =>
  cachedAnalyticsFetch(`channels:${start}:${end}:${brand}:${region}`,
    () => fetch(`${B}/api/analytics/channels?start=${start}&end=${end}&brand=${brand}${region ? `&region=${encodeURIComponent(region)}` : ''}`).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
      return data;
    }),
  ).then(x => x.data);
export const getNoblSubs = (start, end) =>
  fetchJson(`${B}/api/analytics/nobl/subscriptions?start=${start}&end=${end}`, '/api/analytics/nobl/subscriptions');
export const getSubscriptions = (start, end, brand = 'NOBL') =>
  cachedAnalyticsFetch(`subs:${start}:${end}:${brand}`,
    () => fetchJson(
      `${B}/api/analytics/subscriptions?start=${start}&end=${end}&brand=${encodeURIComponent(brand)}`,
      '/api/analytics/subscriptions'
    ),
  ).then(x => x.data);
export const getNoblAirDataVersion = () => fetchNoblAirDataVersionCached();

/** Earliest & latest dates that actually have data (for the "All" date preset). */
export const getDataBounds = () =>
  cachedAnalyticsFetch('data-bounds',
    () => fetch(`${B}/api/analytics/data-bounds`).then((r) => r.json()),
  ).then((x) => x.data);

/** Leadership KPI matrix (daily/weekly/quarterly) computed from existing DB tables. */
export const getKpiPulse = ({ month } = {}) => {
  const qs = new URLSearchParams();
  if (month) qs.set('month', month);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetch(`${B}/api/analytics/kpi-pulse${suffix}`).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || `Request failed (${r.status})`);
    return d;
  });
};

export const saveKpiPulseOverride = (key, payload) =>
  fetch(`${B}/api/analytics/kpi-pulse/overrides`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ key, payload }),
  }).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || `Request failed (${r.status})`);
    return d;
  });

export const getNoblAirSubscribers = (start, end) =>
  cachedAnalyticsFetch(
    `subs:${start}:${end}`,
    () => fetch(`${B}/api/analytics/nobl/air-subscribers?start=${start}&end=${end}`).then((r) => r.json()),
  ).then((x) => x.data);

export const getNoblAirPerformance = async (start, end, rollingDays = 14, forecastDays = 14, region = 'ALL') => {
  // region can be a single code ("US") or a comma-separated list ("US,CA").
  // Keep it as a string for URL encoding.
  const regionParam = Array.isArray(region) ? region.join(',') : region;
  const cacheKey = `perf:${start}:${end}:${regionParam}:${rollingDays}:${forecastDays}`;
  const { data } = await cachedAnalyticsFetch(cacheKey, async () => {
    const res = await fetch(
      `${B}/api/analytics/nobl/air-performance?start=${start}&end=${end}&rollingDays=${rollingDays}&forecastDays=${forecastDays}&region=${encodeURIComponent(regionParam)}`
    );
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const body = await res.text();
      const looksLikeHtml = body.trim().startsWith('<');
      throw new Error(
        looksLikeHtml
          ? 'API route not available yet. Please restart the server so /api/analytics/nobl/air-performance is registered.'
          : 'Unexpected response format from server.'
      );
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
    return json;
  });
  return data;
};

/** Fetch global + base-region Air data once per date range; filter client-side via resolveAirPerfFromBundle. */
export const getNoblAirPerformanceBundle = async (start, end) => {
  const cacheKey = `perf-bundle:${start}:${end}`;
  const { data } = await cachedAnalyticsFetch(cacheKey, async () => {
    const res = await fetch(
      `${B}/api/analytics/nobl/air-performance-bundle?start=${start}&end=${end}`
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
    return json;
  });
  return data;
};

export const getNoblAirForecast = (asOf) =>
  cachedAnalyticsFetch(
    `forecast:${asOf || ''}`,
    () => fetch(`${B}/api/analytics/nobl/air-forecast?asOf=${encodeURIComponent(asOf || '')}`).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }),
  ).then((x) => x.data);

export const getNoblAirMetaAdsets = async (start, end, limit = 50) => {
  const res = await fetch(`${B}/api/analytics/nobl/air-meta-adsets?start=${start}&end=${end}&limit=${limit}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const body = await res.text();
    const looksLikeHtml = body.trim().startsWith('<');
    throw new Error(
      looksLikeHtml
        ? 'API route not available in the running app. Please restart the server and hard-refresh the dashboard.'
        : 'Unexpected response format from server.'
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
};
export const getMetaAds = (
  start, end, level = 'adset', brand = 'NOBL', page = 1, pageSize = 20, search = '', searchColumn = '',
  sortBy = '', sortDir = 'desc',
) => {
  const q = search ? `&search=${encodeURIComponent(search)}` : '';
  const col = searchColumn && searchColumn !== '__all__'
    ? `&search_column=${encodeURIComponent(searchColumn)}`
    : '';
  const sort = sortBy
    ? `&sort_by=${encodeURIComponent(sortBy)}&sort_dir=${encodeURIComponent(sortDir)}`
    : '';
  return fetch(`${B}/api/analytics/meta/ads?start=${start}&end=${end}&level=${level}&brand=${encodeURIComponent(brand)}&page=${page}&page_size=${pageSize}${q}${col}${sort}`).then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
};
export const getNoblAirAttribution = (
  start, end, level = 'ad', page = 1, pageSize = 20, search = '', searchColumn = '',
  sortBy = '', sortDir = 'desc',
) => {
  const q = search ? `&search=${encodeURIComponent(search)}` : '';
  const col = searchColumn && searchColumn !== '__all__'
    ? `&search_column=${encodeURIComponent(searchColumn)}`
    : '';
  const sort = sortBy
    ? `&sort_by=${encodeURIComponent(sortBy)}&sort_dir=${encodeURIComponent(sortDir)}`
    : '';
  return fetch(`${B}/api/analytics/nobl/air-attribution?start=${start}&end=${end}&level=${level}&page=${page}&page_size=${pageSize}${q}${col}${sort}`).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
};
export const getForecastEngine = (brand = 'ALL', asOf = '') =>
  cachedAnalyticsFetch(`forecast-engine:${brand}:${asOf}`,
    () => fetchJson(
      `${B}/api/analytics/forecast-engine?brand=${encodeURIComponent(brand)}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''}`,
      '/api/analytics/forecast-engine'
    ),
  ).then(x => x.data);

export const getForecastDaily = (brand = 'ALL', start = '', end = '') =>
  cachedAnalyticsFetch(`forecast-daily:${brand}:${start}:${end}`,
    () => fetchJson(
      `${B}/api/analytics/forecast-daily?brand=${encodeURIComponent(brand)}${start ? `&start=${encodeURIComponent(start)}` : ''}${end ? `&end=${encodeURIComponent(end)}` : ''}`,
      '/api/analytics/forecast-daily'
    ),
  ).then(x => x.data);

export const getIap = (brand = 'ALL', start = '', end = '') =>
  fetchJson(
    `${B}/api/analytics/iap?brand=${encodeURIComponent(brand)}${start ? `&start=${encodeURIComponent(start)}` : ''}${end ? `&end=${encodeURIComponent(end)}` : ''}`,
    '/api/analytics/iap'
  );

export const getDashboardForecast = (asOf = '') =>
  cachedAnalyticsFetch(`dashboard-forecast:${asOf}`,
    () => fetchJson(
      `${B}/api/analytics/dashboard-forecast${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`,
      '/api/analytics/dashboard-forecast'
    ),
  ).then(x => x.data);

export const getFloProducts = (start, end) =>
  cachedAnalyticsFetch(`flo-products:${start}:${end}`,
    () => fetch(`${B}/api/analytics/flo/products?start=${start}&end=${end}`).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `Request failed (${r.status})`);
      return d;
    }),
  ).then(x => x.data);

// ── Store pages (comprehensive per-store data) ────────────────────
export const getStoreNobl = (start, end) =>
  cachedAnalyticsFetch(`store-nobl:${start}:${end}`,
    () => fetch(`${B}/api/store/nobl?start=${start}&end=${end}`).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); }),
  ).then(x => x.data);
export const getStoreFlo  = (start, end) =>
  cachedAnalyticsFetch(`store-flo:${start}:${end}`,
    () => fetch(`${B}/api/store/flo?start=${start}&end=${end}`).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); }),
  ).then(x => x.data);
export const getSyncStatus = () => fetch(`${B}/api/sync/status`).then(r=>r.json());
export const triggerSync = (opts={}) => fetch(`${B}/api/sync/trigger`, {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(opts),
}).then(r=>r.json());
export const getDashboards = () => fetch(`${B}/api/dashboards`).then(r=>r.json());
export const saveDashboard = (d) => fetch(`${B}/api/dashboards`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json());
export const updateDashboard = (id, d) => fetch(`${B}/api/dashboards/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d)}).then(r=>r.json());
export const deleteDashboard = (id) => fetch(`${B}/api/dashboards/${id}`, {method:'DELETE'}).then(r=>r.json());
export const generateDashboard = (messages) => fetch(`${B}/api/ai/dashboard-generate`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages})}).then(r=>r.json());
export const executeDashboard = (config) => fetch(`${B}/api/dashboards/execute`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({config})}).then(r=>r.json());

export const getSyncDetail = () => fetch(`${B}/api/sync/status`).then(r=>r.json());
export const runBackfill = (body) => fetch(`${B}/api/sync/trigger`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}).then(r=>r.json());

export function fmtCell(val,header){
  if(val===''||val===null||val===undefined) return '—';
  const s=String(val);
  if(s==='TOTAL'||s==='Total') return s;
  // Pre-formatted strings (already include currency/percent symbols) → pass through.
  // Prevents double-formatting when callers format upstream and SheetTable formats again.
  if(/^\s*[$€£¥]/.test(s) || /%\s*$/.test(s)) return s;
  const h=String(header);
  const hl=h.toLowerCase();
  if(hl==='brand'||hl==='campaign'||hl==='ad set'||hl==='ad'||/(^|\s)id($|\s)/.test(hl)) return s;
  // Date columns
  if(isDateField(h)&&DATE_RE.test(s)) return fmtDate(val);
  // Percent columns
  if(isPercent(h)) return fmtPct(val);
  if(isRatio(h)) return fmtRatio(val);
  // Currency columns
  if(isCurrency(h)) return fmt$(val);
  const n=Number(s.trim());
  if(s.trim()!==''&&Number.isFinite(n)){
    if(Number.isInteger(n)) return fmtNum(n);
    return n.toLocaleString(undefined, INT_OPTS);
  }
  return s;
}
