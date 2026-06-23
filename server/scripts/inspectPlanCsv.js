require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const id = process.env.NOBL_FORECAST_SOURCE_SPREADSHEET_ID;
  const gid = process.env.FORECAST_PLAN_MAY_GID;
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  const text = await (await fetch(url)).text();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const c = parseCsvLine(lines[i]);
    console.log(`line ${i}: col0=${JSON.stringify(String(c[0] || '').slice(0, 40))} cols=${c.length}`);
  }

  console.log('\n--- data rows ---');
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const a = String(c[0] || '').trim();
    if (!/^May\s+\d/i.test(a) && !/^\d{1,2}$/.test(a)) continue;
    console.log(`row ${i}:`, c.slice(0, 14));
    console.log('  mer col6=', c[6], 'parsed=', parseMoney(c[6]));
    console.log('  drop col13=', c[13], 'parsed=', parseMoney(c[13]));
    if (++found >= 3) break;
  }

  const { parsePlanDropsCsv } = require('../etl/forecastImport');
  const rows = parsePlanDropsCsv(text, 'May');
  console.log('\nparsed rows:', rows.length);
  const bad = rows.filter(r => (r.plan_mer != null && r.plan_mer > 999) || (r.drop_lift != null && r.drop_lift > 9999));
  console.log('bad mer/drop rows:', bad.length);
  if (bad[0]) console.log('sample bad:', bad[0]);
}

main().catch(e => { console.error(e); process.exit(1); });
