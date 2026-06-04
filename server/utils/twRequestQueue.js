/**
 * Serializes Triple Whale SQL API calls so cron + dashboard never hammer TW in parallel.
 * One in-flight request at a time with a minimum gap between calls.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MIN_GAP_MS = parseInt(process.env.TW_SQL_GAP_MS || '1500', 10);
let chain = Promise.resolve();
let lastCallAt = 0;

function enqueueTw(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

module.exports = { enqueueTw };
