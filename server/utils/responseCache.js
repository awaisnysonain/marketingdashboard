const stores = new Map();
const MAX_ENTRIES_PER_STORE = parseInt(process.env.RESPONSE_CACHE_MAX || '150', 10);
const TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10) * 1000;

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
async function withResponseCache(storeName, cacheKey, dataVersion, compute) {
  const store = getStore(storeName);
  const entry = store.get(cacheKey);
  const fresh = entry
    && entry.dataVersion === dataVersion
    && Date.now() - entry.at < TTL_MS;
  if (fresh) {
    return { body: entry.body, hit: true, store: storeName };
  }
  const body = await compute();
  store.set(cacheKey, { dataVersion, body, at: Date.now() });
  pruneStore(store);
  return { body, hit: false, store: storeName };
}

function clearResponseCache(storeName) {
  if (storeName) stores.delete(storeName);
  else stores.clear();
}

module.exports = { withResponseCache, clearResponseCache };
