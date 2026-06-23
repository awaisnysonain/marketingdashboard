/**
 * Static FX rates → USD for IAP proceeds conversion.
 *
 * Apple Sales reports give "Developer Proceeds" in each storefront's "Currency
 * of Proceeds" but, unlike Google's earnings reports, carry NO conversion rate —
 * so non-USD Apple proceeds need an external rate. These are APPROXIMATE static
 * rates (consistent with the rest of the codebase, which uses a static EUR rate
 * of 1.16). They convert the major storefront currencies so MIXED days aren't
 * undercounted; for exact figures use Apple Financial Reports (round 3).
 *
 * Google does NOT use this — it derives its merchant→USD rate from the report.
 */
const USD_RATES = {
  USD: 1, EUR: 1.16, GBP: 1.27, CAD: 0.73, AUD: 0.66, NZD: 0.61, CHF: 1.13,
  JPY: 0.0067, CNY: 0.14, HKD: 0.128, SGD: 0.74, KRW: 0.00073, INR: 0.012,
  SEK: 0.095, NOK: 0.094, DKK: 0.155, PLN: 0.25, CZK: 0.043, HUF: 0.0028,
  MXN: 0.058, BRL: 0.18, ZAR: 0.054, AED: 0.272, SAR: 0.267, TRY: 0.030,
  ILS: 0.27, THB: 0.028, MYR: 0.22, PHP: 0.018, IDR: 0.000062, TWD: 0.031,
  CLP: 0.0011, COP: 0.00025, RON: 0.23, VND: 0.00004,
};

/** Convert an amount to USD; returns null for unknown currencies (caller skips). */
function toUsd(amount, currency) {
  const r = USD_RATES[String(currency || '').toUpperCase()];
  return r == null ? null : amount * r;
}

module.exports = { USD_RATES, toUsd };
