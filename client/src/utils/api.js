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

export const setHighlight = body => fetch(`${B}/api/highlights`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
export const removeHighlight = body => fetch(`${B}/api/highlights`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());

const COMPACT_UNITS = [
  { value: 1e12, suffix: 'T' },
  { value: 1e9, suffix: 'B' },
  { value: 1e6, suffix: 'M' },
  { value: 1e3, suffix: 'K' },
];

function stripTrailingZeros(s) {
  return String(s).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function formatCompactValue(value, { prefix = '', minForCompact = 1000, compactDigits = 1, smallDigits = 0 } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const unit = COMPACT_UNITS.find(u => abs >= u.value && abs >= minForCompact);
  if (unit) {
    const scaled = abs / unit.value;
    const maxDigits = typeof compactDigits === 'function' ? compactDigits(scaled, unit.suffix) : compactDigits;
    return `${sign}${prefix}${stripTrailingZeros(scaled.toFixed(maxDigits))}${unit.suffix}`;
  }
  return `${sign}${prefix}${abs.toLocaleString(undefined, {
    minimumFractionDigits: smallDigits,
    maximumFractionDigits: smallDigits,
  })}`;
}

export function fmt$(n){
  const v=parseFloat(n);
  if(isNaN(v)) return '—';
  return formatCompactValue(v, {
    prefix: '$',
    compactDigits: (scaled) => scaled >= 100 ? 1 : 2,
    smallDigits: 2,
  });
}

// Handles both decimal fractions (0.326 → 32.6%) and already-percent values (32.6 → 32.6%)
export function fmtPct(n){
  const v=parseFloat(n);
  if(isNaN(v)) return '—';
  // Values stored as decimals (0.0–1.0 range)
  const pct = Math.abs(v) <= 1.5 ? v * 100 : v;
  return `${pct.toFixed(1)}%`;
}

export function fmtNum(n){
  const v=Math.round(parseFloat(n)||0);
  return formatCompactValue(v, { compactDigits: 1, smallDigits: 0 });
}

export function fmtFullNum(n){
  const v=Math.round(parseFloat(n)||0);
  return v.toLocaleString();
}

export function fmtFull$(n){
  const v=parseFloat(n);
  if(isNaN(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
  return h.includes('rate')||h.includes('%')||h.includes('pct')||h.includes('conv');
}
export function isCurrency(header){
  const h=String(header).toLowerCase();
  return h.includes('revenue')||h.includes('gross')||h.includes('sales')||
    h.includes('amount')||h.includes('rev')||h.startsWith('$')||h.includes('price')||
    h.includes('spend')||h.includes('cost')||h.includes('cac')||h.includes('aov')||
    h.includes('ltv')||h.includes('budget')||h.includes('profit')||h.includes('margin');
}
export function isDateField(header){
  const h=String(header).toLowerCase();
  return h==='date'||h.includes('week')||h==='cohort week';
}

// ── Analytics API ─────────────────────────────────────────────────
export const getOverview = (start, end) => fetch(`${B}/api/analytics/overview?start=${start}&end=${end}`).then(r=>r.json());
export const getNoblTopline = (start, end) => fetch(`${B}/api/analytics/nobl/topline?start=${start}&end=${end}`).then(r=>r.json());
export const getFloTopline = (start, end) => fetch(`${B}/api/analytics/flo/topline?start=${start}&end=${end}`).then(r=>r.json());
export const getChannels = (start, end, brand='') => fetch(`${B}/api/analytics/channels?start=${start}&end=${end}&brand=${brand}`).then(r=>r.json());
export const getNoblSubs = (start, end) =>
  fetchJson(`${B}/api/analytics/nobl/subscriptions?start=${start}&end=${end}`, '/api/analytics/nobl/subscriptions');
export const getSubscriptions = (start, end, brand = 'NOBL') =>
  fetchJson(
    `${B}/api/analytics/subscriptions?start=${start}&end=${end}&brand=${encodeURIComponent(brand)}`,
    '/api/analytics/subscriptions'
  );
export const getNoblAirDataVersion = () => fetchNoblAirDataVersionCached();

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
  fetchJson(
    `${B}/api/analytics/forecast-engine?brand=${encodeURIComponent(brand)}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''}`,
    '/api/analytics/forecast-engine'
  );

export const getDashboardForecast = (asOf = '') =>
  fetchJson(
    `${B}/api/analytics/dashboard-forecast${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`,
    '/api/analytics/dashboard-forecast'
  );
export const getFloProducts = (start, end) => fetch(`${B}/api/analytics/flo/products?start=${start}&end=${end}`).then(r=>r.json());

// ── Store pages (comprehensive per-store data) ────────────────────
export const getStoreNobl = (start, end) => fetch(`${B}/api/store/nobl?start=${start}&end=${end}`).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); });
export const getStoreFlo  = (start, end) => fetch(`${B}/api/store/flo?start=${start}&end=${end}`).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); });
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
  // Currency columns
  if(isCurrency(h)) return fmt$(val);
  const n=Number(s.trim());
  if(s.trim()!==''&&Number.isFinite(n)){
    if(Number.isInteger(n)&&n>999) return fmtNum(n);
    if(!Number.isInteger(n)) return n.toLocaleString(undefined,{maximumFractionDigits:2});
  }
  return s;
}
