# NOBL Air Executive Dashboard

Full-stack analytics dashboard for **NOBL Air** and **Pilates FLO**. Data is synced from Triple Whale, Shopify, Appstle, Klaviyo, and Meta into PostgreSQL, then served to a React frontend.

## Architecture

```
Triple Whale / Shopify / Appstle / Klaviyo / Meta APIs
    ↓  daily cron + manual sync (server/etl/syncEngine.js)
PostgreSQL (tw_*, shopify_*, nobl_air_*, flo_appstle_*, etc.)
    ↓  REST API (server/routes/analytics.js)
React frontend (client/)
    ↓  sessions, comments, AI dashboards
PostgreSQL (users, session, ai_dashboards, …)
```

Auth is handled via the Nysonik ERP token flow in production. Local dev skips auth when `NODE_ENV !== production`.

## Quick start (local)

```bash
cp .env.example .env          # fill in DB + API keys
npm run setup                 # install deps + build client
npm run dev                   # nodemon on :3001
```

In another terminal:

```bash
cd client && npm start        # React dev server on :3000 (proxies API to :3001)
```

Production build: `npm start` serves the built React app from `client/build/`.

## npm scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run production server |
| `npm run dev` | Run server with nodemon |
| `npm run build` | Build React client |
| `npm run setup` | Install all deps + build client |
| `npm run backfill:tw` | Manual Triple Whale SQL backfill (`server/scripts/backfillTwSql.js`) |

Other one-off backfill scripts live in `server/scripts/` — see comments at the top of each file.

## Daily sync

The server runs an in-process cron at **11:00 AM Asia/Karachi (PKT, UTC+5)** every day and syncs **yesterday's** data. Tasks:

`klaviyo`, `tw_refresh`, `tw_order_revenue`, `meta_ads`, `tw_ads`, `tw_air_attribution`, `shopify_orders`, `appstle_contracts`, `nobl_air_aggregate`, `product_daily`

Admins can also trigger sync from the UI (**Sync now**) or `POST /api/sync/trigger-daily`.

Details: [DEPLOY.md](./DEPLOY.md)

## Documentation

| File | Contents |
|------|----------|
| [DEPLOY.md](./DEPLOY.md) | Production deploy, PM2, nginx, alerts, health checks |
| [docs/SUBSCRIPTIONS_README.md](./docs/SUBSCRIPTIONS_README.md) | NOBL/FLO subscription ETL and API |

## Project layout

```
client/          React frontend
server/
  index.js       Express app, cron, auth
  routes/        API routes (analytics, sync, AI, comments)
  etl/           Sync jobs and aggregations
  scripts/       Manual backfill utilities
  db/            Postgres connection + schema helpers
data/            Runtime logs (gitignored); legacy nobl.db if present
```

## Environment

Copy `.env.example` → `.env`. Required for a working deploy:

- **Database:** `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`
- **Triple Whale:** `NOBL_TW_*`, `FLO_TW_*` (and EU keys for NOBL)
- **Shopify:** `NOBL_SHOPIFY_*`, `FLO_SHOPIFY_*`
- **Appstle:** `APPSTLE_API_KEY`, `FLO_APPSTLE_API_KEY`
- **Session:** `SESSION_SECRET`

See `.env.example` for the full list including optional Meta, Klaviyo, OpenAI, and alert settings.
