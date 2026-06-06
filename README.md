# Meal Check In Cloud

A private React + Express + SQLite expense tracker with lunch/dinner check-ins, additional food expenses, a separate monthly expense workspace, PWA install support, web push reminders, weekly summaries, CSV export, and Cloudflare-hosted frontend deployment.

## Architecture

- Frontend: Vite + React static app deployed through Cloudflare Workers Builds as Static Assets.
- Backend: Express API on a VPS, default port `9900`.
- Database: SQLite at `./data/meal-check-in.db` by default.
- Process manager: PM2 using `ecosystem.config.cjs`.
- Logs: `logs/backend.out.log`, `logs/backend.error.log`, and `logs/backend.combined.log`.

## Local Development

```bash
npm install
npm run dev
```

Local dev runs the client on `5173` and the backend on `9900`. The Vite dev server proxies `/api` to `http://localhost:9900`.

## VPS Backend Setup

Run these commands on the VPS from the repo directory.

```bash
npm install
npm run build
npm install -g pm2
npm run vapid:keys
cp .env.example .env
```

Edit `.env`:

```env
PORT=9900
DB_PATH=./data/meal-check-in.db
CLIENT_ORIGIN=https://YOUR-CLOUDFLARE-FRONTEND-URL
APP_TOKEN=choose-a-long-private-token
VAPID_PUBLIC_KEY=paste-public-key
VAPID_PRIVATE_KEY=paste-private-key
VAPID_SUBJECT=mailto:you@example.com
WEEKLY_SUMMARY_TIME=18:00
TZ=Asia/Kolkata
```

Start the backend in the background:

```bash
mkdir -p data logs
npm run pm2:start
pm2 save
pm2 startup
```

After `pm2 startup`, PM2 prints one command. Run that printed command once so the backend starts again after VPS reboot.

Useful backend commands:

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
pm2 status
```

Check the backend directly:

```bash
curl http://127.0.0.1:9900/api/health
```

## Nginx + HTTPS

Point a domain or free DNS hostname to the VPS, then copy the sample config:

```bash
sudo cp docs/nginx-meal-checkin.conf /etc/nginx/sites-available/meal-checkin-api
sudo nano /etc/nginx/sites-available/meal-checkin-api
sudo ln -s /etc/nginx/sites-available/meal-checkin-api /etc/nginx/sites-enabled/meal-checkin-api
sudo nginx -t
sudo systemctl reload nginx
```

In the Nginx file, replace `YOUR_API_DOMAIN` with the hostname that will serve the backend, for example `meal-api.example.com`. The config proxies public traffic to `127.0.0.1:9900`.

Enable HTTPS:

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_API_DOMAIN
```

Your frontend must use the HTTPS API URL, for example:

```text
https://YOUR_API_DOMAIN
```

## Cloudflare Frontend

Your current Cloudflare screen requires a deploy command, which means Cloudflare is using the Workers Builds flow. This repo is configured for that flow with Workers Static Assets.

Use these settings:

```text
Build command: npm run build
Deploy command: npm run cf:deploy
Root directory: /
```

The deploy script runs:

```bash
wrangler deploy
```

The `wrangler.toml` file tells Cloudflare to publish the built Vite files from `client/dist` as static assets and use SPA fallback routing:

```toml
name = "meal-check-in"
compatibility_date = "2026-06-03"

[assets]
directory = "./client/dist"
not_found_handling = "single-page-application"
```

Do not use `npx wrangler pages deploy ...` in this Workers Builds setup. That command calls the Pages API and is the reason the deploy step fails after a successful build.

For the Cloudflare deploy token, use Workers permissions, not Pages permissions:

```text
Account > Workers Scripts > Edit
Account > Workers Builds Configuration > Edit
User > User Details > Read
```

Scope the token to the account that owns the Cloudflare project. If your token already has broad account access, no extra repo change is needed.

No app-specific Cloudflare environment variable is required. On first launch, if the app cannot reach an API, it shows a setup screen asking for the VPS backend URL. Enter the HTTPS API URL once, and the app stores it in the browser.

Optional: if you want zero first-run setup in the browser, add this Cloudflare environment variable:

```env
VITE_API_BASE=https://YOUR_API_DOMAIN
```

## First Login Flow

1. Open the Cloudflare frontend URL.
2. If prompted, enter the backend API URL: `https://YOUR_API_DOMAIN`.
3. If prompted, enter the private `APP_TOKEN` from the VPS `.env` file.
4. Go to Settings and enable daily push reminders.
5. Press Test under Push status to confirm notifications work.

## Monthly Expenses

Use the `Monthly` button in the app header, or open `/expenses`, to track full monthly spending separately from the main meal check-in screen.

- Meal and extra food expenses are counted automatically as the Food category.
- Add other monthly costs such as rent, utilities, transport, subscriptions, health, shopping, travel, and family expenses.
- Amounts can be `0`, which is useful when you want to mark a planned lunch, dinner, or monthly item as no spend.
- Turn on Repeat every month when adding fixed costs. The backend creates that expense for each month automatically.
- Deleting a recurring entry from a month skips it for that month; pausing the recurring template stops future automatic entries.

## Production Notes

- Keep `data/` persistent; it contains the SQLite database.
- Keep `.env` private and do not commit it.
- PM2 writes API logs to `logs/`; error middleware and unhandled runtime errors go to the PM2 error log.
- Web push requires HTTPS for both the Cloudflare frontend and the backend API.
- If the backend URL changes, update it inside app Settings or clear local storage and reconnect.
