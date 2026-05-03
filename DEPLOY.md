# NOBL Dashboard — Deployment Guide

Concise, opinionated deploy notes. Targets a Linux VPS (Ubuntu/Debian) with PM2 + nginx. Adapt for other targets.

## Prerequisites on the server

- Node.js 18+ (`nvm install 18 && nvm use 18`)
- PostgreSQL access (the app uses the remote DB at `54.172.115.118` per `.env`)
- nginx (or any reverse proxy that handles HTTPS)
- A domain pointing at the server (optional but recommended)

## First-time setup

```bash
# 1. Clone (or pull) the repo
git clone <repo-url> /home/ubuntu/nobl-dashboard
cd /home/ubuntu/nobl-dashboard

# 2. Install deps + build the React app
npm install
cd client && npm install && npm run build && cd ..

# 3. Drop your production .env in place (it's gitignored — copy manually)
#    (use scp from your laptop, or paste into a fresh file)
nano .env
chmod 600 .env

# 4. Install PM2 globally
sudo npm install -g pm2

# 5. Start the app
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup        # follow the printed instruction once
```

## Verify

```bash
pm2 status                  # nobl should be "online"
curl -I http://localhost:3001       # HTTP 200 (or 401 on /api/*)
pm2 logs nobl --lines 50    # boot logs + cron schedule line
```

## Updating after a git push

```bash
cd /home/ubuntu/nobl-dashboard
git pull
npm install                                    # only if package.json changed
cd client && npm install && npm run build && cd ..   # only if client/ changed
pm2 restart nobl
```

## nginx in front (HTTPS termination)

Sample `/etc/nginx/sites-available/nobl`:

```nginx
server {
  listen 80;
  server_name dashboard.nysonian.com;

  # Let's Encrypt + redirect → handled by certbot
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name dashboard.nysonian.com;

  ssl_certificate     /etc/letsencrypt/live/dashboard.nysonian.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dashboard.nysonian.com/privkey.pem;

  client_max_body_size 12m;     # matches Express body parser limit

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
    proxy_read_timeout 600s;    # cron-trigger endpoint is fast but be safe
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nobl /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dashboard.nysonian.com
```

## Cron / scheduled jobs

The app runs its own cron internally (via `node-cron`):

- **11:00 AM Asia/Karachi (Pakistan time) every day** — full daily sync
  - Sources: Klaviyo, TripleWhale, Shopify Admin, Appstle
  - Tables refreshed: tw_summary_daily, tw_channel_daily, tw_geo_daily, tw_product_daily, tw_ads_daily, tw_air_order_attribution, shopify_orders_raw, nobl_air_subscribers, nobl_air_daily, shopify_product_daily
  - Auto-cleans stuck "running" entries older than 3 hours
  - 60-min hard timeout on the whole run
  - Sends email alerts to `ALERT_EMAIL` (default `muhammad.awais@nysonian.com`) on failures

You don't need a system crontab — PM2 keeps the process alive and the in-process scheduler fires.

## Email alerts

The cron sends an email to `ALERT_EMAIL` if any of these happens:
- Cron times out (>60 min)
- A task throws an exception
- After the run, expected data isn't present (`tw_summary_daily`, `shopify_orders_raw`, `nobl_air_daily` for yesterday)
- More than zero stuck `running` entries get auto-cleaned

To enable real email delivery, add ONE of these to `.env`:

```bash
# Option A — Resend (recommended, simplest, 3000 emails/mo free)
RESEND_API_KEY=re_xxxxxxxxxx
# Sign up at https://resend.com, verify a sending domain, paste the key here

# Option B — SMTP (requires npm install nodemailer)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=alerts@yoursite.com
SMTP_PASS=app-password-here
SMTP_SECURE=false
```

Without either configured, alerts still land in the `etl_alerts` table — you can read recent ones via SQL:

```sql
SELECT created_at, severity, subject, body FROM etl_alerts
ORDER BY created_at DESC LIMIT 20;
```

## Admin / viewer roles

- **Admin** = `muhammad.awais@nysonian.com` only (set via `ADMIN_EMAIL` env var)
- Everyone else who signs up = **viewer**
- Admins see a "Sync now" button in the topbar; viewers don't
- Manual sync endpoint (`POST /api/sync/trigger-daily`) is admin-only + rate-limited to 6/hour + single-flight (won't fire if a cron is already running)

To change admin: edit `ADMIN_EMAIL` in `.env`, then restart (`pm2 restart nobl`). Existing user roles get re-asserted on every login, so simply having the user log in once after the env change applies it.

## Health checks

```bash
# Process up?
pm2 status

# DB reachable?
node -e "require('dotenv').config();require('./server/db/postgres').pgQuery('SELECT 1').then(r=>console.log('OK',r.rows)).catch(e=>console.error('FAIL',e.message))"

# Last cron status?
curl http://localhost:3001/api/sync/last-cron -b "cookie-from-browser"

# Recent ETL errors?
psql ... -c "SELECT task, brand, error_message, started_at FROM etl_run_log
             WHERE status='error' AND started_at > NOW() - interval '24 hours'
             ORDER BY started_at DESC LIMIT 20;"
```

## Disaster recovery

The DB lives at `54.172.115.118` (per `.env`). Snapshots are not automated by this app — set up `pg_dump` cron on the DB host or use the cloud provider's backup feature.

Sessions, dashboards, annotations, and alerts all live in PG, so a server replacement is just: clone repo + drop in `.env` + `pm2 start`.

## Common issues

| Symptom | Fix |
|---|---|
| 502 from nginx | `pm2 status` — restart if down: `pm2 restart nobl` |
| "Sync stuck" — never returns | Cron auto-cleans after 3 hr. Or manually: `UPDATE etl_run_log SET status='error' WHERE status='running'` |
| Login returns 401 forever | Session table `session` may have a corrupt row. `TRUNCATE session;` and re-login |
| Build folder out of date | `cd client && npm run build` and refresh browser (hard refresh = Ctrl+Shift+R) |
| ALERT_EMAIL not receiving | Check `etl_alerts.email_error`, ensure `RESEND_API_KEY` is set, verify sending domain in Resend |
