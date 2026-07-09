/**
 * Normalize TW summary / channel / geo rows for dashboard APIs.
 * Always recalculate MER and ROAS from revenue ÷ spend (stored columns can be stale).
 */
const { calcMer } = require('../config/brandConfig');

/** CAC denominator — Amazon Ads has no new-customer split; use conversions (purchases). */
function channelCac(channel, spend, newCust, purchases) {
  const sp = Number(spend || 0);
  if (sp <= 0) return null;
  if (channel === 'AMAZON') {
    const denom = Number(purchases || 0) || Number(newCust || 0);
    return denom > 0 ? parseFloat((sp / denom).toFixed(4)) : null;
  }
  const nc = Number(newCust || 0);
  return nc > 0 ? parseFloat((sp / nc).toFixed(4)) : null;
}

function enrichSummaryRow(r) {
  if (!r) return r;
  const rev = parseFloat(r.order_revenue || r.total_revenue || 0);
  const spend = parseFloat(r.total_spend || 0);
  return {
    ...r,
    order_revenue: rev,
    total_spend: spend,
    shopify_revenue: parseFloat(r.shopify_revenue || 0),
    amazon_revenue: parseFloat(r.amazon_revenue || 0),
    refund_amount: parseFloat(r.refund_amount ?? 0),
    total_orders: r.total_orders == null ? null : parseInt(r.total_orders || 0, 10),
    new_customer_orders: r.new_customer_orders == null ? null : parseInt(r.new_customer_orders || 0, 10),
    returning_customer_orders: r.returning_customer_orders == null ? null : parseInt(r.returning_customer_orders || 0, 10),
    mer: calcMer(rev, spend),
  };
}

function enrichChannelRow(r) {
  if (!r) return r;
  const spend = parseFloat(r.spend_1d || 0);
  const rev = parseFloat(r.revenue_1d || 0);
  const purch = parseInt(r.purchases_1d || 0, 10);
  const nc = parseInt(r.new_cust_orders || 0, 10);
  return {
    ...r,
    spend_1d: spend,
    revenue_1d: rev,
    purchases_1d: purch,
    new_cust_orders: nc,
    roas_1d: spend > 0 ? calcMer(rev, spend) : null,
    cac: channelCac(r.channel, spend, nc, purch),
  };
}

function enrichGeoRow(r) {
  if (!r) return r;
  const rev = parseFloat(r.revenue_actual || r.revenue || 0);
  const spend = parseFloat(r.spend_actual || r.spend || 0);
  return {
    ...r,
    revenue_actual: rev,
    spend_actual: spend,
    mer: calcMer(rev, spend),
  };
}

function enrichSummaryRows(rows) {
  return (rows || []).map(enrichSummaryRow);
}

function enrichChannelRows(rows) {
  return (rows || []).map(enrichChannelRow);
}

function enrichGeoRows(rows) {
  return (rows || []).map(enrichGeoRow);
}

module.exports = {
  channelCac,
  enrichSummaryRow,
  enrichChannelRow,
  enrichGeoRow,
  enrichSummaryRows,
  enrichChannelRows,
  enrichGeoRows,
};
