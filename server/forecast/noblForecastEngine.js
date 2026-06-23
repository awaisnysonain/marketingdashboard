/**
 * NOBL store forecast engine — port of Apps Script calculateForecast_.
 * Plan calendar is imported separately; projected/forecast values are computed here.
 */
const { NOBL_PLAN_2026, NOBL_MER_TARGETS_2026 } = require('../config/forecastSheetConfig');

const NOBL = {
  YEAR: 2026,
  APPLY_PACING: false,
  EU_RATE: 0.0031,
  SUB_REV_RATE: 0.03,
  SUB_REV_INCLUDES_UK: false,
  P25_FULL_YEAR_FLOOR: 404000000,
  OCT_P10_FLOOR: 16000000,
  CVR_BASELINE: 0.0059,
  CVR_WARN: 0.0050,
  MER_TARGETS: NOBL_MER_TARGETS_2026,
  RANGE_WIDTH: {
    '2026-05': 0.06, '2026-06': 0.06, '2026-07': 0.08, '2026-08': 0.08,
    '2026-09': 0.10, '2026-10': 0.18, '2026-11': 0.16, '2026-12': 0.14,
  },
  MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  CLOSED_MONTHS: ['Jan', 'Feb', 'Mar', 'Apr'],
};

const DAY_WEIGHTS = { 0: 1.25, 1: 0.85, 2: 0.85, 3: 0.85, 4: 0.85, 5: 0.95, 6: 1.35 };
const MONTH_SEASONALITY = {
  '01': 0.78, '02': 0.82, '03': 0.90, '04': 0.90,
  '05': 1.08, '06': 1.15, '07': 1.35, '08': 1.32,
  '09': 1.02, '10': 0.82, '11': 2.15, '12': 2.05,
};

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  let mult = 1;
  if (/m/i.test(s)) mult = 1e6;
  if (/k/i.test(s)) mult = 1e3;
  s = s.replace(/[$,%\s,]/g, '').replace(/[mMkK]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : 0;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

function monthKey(dateStr) {
  return String(dateStr).slice(0, 7);
}

function monthName(dateStr) {
  const idx = Math.max(0, Math.min(11, Number(String(dateStr).slice(5, 7)) - 1));
  return NOBL.MONTHS[idx];
}

function monthLabel(key) {
  const idx = Math.max(0, Math.min(11, Number(key.slice(5, 7)) - 1));
  return `${NOBL.MONTHS[idx]} ${key.slice(0, 4)}`;
}

function dayWeight(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return DAY_WEIGHTS[d] || 0.85;
}

function inferSaleStrength(promo) {
  const s = String(promo || '').toLowerCase();
  if (s.includes('67') || s.includes('black friday') || s.includes('cyber') || s.includes('nobl day')) return 'Strong';
  if (s.includes('55') || s.includes('58') || s.includes('holiday') || s.includes('father') || s.includes('summer')) return 'Medium';
  if (s.includes('bundle') || s.includes('pack') || s.includes('vacation') || s.includes('46') || s.includes('48')) return 'Weak';
  return 'Gap/Evergreen';
}

function isAnomaly(actual, planRow) {
  const note = String(actual.note || '').toLowerCase();
  if (note.includes('outage') || note.includes('anomaly') || note.includes('processor')) return true;
  if (!planRow.planRevenue || !actual.revenue) return false;
  const ratio = actual.revenue / planRow.planRevenue;
  return ratio < 0.45 || ratio > 1.85;
}

function monthFactor(items) {
  const valid = items
    .filter(x => !x.anomaly && x.ratio > 0.4 && x.ratio < 1.8)
    .slice(-5);
  if (valid.length < 3) return 1;
  const avg = sum(valid.map(x => x.ratio)) / valid.length;
  return clamp(avg, 0.75, 1.25);
}

function statusVariance(variance) {
  const a = Math.abs(variance || 0);
  if (a <= 0.05) return 'Green';
  if (a <= 0.15) return 'Amber';
  return 'Red';
}

function allocateRegions(planRow, actual, revenue, isActual) {
  if (isActual && actual) {
    const hasRegions = actual.usa || actual.canada || actual.australia || actual.uk || actual.eu;
    if (hasRegions) {
      const eu = actual.eu || Math.round(revenue * NOBL.EU_RATE);
      const canada = actual.canada || 0;
      const australia = actual.australia || 0;
      const uk = actual.uk || 0;
      const usa = actual.usa || Math.max(0, revenue - canada - australia - uk - eu);
      return { usa, canada, australia, uk, eu };
    }
  }
  const eu = Math.round(revenue * NOBL.EU_RATE);
  const planRev = planRow.planRevenue || 1;
  const canada = Math.round(revenue * ((planRow.planCanada || 0) / planRev));
  const australia = Math.round(revenue * ((planRow.planAustralia || 0) / planRev));
  const uk = Math.round(revenue * ((planRow.planUK || 0) / planRev));
  const usa = Math.max(0, revenue - canada - australia - uk - eu);
  return { usa, canada, australia, uk, eu };
}

/** Build daily plan rows from monthly totals when calendar tabs are unavailable. */
function buildPlanDailyFromMonthly(monthlyPlan = NOBL_PLAN_2026, merTargets = NOBL.MER_TARGETS) {
  const rows = [];
  Object.entries(monthlyPlan).forEach(([monthKey, planRevenue]) => {
    const start = `${monthKey}-01`;
    const endDate = new Date(`${monthKey}-01T00:00:00Z`);
    const endMonth = endDate.getUTCMonth();
    const days = [];
    for (let d = new Date(`${start}T00:00:00Z`); d.getUTCMonth() === endMonth; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const weights = days.map(date => {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const season = MONTH_SEASONALITY[date.slice(5, 7)] || 1;
      return (DAY_WEIGHTS[dow] || 1) * season;
    });
    const wSum = weights.reduce((a, b) => a + b, 0) || days.length;
    const targetMer = merTargets[monthKey] || 3;
    const planSpend = targetMer > 0 ? planRevenue / targetMer : 0;
    days.forEach((date, i) => {
      const dayRev = Math.round(planRevenue * (weights[i] / wSum));
      rows.push({
        date,
        key: date,
        month: monthName(date),
        month_key: monthKey,
        promo: '',
        planRevenue: dayRev,
        planSpend: Math.round(planSpend * (weights[i] / wSum)),
        planMetaSpend: 0,
        planMER: targetMer,
        planCanada: 0,
        planAustralia: 0,
        planUK: 0,
        planEU: Math.round(dayRev * NOBL.EU_RATE),
        dropLift: 0,
      });
    });
  });
  return rows;
}

/** Merge DB plan rows over generated monthly weights (DB wins when present). */
function mergePlanRows(dbPlanByDate, generatedRows) {
  const out = [];
  const seen = new Set();
  generatedRows.forEach(p => {
    const db = dbPlanByDate[p.date];
    if (db) {
      out.push({
        ...p,
        planRevenue: num(db.plan_revenue ?? db.planRevenue) || p.planRevenue,
        planSpend: num(db.plan_spend ?? db.planSpend) || p.planSpend,
        planMetaSpend: num(db.plan_meta_spend ?? db.planMetaSpend) || p.planMetaSpend,
        planMER: num(db.plan_mer ?? db.planMER) || p.planMER,
        promo: db.promo || p.promo,
        source: db.source || 'plan_calendar',
      });
    } else {
      out.push({ ...p, source: 'monthly_weights' });
    }
    seen.add(p.date);
  });
  Object.entries(dbPlanByDate).forEach(([date, db]) => {
    if (seen.has(date)) return;
    out.push({
      date,
      key: date,
      month: monthName(date),
      month_key: monthKey(date),
      promo: db.promo || '',
      planRevenue: num(db.plan_revenue ?? db.planRevenue),
      planSpend: num(db.plan_spend ?? db.planSpend),
      planMetaSpend: num(db.plan_meta_spend ?? db.planMetaSpend),
      planMER: num(db.plan_mer ?? db.planMER),
      planCanada: num(db.plan_canada),
      planAustralia: num(db.plan_australia),
      planUK: num(db.plan_uk),
      planEU: num(db.plan_eu),
      dropLift: num(db.drop_lift),
      source: db.source || 'plan_calendar',
    });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeActual(row) {
  if (!row) return null;
  const revenue = num(row.revenue ?? row.order_revenue ?? row.total_revenue);
  const spend = num(row.spend ?? row.total_spend);
  if (!revenue && !spend) return null;
  return {
    date: row.date,
    revenue,
    spend,
    metaSpend: num(row.meta_spend ?? row.metaSpend),
    mer: spend ? revenue / spend : 0,
    usa: num(row.usa),
    canada: num(row.canada),
    australia: num(row.australia),
    uk: num(row.uk),
    eu: num(row.eu),
    cvr: num(row.cvr),
    roas: num(row.roas),
    note: String(row.note || ''),
    orders: num(row.orders),
  };
}

/**
 * Core forecast calculation — mirrors Apps Script calculateForecast_.
 * @param {{ rows: object[], monthlyBase?: object }} plan
 * @param {Record<string, object>} actualsByDate
 * @param {string} asOf YYYY-MM-DD
 */
function calculateNoblForecast(plan, actualsByDate, asOf) {
  const rows = plan.rows || [];
  const monthlyBase = plan.monthlyBase || {};
  const ratiosByMonth = {};
  const spendRatiosByMonth = {};

  rows.forEach(p => {
    const a = normalizeActual(actualsByDate[p.key || p.date]);
    if (a && a.revenue && p.planRevenue && p.date <= asOf) {
      if (!ratiosByMonth[p.month]) ratiosByMonth[p.month] = [];
      ratiosByMonth[p.month].push({ date: p.date, ratio: a.revenue / p.planRevenue, anomaly: isAnomaly(a, p) });
    }
    if (a && a.spend && p.planSpend && p.date <= asOf) {
      if (!spendRatiosByMonth[p.month]) spendRatiosByMonth[p.month] = [];
      spendRatiosByMonth[p.month].push({ date: p.date, ratio: a.spend / p.planSpend, anomaly: isAnomaly(a, p) });
    }
  });

  const revFactors = {};
  const spendFactors = {};
  NOBL.MONTHS.forEach(m => {
    revFactors[m] = monthFactor(ratiosByMonth[m] || []);
    spendFactors[m] = monthFactor(spendRatiosByMonth[m] || []);
  });

  const audit = [];
  const projectedRows = rows.map(p => {
    const actual = normalizeActual(actualsByDate[p.key || p.date]);
    const hasActual = !!(actual && actual.revenue && p.date <= asOf);
    const isMissingActual = !hasActual && p.date <= asOf;
    const rowType = hasActual ? 'Actual' : (isMissingActual ? 'Missing Actual' : 'Projected');
    const isActual = hasActual;

    let projectedRevFactor = NOBL.APPLY_PACING ? revFactors[p.month] : 1;
    let projectedSpendFactor = NOBL.APPLY_PACING ? spendFactors[p.month] : 1;
    let revFactor = isActual ? 1 : projectedRevFactor;
    let spendFactor = isActual ? 1 : projectedSpendFactor;

    let bfcAnchor = false;
    if (
      p.month === 'Nov' &&
      p.date >= `${NOBL.YEAR}-11-22` &&
      asOf < `${NOBL.YEAR}-11-22` &&
      !isActual
    ) {
      projectedRevFactor = 1;
      revFactor = 1;
      bfcAnchor = true;
    }

    const projectedRevenue = Math.round(p.planRevenue * projectedRevFactor);
    const projectedSpend = Math.round(p.planSpend * projectedSpendFactor);
    const projectedMer = projectedSpend ? projectedRevenue / projectedSpend : 0;

    const revenue = isActual ? actual.revenue : projectedRevenue;
    const spend = isActual ? (actual.spend || p.planSpend) : projectedSpend;
    const metaSpend = isActual ? (actual.metaSpend || p.planMetaSpend) : Math.round(p.planMetaSpend * spendFactor);
    const regions = allocateRegions(p, actual, revenue, isActual);
    const mer = spend ? revenue / spend : 0;
    const dowWeight = dayWeight(p.date);
    const saleStrength = inferSaleStrength(p.promo);

    const projectionReason =
      (NOBL.APPLY_PACING
        ? `Projected from calendar plan × pacing factor ${revFactor.toFixed(3)}`
        : 'Projected from source NOBL forecast plan') +
      `; day-weight ${dowWeight}; sale=${saleStrength}` +
      (p.dropLift ? '; drop lift embedded' : '') +
      (bfcAnchor ? '; BFCM anchored to plan per redline' : '');

    const reason = isActual
      ? 'Actual from Triple Whale daily summary'
      : (isMissingActual
        ? `Missing completed-day actual. Using forecast value until ETL backfill. ${projectionReason}`
        : projectionReason);

    const out = {
      date: p.date,
      key: p.key || p.date,
      month: p.month,
      month_key: p.month_key || monthKey(p.date),
      promo: p.promo,
      rowType,
      isMissingActual,
      isActual,
      revenue,
      projectedRevenue,
      planRevenue: p.planRevenue,
      storeRevenueDiff: isActual ? Math.round(revenue - projectedRevenue) : null,
      spend,
      projectedSpend,
      metaSpend,
      mer,
      projectedMer,
      usa: regions.usa,
      canada: regions.canada,
      australia: regions.australia,
      uk: regions.uk,
      eu: regions.eu,
      planSpend: p.planSpend,
      planMER: p.planMER,
      revFactor,
      spendFactor,
      saleStrength,
      dowWeight,
      reason,
      cvr: actual ? actual.cvr : 0,
      roas: actual ? actual.roas : 0,
      plan_source: p.source,
    };
    audit.push(out);
    return out;
  });

  const monthly = buildMonthlySummary(projectedRows, monthlyBase);
  const fullYear = buildFullYear(monthly);
  const currentMonth = monthName(asOf);
  const flags = buildFlags(monthly, fullYear, projectedRows, asOf);

  return {
    asOf,
    currentMonth,
    audit,
    monthly,
    fullYear,
    flags,
  };
}

function buildMonthlySummary(rows, monthlyBase) {
  const monthly = {};
  NOBL.MONTHS.forEach(m => {
    monthly[m] = {
      month: m,
      revenue: 0,
      spend: 0,
      planRevenue: 0,
      planSpend: 0,
      actualRevenue: 0,
      projectedRevenue: 0,
      actualDays: 0,
      projectedDays: 0,
    };
  });

  rows.forEach(r => {
    const m = monthly[r.month];
    if (!m) return;
    m.revenue += r.revenue;
    m.spend += r.spend;
    m.planRevenue += r.planRevenue;
    m.planSpend += r.planSpend;
    if (r.isActual) {
      m.actualRevenue += r.revenue;
      m.actualDays++;
    } else {
      m.projectedRevenue += r.revenue;
      m.projectedDays++;
    }
  });

  Object.entries(monthlyBase).forEach(([m, base]) => {
    if (!monthly[m]) return;
    if (!monthly[m].planRevenue) monthly[m].planRevenue = num(base.planRevenue);
    if (!monthly[m].planSpend) monthly[m].planSpend = num(base.planSpend);
    if (NOBL.CLOSED_MONTHS.includes(m)) {
      monthly[m].revenue = monthly[m].planRevenue || num(base.planRevenue);
      monthly[m].spend = monthly[m].planSpend || num(base.planSpend);
      monthly[m].actualRevenue = monthly[m].revenue;
      monthly[m].actualDays = 1;
    }
  });

  Object.values(monthly).forEach(m => {
    const monthKeyStr = `${NOBL.YEAR}-${String(NOBL.MONTHS.indexOf(m.month) + 1).padStart(2, '0')}`;
    m.mer = m.spend ? m.revenue / m.spend : 0;
    m.merTarget = NOBL.MER_TARGETS[monthKeyStr] || 0;
    m.variance = m.planRevenue ? (m.revenue - m.planRevenue) / m.planRevenue : 0;
    m.status = statusVariance(m.variance);
    const width = NOBL.RANGE_WIDTH[monthKeyStr] || 0.08;
    m.p25 = Math.round(m.revenue * (1 - width));
    m.p75 = Math.round(m.revenue * (1 + width));
    m.month_key = monthKeyStr;
    m.month_label = monthLabel(monthKeyStr);
  });

  return monthly;
}

function buildFullYear(monthly) {
  const months = Object.values(monthly);
  const revenue = sum(months.map(m => m.revenue));
  const spend = sum(months.map(m => m.spend));
  const planRevenue = sum(months.map(m => m.planRevenue));
  const planSpend = sum(months.map(m => m.planSpend));
  return {
    revenue,
    spend,
    planRevenue,
    planSpend,
    mer: spend ? revenue / spend : 0,
    variance: planRevenue ? (revenue - planRevenue) / planRevenue : 0,
    status: statusVariance(planRevenue ? (revenue - planRevenue) / planRevenue : 0),
    p25: Math.round(revenue * 0.92),
    p75: Math.round(revenue * 1.08),
  };
}

function buildFlags(monthly, fullYear, rows, asOf) {
  const flags = [];
  if (fullYear.revenue < NOBL.P25_FULL_YEAR_FLOOR) {
    flags.push('HUMAN REVIEW REQUIRED: full-year projection below $404M P25 floor.');
  }
  if (monthly.Oct && monthly.Oct.revenue < NOBL.OCT_P10_FLOOR) {
    flags.push('October is below $16M P10 floor; downside scenario should be surfaced.');
  }
  const actualRows = rows
    .filter(r => r.isActual && r.date <= asOf && r.cvr)
    .sort((a, b) => b.date.localeCompare(a.date));
  let lowCvrStreak = 0;
  for (const r of actualRows) {
    if (r.cvr < NOBL.CVR_WARN) lowCvrStreak++;
    else break;
  }
  if (lowCvrStreak >= 3) {
    flags.push(`Meta CVR below 0.50% for ${lowCvrStreak} consecutive days; baseline is 0.59%.`);
  }
  return flags;
}

/** Map engine audit rows to API daily forecast format. */
function auditToDailyApiRows(audit, merTargets = NOBL.MER_TARGETS) {
  return audit.map(r => {
    const targetMer = merTargets[r.month_key] || r.planMER || 3;
    const actual = r.isActual ? {
      revenue: r.revenue,
      spend: r.spend,
      orders: null,
      mer: r.mer,
    } : null;
    return {
      date: r.date,
      month: monthLabel(r.month_key),
      month_key: r.month_key,
      row_type: r.rowType,
      actual_revenue: actual ? actual.revenue : null,
      actual_spend: actual ? actual.spend : null,
      actual_orders: null,
      actual_mer: actual ? actual.mer : null,
      plan_revenue: r.planRevenue,
      projected_revenue: r.projectedRevenue,
      forecast_revenue: r.projectedRevenue,
      // The forecast is the PLAN on past AND future days — never the actual echoed
      // back at itself. Echoing actual spend (the old behaviour) made every past-day
      // spend/MER variance read as a meaningless 0%, hiding real over/under-spend vs
      // plan. projectedSpend/projectedMer are the plan-derived values (plan_spend and
      // plan_revenue/plan_spend) and exist for every row.
      forecast_spend: r.projectedSpend,
      forecast_mer: r.projectedMer,
      plan_revenue_month: null,
      projected_revenue_month: null,
      mer_target: targetMer,
      day_weight: r.dowWeight,
      sale_name: r.saleStrength,
      drop_type: null,
      target_status: r.rowType === 'Projected' ? 'Future' : (r.isMissingActual ? 'Missing Actual' : null),
      forecast_source: 'engine',
      reason: r.reason,
      rev_factor: r.revFactor,
      plan_source: r.plan_source,
    };
  });
}

function buildMonthlyBaseFromPlan() {
  const out = {};
  Object.entries(NOBL_PLAN_2026).forEach(([key, planRevenue]) => {
    const mer = NOBL.MER_TARGETS[key] || 3;
    out[monthName(`${key}-01`)] = {
      month: monthName(`${key}-01`),
      planRevenue,
      planSpend: mer > 0 ? planRevenue / mer : 0,
      planMER: mer,
    };
  });
  return out;
}

function computeNoblStoreDailyForecast(actualsByDate, asOf, planByDate = {}) {
  const generated = buildPlanDailyFromMonthly();
  const planRows = mergePlanRows(planByDate, generated);
  const result = calculateNoblForecast(
    { rows: planRows, monthlyBase: buildMonthlyBaseFromPlan() },
    actualsByDate,
    asOf
  );
  return {
    ...result,
    daily: auditToDailyApiRows(result.audit),
  };
}

module.exports = {
  NOBL,
  buildPlanDailyFromMonthly,
  mergePlanRows,
  calculateNoblForecast,
  computeNoblStoreDailyForecast,
  auditToDailyApiRows,
  buildMonthlyBaseFromPlan,
};
