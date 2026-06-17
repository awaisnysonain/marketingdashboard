# NOBL Dashboard — Deployment Guide

Production deploy notes for a Linux VPS (Ubuntu/Debian) with PM2 + nginx.

## Prerequisites

- Node.js 18+
- PostgreSQL (remote or local — connection via `DB_*` in `.env`)
- nginx (or any reverse proxy for HTTPS)
- A domain pointing at the server (recommended)

## First-time setup

```bash
git clone <repo-url> /home/ubuntu/nobl-dashboard
cd /home/ubuntu/nobl-dashboard

npm install
cd client && npm install && npm run build && cd ..

cp .env.example .env
nano .env          # fill in production values
chmod 600 .env

sudo npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup        # follow the printed instruction once
```

Or use the shortcut: `npm run setup` then `pm2 start ecosystem.config.js --env production`.

## Verify

```bash
pm2 status                  # nobl should be "online"
curl -I http://localhost:3001
pm2 logs nobl --lines 50    # boot logs + cron schedule line
```

## Updating after a git push

```bash
cd /home/ubuntu/nobl-dashboard
git pull
npm install                                    # if package.json changed
cd client && npm install && npm run build && cd ..   # if client/ changed
pm2 restart nobl
```

## nginx (HTTPS)

Sample `/etc/nginx/sites-available/nobl`:

```nginx
server {
  listen 80;
  server_name dashboard.nysonian.com;
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name dashboard.nysonian.com;

  ssl_certificate     /etc/letsencrypt/live/dashboard.nysonian.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dashboard.nysonian.com/privkey.pem;

  client_max_body_size 12m;

  location / {
    proxy_pass         http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection 'upgrade';
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_read_timeout 600s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nobl /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dashboard.nysonian.com
```

## Daily cron

The app schedules sync internally via `node-cron` — no system crontab needed.

- **When:** 11:00 AM Asia/Karachi (Pakistan Standard Time, UTC+5) every day
- **Data window:** syncs through **yesterday** (PKT calendar date)
- **Timeout:** 90-minute hard cap on the full run
- **Backfill window:** fills missing days in the last 7 days automatically
- **Stuck runs:** entries in `running` for >3 hours are auto-marked errored on the next run

**Tasks (10):**

| Task | What it syncs |
|------|----------------|
| `klaviyo` | Klaviyo daily metrics (NOBL + FLO) |
| `tw_refresh` | Brand summary, channel, geo, product daily (Triple Whale SQL) |
| `tw_order_revenue` | Canonical revenue split (Shopify + Amazon) |
| `meta_ads` | Meta Marketing API ad spend (NOBL) |
| `tw_ads` | Campaign/adset/ad performance from TW |
| `tw_air_attribution` | NOBL Air order-level attribution |
| `shopify_orders` | Per-order detail + line items (NOBL + FLO) |
| `appstle_contracts` | Subscription contracts (NOBL + FLO) |
| `nobl_air_aggregate` | Recompute `nobl_air_daily` |
| `product_daily` | Recompute `shopify_product_daily` |

Post-run validation checks `tw_summary_daily`, `shopify_orders_raw`, and `nobl_air_daily` for yesterday (America/New_York reporting date).

## Live / Snapshot hourly refresh

The Live page reads `tw_summary_daily` (ET date keys). A lightweight cron keeps it current:

- **When:** every hour at :00 Asia/Karachi, **except** 11:00 (daily cron hour)
- **Window:** ET yesterday → ET today (`tw_refresh` + `tw_order_revenue`)
- **On deploy:** runs once ~20s after PM2 start so the page is not stale until the next hour

Check status: `GET /api/sync/last-cron` → `live_snapshot.last_run_at`.

If the Live page still shows an old date, verify `NOBL_TW_API_KEY` / `FLO_TW_API_KEY` in `.env` and look for `[LiveSnapshot]` lines in `pm2 logs nobl`.

## NOBL EU Triple Whale (ad spend)

NOBL Travel revenue comes from the main NOBL TW shop. EU **ad spend** is merged from a separate TW workspace:

| Env var | Purpose |
|---------|---------|
| `NOBL_EU_TW_SHOP_ID` | EU TW shop id (e.g. `afmjag-r2.myshopify.com`) |
| `NOBL_EU_TW_API_KEY` | API key for that workspace |

This is **not** FLO EU (`FLO_EU_TW_*`) — same Shopify domain can appear in both, but keys and dashboards differ. EU spend rolls into `brand='NOBL'` totals and the EU row in `tw_geo_daily`.

**Historical backfill** after setting keys:

```bash
node server/scripts/backfillTwSql.js 2024-01-01 $(node -e "console.log(new Date().toISOString().slice(0,10))")
```

Or a shorter window: `node server/scripts/backfillTwSql.js 2026-01-01 2026-06-17`

## Email alerts

Alerts go to `ALERT_EMAIL` on:

- Cron timeout (>90 min)
- Task exceptions
- Missing/incomplete data after the run
- Auto-cleanup of stuck `running` entries

Configure delivery in `.env`:

```bash
# Option A — Resend (recommended)
RESEND_API_KEY=re_xxxxxxxxxx

# Option B — SMTP
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=alerts@yoursite.com
SMTP_PASS=app-password-here
SMTP_SECURE=false
```

Without email configured, alerts still land in the `etl_alerts` table:

```sql
SELECT created_at, severity, subject, body FROM etl_alerts
ORDER BY created_at DESC LIMIT 20;
```

## Admin / viewer roles

- **Admin** = email set in `ADMIN_EMAIL`
- Everyone else = **viewer**
- Admins see **Sync now** in the top bar
- Manual sync: `POST /api/sync/trigger-daily` (admin-only, 6/hour, single-flight)

Change admin: update `ADMIN_EMAIL` in `.env`, restart PM2, have the user log in once.

## Manual backfills

One-off scripts in `server/scripts/`:

| Script | Purpose |
|--------|---------|
| `backfillTwSql.js` | Triple Whale SQL backfill (`npm run backfill:tw`) |
| `syncMetaAdsBackfill.js` | Meta ads history |
| `backfillMetaAirDaily.js` | NOBL Air meta ad daily cache |
| `runFullMetaAirBackfill.js` | Full NOBL Air meta backfill |
| `backfillTtpSnapshot.js` | TTP snapshot table |
| `refreshNoblRange.js` | Refresh NOBL TW data for a date range |

All are safe to re-run (upserts). Always pass explicit date ranges when supported.

## Health checks

```bash
pm2 status

node -e "require('dotenv').config();require('./server/db/postgres').pgQuery('SELECT 1').then(r=>console.log('OK',r.rows)).catch(e=>console.error('FAIL',e.message))"

curl http://localhost:3001/api/sync/last-cron -b "cookie-from-browser"

psql "$DATABASE_URL" -c "SELECT task, brand, error_message, started_at FROM etl_run_log
  WHERE status='error' AND started_at > NOW() - interval '24 hours'
  ORDER BY started_at DESC LIMIT 20;"
```

## Disaster recovery

Sessions, dashboards, annotations, and all analytics data live in PostgreSQL. Server replacement:

1. Clone repo
2. Copy production `.env`
3. `npm run setup`
4. `pm2 start ecosystem.config.js --env production`

Set up `pg_dump` or cloud-provider backups on the DB host — not handled by this app.

PM2 logs write to `data/pm2-error.log` and `data/pm2-out.log` (gitignored).

## Common issues

| Symptom | Fix |
|---------|-----|
| 502 from nginx | `pm2 status` — restart: `pm2 restart nobl` |
| Sync stuck | Auto-cleans after 3 hr. Or: `UPDATE etl_run_log SET status='error' WHERE status='running'` |
| Login 401 forever | `TRUNCATE session;` then re-login |
| Stale UI | `cd client && npm run build` then hard-refresh browser |
| Alerts not arriving | Check `etl_alerts.email_error`, verify `RESEND_API_KEY` or SMTP settings |

See also [README.md](./README.md) and [docs/SUBSCRIPTIONS_README.md](./docs/SUBSCRIPTIONS_README.md).
