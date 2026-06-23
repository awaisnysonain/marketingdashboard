/**
 * NOBL Air forecast engine — port of Apps Script buildNoblAirDaily_ / buildAirAssumptions_.
 * Store revenue forecast comes from the NOBL store engine; Air metrics are computed.
 */

const DEFAULTS = {
  AOV_ELIGIBLE: 250,
  ATTACH_RATE: 0.10,
  ACTIVATION_RATE: 0.08,
  TAG_REV_PER_AIR: 0,
  SUB_REV_PER_ACTIVATION: 99,
};

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function pctOrNum(v) {
  const n = num(v);
  return n > 1 ? n / 100 : n;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function hasAirActualSignal(a) {
  if (!a) return false;
  if ((a.total_orders || 0) > 0) return true;
  if ((a.eligible_orders || 0) > 0) return true;
  if ((a.air_orders || 0) > 0) return true;
  if ((a.tag_net_sales || 0) !== 0) return true;
  if ((a.mature_count || 0) > 0) return true;
  if ((a.converted_count || 0) > 0) return true;
  if (a.billing_revenue_exact) return true;
  if (a.combined_net_revenue != null && a.combined_net_revenue !== '') return true;
  return false;
}

function sumRows(rows, key) {
  return rows.reduce((s, r) => s + num(r[key]), 0);
}

/** Rolling assumptions from recent cohort actuals — mirrors buildAirAssumptions_. */
function buildAirAssumptions(actualMap, propOverrides = {}) {
  const vals = Object.keys(actualMap).sort().map(k => actualMap[k]).filter(hasAirActualSignal);
  let recent = vals.slice(-7);
  if (recent.length < 3) recent = vals.slice(-28);

  const normalizedRecent = recent.map(r => {
    const copy = { ...r };
    if ((!copy.eligible_orders || copy.eligible_orders <= 0) && copy.air_orders > 0 && copy.attach_rate > 0) {
      copy.eligible_orders = Math.round(copy.air_orders / pctOrNum(copy.attach_rate));
    }
    if ((!copy.eligible_orders || copy.eligible_orders <= 0) && copy.total_orders > 0) {
      copy.eligible_orders = copy.total_orders;
    }
    return copy;
  });

  const eligible = sumRows(normalizedRecent, 'eligible_orders') || sumRows(normalizedRecent, 'total_orders');
  const air = sumRows(recent, 'air_orders');
  const store = sumRows(recent, 'store_revenue');
  let converted = 0;
  let activationWeighted = 0;
  let activationWeight = 0;

  normalizedRecent.forEach(r => {
    const e = r.eligible_orders || r.total_orders || 0;
    const ar = r.air_orders || 0;
    const act = pctOrNum(r.activation_rate) || (pctOrNum(r.attach_rate) * pctOrNum(r.ttp_rate));
    converted += Math.round(act * e);
    if (act > 0 && e > 0) {
      activationWeighted += act * e;
      activationWeight += e;
    } else if (pctOrNum(r.ttp_rate) > 0 && ar > 0) {
      activationWeighted += pctOrNum(r.ttp_rate) * ar;
      activationWeight += ar;
    }
  });

  const tag = sumRows(recent, 'tag_net_sales');
  const sub = sumRows(recent, 'sub_net_sales');

  const calcAov = eligible > 0 ? store / eligible : 0;
  const aov = calcAov > 0 ? calcAov : num(propOverrides.AOV_ELIGIBLE ?? DEFAULTS.AOV_ELIGIBLE);
  const attach = eligible > 0 ? air / eligible : num(propOverrides.ATTACH_RATE ?? DEFAULTS.ATTACH_RATE);
  const activation = activationWeight > 0
    ? activationWeighted / activationWeight
    : num(propOverrides.ACTIVATION_RATE ?? DEFAULTS.ACTIVATION_RATE);
  const tagPerAir = air > 0 ? tag / air : num(propOverrides.TAG_REV_PER_AIR ?? DEFAULTS.TAG_REV_PER_AIR);
  const subPerActivation = converted > 0 && sub > 0
    ? sub / converted
    : num(propOverrides.SUB_REV_PER_ACTIVATION ?? DEFAULTS.SUB_REV_PER_ACTIVATION);

  return {
    aovEligible: aov,
    attachRate: attach,
    activationRate: activation,
    tagPerAir: tagPerAir,
    subPerActivation: subPerActivation,
    avg_revenue_per_store_order: aov,
    overall_attach_rate: attach,
    forecast_activation_rate: activation,
    tag_net_sales_per_air_order: tagPerAir,
    avg_tier_price_converted_subs: subPerActivation,
    source: vals.length ? 'Recent cohort actuals' : 'Default assumptions until cohort actuals are available',
  };
}

function dailyTargetStatus(rowType, actualAirRev, forecastAirRev) {
  if (rowType === 'Projected') return 'Future';
  if (rowType === 'Missing Actual') return 'Missing Actual';
  if (rowType === 'Partial Actual') return 'Check Shopify Orders';
  if (actualAirRev == null || actualAirRev === '') return 'Pending Exact Billing';
  if (!forecastAirRev || forecastAirRev <= 0) return 'No Target';
  return Number(actualAirRev) >= Number(forecastAirRev) ? 'Target Met' : 'Below Target';
}

function directionalStatus(variancePct) {
  if (variancePct == null) return 'model';
  if (variancePct >= -0.05) return 'green';
  if (variancePct >= -0.15) return 'amber';
  return 'red';
}

/**
 * Build NOBL Air daily rows from store forecast + Air actuals.
 * @param {object[]} storeDailyRows output from NOBL store engine
 * @param {Record<string, object>} airActualByDate
 * @param {object} [assumptions] optional pre-built assumptions
 */
function buildNoblAirDailyForecast(storeDailyRows, airActualByDate, assumptions = null) {
  const a = assumptions || buildAirAssumptions(airActualByDate);

  return storeDailyRows.map(store => {
    const actual = airActualByDate[store.date];
    const hasShopifyOrderActual = !!(actual && (
      num(actual.total_orders) > 0 ||
      num(actual.eligible_orders) > 0 ||
      num(actual.air_orders) > 0 ||
      num(actual.tag_net_sales) !== 0
    ));
    const hasAnyActual = !!(actual && (
      num(actual.sub_net_sales) !== 0 ||
      num(actual.rebill_revenue) !== 0 ||
      num(actual.combined_net_revenue) !== 0 ||
      num(actual.mature_count) > 0 ||
      num(actual.converted_count) > 0 ||
      hasShopifyOrderActual
    ));
    const rowType = hasShopifyOrderActual
      ? 'Actual'
      : (hasAnyActual ? 'Partial Actual' : (store.row_type === 'Projected' ? 'Projected' : 'Missing Actual'));

    const forecastStoreRevenue = num(store.forecast_revenue ?? store.projected_revenue);
    const forecastEligibleOrders = a.aovEligible > 0 ? forecastStoreRevenue / a.aovEligible : 0;
    const forecastAirOrders = forecastEligibleOrders * a.attachRate;
    const forecastActivations = forecastEligibleOrders * a.activationRate;
    const forecastTagRevenue = forecastAirOrders * a.tagPerAir;
    const forecastSubRevenue = forecastActivations * a.subPerActivation;
    const forecastAirRevenue = forecastTagRevenue + forecastSubRevenue;

    const hasExactBilling = actual && (
      actual.billing_revenue_exact ||
      (actual.combined_net_revenue != null && actual.combined_net_revenue !== '')
    );
    const actualAirRev = hasShopifyOrderActual && hasExactBilling
      ? num(actual.combined_net_revenue)
      : (hasShopifyOrderActual ? num(actual.combined_net_revenue) : null);
    const airVariance = actualAirRev != null && forecastAirRevenue > 0
      ? (actualAirRev - forecastAirRevenue) / forecastAirRevenue
      : null;

    return {
      date: store.date,
      month: store.month,
      month_key: store.month_key,
      row_type: rowType,
      actual_store_revenue: store.actual_revenue,
      actual_eligible_orders: hasShopifyOrderActual ? Math.round(num(actual.eligible_orders || actual.total_orders)) : null,
      actual_air_orders: hasShopifyOrderActual ? Math.round(num(actual.air_orders)) : null,
      actual_attach_rate: hasShopifyOrderActual ? pctOrNum(actual.attach_rate) : null,
      actual_ttp_rate: hasShopifyOrderActual ? pctOrNum(actual.ttp_rate) : null,
      actual_activation_rate: hasShopifyOrderActual ? pctOrNum(actual.activation_rate) : null,
      actual_tag_rev_net: hasShopifyOrderActual ? num(actual.tag_net_sales) : null,
      actual_sub_rev_net: hasShopifyOrderActual ? num(actual.sub_net_sales) : null,
      actual_rebill_rev_net: hasShopifyOrderActual ? num(actual.rebill_revenue) : null,
      actual_air_rev_net: actualAirRev,
      mature_count: hasAnyActual ? Math.round(num(actual.mature_count)) : null,
      converted_count: hasAnyActual ? Math.round(num(actual.converted_count)) : null,
      forecast_store_revenue: round2(forecastStoreRevenue),
      forecast_eligible_orders: Math.round(forecastEligibleOrders),
      forecast_air_orders: Math.round(forecastAirOrders),
      forecast_activations: Math.round(forecastActivations),
      forecast_attach_rate: a.attachRate,
      forecast_activation_rate: a.activationRate,
      forecast_tag_rev_net: round2(forecastTagRevenue),
      forecast_sub_rev_net: round2(forecastSubRevenue),
      forecast_total_air_rev_net: round2(forecastAirRevenue),
      forecast_air_revenue: round2(forecastAirRevenue),
      variance_pct: airVariance,
      status: directionalStatus(airVariance),
      target_status: dailyTargetStatus(rowType, actualAirRev, forecastAirRevenue),
      forecast_note: a.source,
      forecast_source: 'engine',
    };
  });
}

module.exports = {
  DEFAULTS,
  buildAirAssumptions,
  buildNoblAirDailyForecast,
  hasAirActualSignal,
};
