require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { twSqlQuery } = require('../etl/twSqlApi');
const d = '2026-06-14';

async function tryF(f) {
  try {
    const r = await twSqlQuery('NOBL', `
      SELECT COALESCE(SUM(ot.${f}),0) v FROM orders_table ot
      WHERE ot.platform='amazon' AND ot.amazon_fulfillment_status!='Canceled'
        AND ot.event_date=DATE '${d}'`, { period: { startDate: d, endDate: d } });
    console.log(f, r[0].v);
  } catch (e) { console.log(f, 'FAIL'); }
}

async function main() {
  for (const f of [
    'amazon_fees','referral_fee','fba_fees','platform_fee','marketplace_fee',
    'total_fees','fees','commission','amazon_referral_fee','shipping_costs',
  ]) await tryF(f);
}

main().catch(console.error);
