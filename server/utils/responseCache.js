const stores = new Map();

function getStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
}

/**
 * In-memory response cache invalidated when dataVersion changes (e.g. after nightly ETL).
 */
async function withResponseCache(storeName, cacheKey, dataVersion, compute) {
  const store = getStore(storeName);
  const entry = store.get(cacheKey);
  if (entry && entry.dataVersion === dataVersion) {
    return { body: entry.body, hit: true, store: storeName };
  }
  const body = await compute();
  store.set(cacheKey, { dataVersion, body, at: Date.now() });
  return { body, hit: false, store: storeName };
}

function clearResponseCache(storeName) {
  if (storeName) stores.delete(storeName);
  else stores.clear();
}

module.exports = { withResponseCache, clearResponseCache };
