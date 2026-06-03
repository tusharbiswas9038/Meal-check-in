# Meal Check In Cloud

A private React + Express + SQLite meal expense tracker with PWA install support, web push reminders, weekly summaries, CSV export, and Cloudflare Pages friendly frontend deployment.

## Architecture

- Frontend: Vite + React static app, deployable to Cloudflare Pages.
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
CLIENT_ORIGIN=https://YOUR-CLOUDFLARE-PAGES-SITE.pages.dev
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

## Cloudflare Pages Frontend

Connect this Git repo to Cloudflare Pages.

Use these build settings:

```text
Framework preset: None or Vite
Build command: npm run build
Build output directory: client/dist
Root directory: /
Deploy command: leave empty / unset
```

Important: do not set the deploy command to `npx wrangler deploy`. That command deploys Workers and fails at the root of this npm workspace. Cloudflare Pages Git integration automatically deploys the files from `client/dist` after the build succeeds.

No Cloudflare environment variable is required. On first launch, if the app cannot reach an API, it shows a setup screen asking for the VPS backend URL. Enter the HTTPS API URL once, and the app stores it in the browser.

Optional: if you want zero first-run setup in the browser, add this Cloudflare Pages environment variable:

```env
VITE_API_BASE=https://YOUR_API_DOMAIN
```

Manual Pages deploy fallback:

```bash
npm run build
npm run cf:pages:deploy
```

Use the manual Wrangler command only from your machine or CI with Cloudflare authentication. Do not add it as the Cloudflare Pages Git deploy command.

## First Login Flow

1. Open the Cloudflare Pages URL.
2. If prompted, enter the backend API URL: `https://YOUR_API_DOMAIN`.
3. If prompted, enter the private `APP_TOKEN` from the VPS `.env` file.
4. Go to Settings and enable daily push reminders.
5. Press Test under Push status to confirm notifications work.

## Production Notes

- Keep `data/` persistent; it contains the SQLite database.
- Keep `.env` private and do not commit it.
- PM2 writes API logs to `logs/`; error middleware and unhandled runtime errors go to the PM2 error log.
- Web push requires HTTPS for both Cloudflare Pages and the backend API.
- If the backend URL changes, update it inside app Settings or clear local storage and reconnect.
