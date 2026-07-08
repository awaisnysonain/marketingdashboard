/**
 * Session cache for analytics pages. Invalidates when server data version changes (after ETL).
 */
const PREFIX = 'nobl-analytics-cache:v2:';
const VERSION_KEY = `${PREFIX}data-version`;

let versionPromise = null;
let currentVersion = null;

export async function fetchNoblAirDataVersion() {
  if (versionPromise) return versionPromise;
  versionPromise = fetch('/api/analytics/nobl/data-version')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.version) {
        if (currentVersion && currentVersion !== data.version) {
          pruneOtherVersions(data.version);
        }
        currentVersion = data.version;
        try {
          sessionStorage.setItem(VERSION_KEY, JSON.stringify(data));
        } catch { /* quota */ }
      }
      versionPromise = null;
      return data;
    })
    .catch(() => {
      versionPromise = null;
      return readStoredVersion();
    });
  return versionPromise;
}

function readStoredVersion() {
  try {
    const raw = sessionStorage.getItem(VERSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getCachedNoblAirDataVersion() {
  if (currentVersion) return currentVersion;
  const stored = readStoredVersion();
  if (stored?.version) currentVersion = stored.version;
  return currentVersion;
}

function cacheStorageKey(version, key) {
  return `${PREFIX}${version}:${key}`;
}

export function getAnalyticsCache(key) {
  const version = getCachedNoblAirDataVersion();
  if (!version) return null;
  try {
    const raw = sessionStorage.getItem(cacheStorageKey(version, key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAnalyticsCache(key, data) {
  const version = getCachedNoblAirDataVersion();
  if (!version) return;
  try {
    sessionStorage.setItem(cacheStorageKey(version, key), JSON.stringify(data));
  } catch { /* quota */ }
}

function pruneOtherVersions(keepVersion) {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX) && k !== VERSION_KEY && !k.startsWith(`${PREFIX}${keepVersion}:`)) {
        keys.push(k);
      }
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
}

/**
 * Return cached data immediately if present; otherwise fetch, store, and return.
 */
export async function cachedAnalyticsFetch(cacheKey, fetchFn, { onFreshVersion } = {}) {
  const meta = await fetchNoblAirDataVersion();
  if (meta?.version && onFreshVersion) onFreshVersion(meta);

  const hit = getAnalyticsCache(cacheKey);
  if (hit != null) return { data: hit, fromCache: true };

  const data = await fetchFn();
  // Never cache error/empty responses (e.g. a transient DB-connection timeout) —
  // otherwise a one-off failure would stick for the whole session.
  const isError = !data || (typeof data === 'object' && 'error' in data);
  if (!isError) setAnalyticsCache(cacheKey, data);
  return { data, fromCache: false };
}
