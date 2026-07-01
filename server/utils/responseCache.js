const stores = new Map();
const refreshes = new Map();
const MAX_ENTRIES_PER_STORE = parseInt(process.env.RESPONSE_CACHE_MAX || '150', 10);
const TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10) * 1000;
const STORE_TTL_MS = {
  'kpi-pulse': parseInt(process.env.KPI_PULSE_CACHE_TTL_SECONDS || '1800', 10) * 1000,
};

function getStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

function pruneStore(store) {
  if (store.size <= MAX_ENTRIES_PER_STORE) return;
  const entries = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
  const drop = entries.slice(0, store.size - MAX_ENTRIES_PER_STORE);
  for (const [key] of drop) store.delete(key);
}

/**
 * In-memory response cache invalidated when dataVersion changes (e.g. after nightly ETL).
 */
async function withResponseCache(storeName, cacheKey, dataVersion, compute, options = {}) {
  const store = getStore(storeName);
  const entry = store.get(cacheKey);
  const fresh = entry
    && entry.dataVersion === dataVersion
    && Date.now() - entry.at < (STORE_TTL_MS[storeName] || TTL_MS);
  if (fresh) {
    return { body: entry.body, hit: true, store: storeName };
  }

  const refreshKey = `${storeName}:${cacheKey}`;
  const startRefresh = () => {
    if (refreshes.has(refreshKey)) return refreshes.get(refreshKey);
    const p = Promise.resolve()
      .then(compute)
      .then((body) => {
        store.set(cacheKey, { dataVersion, body, at: Date.now() });
        pruneStore(store);
        return body;
      })
      .catch((e) => {
        console.warn(`[responseCache:${storeName}] refresh failed for ${cacheKey}: ${e.message}`);
        throw e;
      })
      .finally(() => { refreshes.delete(refreshKey); });
    refreshes.set(refreshKey, p);
    return p;
  };

  if (options.staleWhileRevalidate && entry?.body) {
    startRefresh().catch(() => {});
    return { body: entry.body, hit: true, stale: true, refreshing: true, store: storeName };
  }

  const body = await startRefresh();
  return { body, hit: false, store: storeName };
}

function clearResponseCache(storeName) {
  if (storeName) {
    stores.delete(storeName);
    for (const key of refreshes.keys()) if (key.startsWith(`${storeName}:`)) refreshes.delete(key);
  } else {
    stores.clear();
    refreshes.clear();
  }
}

module.exports = { withResponseCache, clearResponseCache };
