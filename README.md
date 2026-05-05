# NOBL Air Executive Dashboard

A full-stack web application that reads your Google Sheet (populated by the NOBL Air Apps Script) and renders a live executive dashboard with charts, tables, row highlights, and annotations.

## Architecture

```
Apps Script (runs daily 7am PT)
    ↓ writes to
Google Sheets (20+ tabs)
    ↓ read via OAuth2
Express Server (Node.js on your VPS)
    ↓ serves
React Frontend (charts, tables, annotations)
    ↓ saves to
SQLite (highlights, annotations, sessions)
```

---

## 1. Google Cloud Setup

1. Go to https://console.cloud.google.com
2. Create a new project (e.g. "nobl-dashboard")
3. Enable the **Google Sheets API**:
   - APIs & Services → Enable APIs → search "Google Sheets API" → Enable
4. Create OAuth2 credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
   - Application type: **Web application**
   - Name: NOBL Dashboard
   - Authorised redirect URIs: `http://YOUR_VPS_IP:3001/auth/callback`
     - Also add `http://localhost:3001/auth/callback` for local dev
5. Copy your **Client ID** and **Client Secret**

---

## 2. Server Setup (VPS)

```bash
# Install Node 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone / upload project
scp -r nobl-dashboard/ user@YOUR_VPS:/home/user/

# On the VPS:
cd nobl-dashboard

# Copy and fill in env
cp .env.example .env
nano .env
```

Fill in `.env`:
```
GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_REDIRECT_URI=http://YOUR_VPS_IP:3001/auth/callback
SPREADSHEET_ID=1IuLZJg2c5HP8cmh8R5JjVSOILr_dnMqka0rkqk4ilw0
PORT=3001
SESSION_SECRET=<any 64 random chars>
CACHE_TTL_SECONDS=300
REFRESH_CRON=0 8 * * *
```

```bash
# Install and build everything
npm run setup

# Start the server
npm start
```

---

## 3. First-time Authentication

1. Open `http://YOUR_VPS_IP:3001` in your browser
2. Click **"Sign in with Google"**
3. Authorize access to Google Sheets (read-only)
4. You'll be redirected back — data loads automatically

Tokens are saved in SQLite and survive restarts. You only need to auth once.

---

## 4. Run as a Service (PM2)

```bash
# Install PM2
sudo npm install -g pm2

# Start the app
pm2 start server/index.js --name nobl-dashboard

# Auto-restart on reboot
pm2 startup
pm2 save
```

---

## 5. Auto-refresh Schedule

The server automatically refreshes data from Google Sheets on a cron schedule.

Default: **every day at 8:00 AM** (server timezone), which is after the Apps Script runs at 7:00 AM PT.

Change via `.env`:
```
REFRESH_CRON=0 8 * * *    # 8am every day
REFRESH_CRON=0 */2 * * *  # every 2 hours
REFRESH_CRON=*/30 * * * * # every 30 minutes
```

You can also manually refresh any time via the **Refresh** button in the top bar.

---

## 6. Dashboard Features

| Feature | How to use |
|---|---|
| Highlight a row | Click the small dot on the left of any row → cycles yellow → green → red → blue → off |
| Annotate a row | Right-click any row → modal opens → write note + choose color → Save |
| View annotation | The colored dot on the right of a row shows there's a note. Hover to preview. |
| Refresh data | Click **Refresh** button in top bar |
| Change date range | Use 7d / 30d / 90d / All buttons on Daily Trend page |
| Search tables | Type in the search box above any table |
| FB data | Expand the collapsible sections on the Channels page |

---

## 7. Pages

- **Summary** — KPI cards, 30-day order/revenue trends, TTP funnel by tier
- **Daily Trend** — Dual-axis chart + full Daily Input table with date range filter
- **Subscriptions** — TTP by tier (chart + table), cohort analysis, weekly trends
- **Channels** — Channel cards, attach rate chart, FB campaigns/adsets
- **Forecast** — Monthly revenue forecast table + charts (green=actual, yellow=current month)
- **Raw Tables** — Browse any sheet tab with search, highlight, and annotate

Subscription ETL and frontend logic for both NOBL and FLO is documented in `docs/SUBSCRIPTIONS_README.md`.

---

## 8. Troubleshooting

**"Not authenticated" error after restart**
- Tokens are saved in `data/nobl.db`. If deleted, re-authenticate at `/auth/login`.

**Sheet tab not found**
- Check the tab name matches exactly (case-sensitive). Edit `TABS` array in `server/index.js`.

**Stale data**
- Click Refresh in the top bar, or wait for the cron job.
- Reduce `CACHE_TTL_SECONDS` in `.env` for more frequent auto-refresh.

**Port already in use**
- Change `PORT` in `.env` and update `GOOGLE_REDIRECT_URI` to match.
