# Meal Check In Cloud (fixed)

A hostable React + Express + SQLite meal expense tracker with PWA support.

## Run locally
1. Copy `.env.example` to `.env` if needed.
2. Run `npm install`
3. Run `npm run dev`

## Production
1. Run `npm install`
2. Run `npm run build`
3. Run `npm start`

## Deployment
Use a persistent disk for the `data/` directory so your SQLite file survives redeploys and browser cleanup.
