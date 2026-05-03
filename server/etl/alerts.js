/**
 * Alerts module — write to etl_alerts table + optionally send email.
 *
 * Email backends (auto-detected by env vars, in priority order):
 *   1. RESEND_API_KEY → Resend (https://resend.com — 3000/mo free, simplest)
 *   2. SMTP_HOST + SMTP_USER + SMTP_PASS → nodemailer over SMTP
 *   3. (none) → table-only (you can read alerts via /api/sync/status or psql)
 *
 * Recipient: ALERT_EMAIL env var (defaults to muhammad.awais@nysonian.com).
 *
 * Use:
 *   await sendAlert({
 *     severity: 'error',
 *     subject: 'Cron failure: tw_refresh',
 *     body:    '...details...',
 *     context: { run_id, task, ... },
 *   });
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun } = require('../db/postgres');

const ALERT_EMAIL = process.env.ALERT_EMAIL || 'muhammad.awais@nysonian.com';
const ALERT_FROM  = process.env.ALERT_FROM  || 'NOBL Dashboard <alerts@nysonian.com>';

let schemaInit = false;
async function ensureSchema() {
  if (schemaInit) return;
  await pgRun(`
    CREATE TABLE IF NOT EXISTS etl_alerts (
      id           BIGSERIAL PRIMARY KEY,
      severity     TEXT NOT NULL,                  -- info | warn | error | critical
      subject      TEXT NOT NULL,
      body         TEXT,
      context      JSONB,
      sent_email   BOOLEAN DEFAULT FALSE,
      email_error  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_etl_alerts_created ON etl_alerts (created_at DESC)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_etl_alerts_unsent ON etl_alerts (sent_email, created_at) WHERE NOT sent_email`);
  schemaInit = true;
}

// Suppress duplicate alerts within this window (in seconds)
const DEDUPE_WINDOW = 30 * 60; // 30 min

async function sendAlert({ severity = 'error', subject, body = '', context = null }) {
  try {
    await ensureSchema();

    // Dedupe — don't spam if same subject already alerted within DEDUPE_WINDOW
    const dup = await require('../db/postgres').pgQuery(
      `SELECT id FROM etl_alerts
       WHERE subject = $1 AND created_at > NOW() - interval '${DEDUPE_WINDOW} seconds'
       LIMIT 1`,
      [subject]
    );
    if (dup.rows.length) {
      console.log('[Alert] Suppressed duplicate within dedupe window:', subject);
      return { suppressed: true };
    }

    // Always insert into table first (audit log + retry queue)
    const ins = await require('../db/postgres').pgQuery(
      `INSERT INTO etl_alerts (severity, subject, body, context)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [severity, subject, body, context ? JSON.stringify(context) : null]
    );
    const id = ins.rows[0].id;

    // Try to send email
    let emailErr = null, sent = false;
    try {
      sent = await tryEmail({ severity, subject, body, context });
    } catch (e) {
      emailErr = e.message;
      console.error('[Alert] Email send failed:', emailErr);
    }

    if (sent || emailErr) {
      await pgRun(
        `UPDATE etl_alerts SET sent_email=$1, email_error=$2 WHERE id=$3`,
        [sent, emailErr, id]
      );
    }

    console.log(`[Alert ${severity}] ${subject}` + (sent ? ' (emailed)' : ''));
    return { id, sent, error: emailErr };
  } catch (e) {
    console.error('[Alert] FATAL — could not record alert:', e.message);
    return { error: e.message };
  }
}

async function tryEmail({ severity, subject, body, context }) {
  // Format the email body
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222;max-width:640px">
    <h2 style="color:${severity === 'error' || severity === 'critical' ? '#c0392b' : severity === 'warn' ? '#cc8a00' : '#3b5bdb'};margin-bottom:8px">
      [${severity.toUpperCase()}] ${escapeHtml(subject)}
    </h2>
    <pre style="background:#f4f5f7;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(body)}</pre>
    ${context ? `<details style="margin-top:12px"><summary style="cursor:pointer;color:#666">Context</summary>
      <pre style="background:#f4f5f7;padding:12px;border-radius:6px;font-size:11px;margin-top:8px">${escapeHtml(JSON.stringify(context, null, 2))}</pre>
    </details>` : ''}
    <p style="color:#888;font-size:11px;margin-top:16px">
      NOBL Analytics Dashboard · ${new Date().toISOString()}
    </p>
  </div>`;

  // 1. Try Resend (HTTP, no extra deps)
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    ALERT_FROM,
        to:      [ALERT_EMAIL],
        subject: `[${severity.toUpperCase()}] ${subject}`,
        html,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Resend HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return true;
  }

  // 2. Try SMTP via nodemailer (only if installed)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new Error('SMTP configured but nodemailer not installed (run: npm i nodemailer)'); }

    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: ALERT_FROM,
      to: ALERT_EMAIL,
      subject: `[${severity.toUpperCase()}] ${subject}`,
      html,
    });
    return true;
  }

  // 3. No backend configured — table-only (still useful: visible in /api/sync/status)
  return false;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { sendAlert, ensureSchema };
