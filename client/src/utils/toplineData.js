/** Client-side row enrichment — mirrors server twRowEnrich for display fallbacks. */

export function mer(rev, spend) {
  const r = Number(rev) || 0;
  const s = Number(spend) || 0;
  return s > 0 ? r / s : 0;
}

function channelCac(channel, spend, newCust, purchases) {
  const sp = Number(spend) || 0;
  if (sp <= 0) return null;
  if (channel === 'AMAZON') {
    const denom = Number(purchases) || Number(newCust) || 0;
    return denom > 0 ? sp / denom : null;
  }
  const nc = Number(newCust) || 0;
  return nc > 0 ? sp / nc : null;
}

const EMPTY_CHANNEL = {
  spend_1d: 0,
  revenue_1d: 0,
  purchases_1d: 0,
  new_cust_orders: 0,
  roas_1d: null,
  cac: null,
};

export function enrichSummaryRow(row) {
  if (!row) return row;
  const rev = Number(row.order_revenue || row.total_revenue) || 0;
  const spend = Number(row.total_spend) || 0;
  return {
    ...row,
    order_revenue: rev,
    shopify_revenue: Number(row.shopify_revenue) || 0,
    amazon_revenue: Number(row.amazon_revenue) || 0,
    refund_amount: Number(row.refund_amount) || 0,
    mer: spend > 0 ? mer(rev, spend) : null,
  };
}

export function enrichChannelRow(row, channel) {
  if (!row) return { ...EMPTY_CHANNEL };
  const spend = Number(row.spend_1d) || 0;
  const rev = Number(row.revenue_1d) || 0;
  const purch = Number(row.purchases_1d) || 0;
  const nc = Number(row.new_cust_orders) || 0;
  const ch = channel || row.channel;
  return {
    ...row,
    spend_1d: spend,
    revenue_1d: rev,
    purchases_1d: purch,
    new_cust_orders: nc,
    roas_1d: spend > 0 ? mer(rev, spend) : null,
    cac: channelCac(ch, spend, nc, purch),
  };
}

const EMPTY_GEO = { revenue_actual: 0, spend_actual: 0, mer: null };

export function enrichGeoRow(row) {
  if (!row) return { ...EMPTY_GEO };
  const rev = Number(row.revenue_actual || row.revenue) || 0;
  const spend = Number(row.spend_actual || row.spend) || 0;
  return {
    ...row,
    revenue_actual: rev,
    spend_actual: spend,
    mer: spend > 0 ? mer(rev, spend) : null,
  };
}

export function enrichSubsRow(row) {
  if (!row) return row;
  return {
    ...row,
    sub_revenue_actual: Number(row.sub_revenue_actual) || 0,
    rebill_revenue: Number(row.rebill_revenue) || 0,
    new_sub_revenue: Number(row.new_sub_revenue) || 0,
    shopify_sub_gross: Number(row.shopify_sub_gross) || 0,
    shopify_sub_refunds: Number(row.shopify_sub_refunds) || 0,
  };
}

const EMPTY_PRODUCT = {
  spend: 0,
  revenue: 0,
  new_cust_orders: 0,
  meta_spend: 0,
  google_spend: 0,
  tiktok_spend: 0,
  applovin_spend: 0,
};

export function enrichProductRow(row) {
  if (!row) return { ...EMPTY_PRODUCT };
  return {
    ...row,
    spend: Number(row.spend) || 0,
    revenue: Number(row.revenue) || 0,
    new_cust_orders: Number(row.new_cust_orders) || 0,
    meta_spend: Number(row.meta_spend) || 0,
    google_spend: Number(row.google_spend) || 0,
    tiktok_spend: Number(row.tiktok_spend) || 0,
    applovin_spend: Number(row.applovin_spend) || 0,
  };
}

/** Merge date lists from all topline sections so tables cover the full period. */
export function mergeToplineDates(...sections) {
  const set = new Set();
  for (const rows of sections) {
    for (const r of rows || []) {
      if (r?.date) set.add(r.date);
    }
  }
  return [...set].sort();
}
