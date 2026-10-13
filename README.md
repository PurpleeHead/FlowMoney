# FLOWMONEY

A full-stack personal finance workspace for tracking the real cost of exchanging RUB → USDT → VND, expenses in multiple currencies, receipt OCR, translation, and spending analytics.

## Features
- Email/password registration and login with bcrypt password hashing and JWT auth.
- Cloud-ready PostgreSQL schema using Prisma; user-scoped wallets, exchange records, expenses, receipt records.
- Exchange calculator: enter RUB spent and USDT received, then USDT→VND rate and fee to see estimated VND received and effective rates.
- Expense entries with category, date, original currency and amount; totals are normalized to VND using the rates you enter.
- Receipt upload with browser-local OCR powered by Tesseract.js (image files stay in the browser for OCR), editable extracted text, line-item parsing, and optional server translation adapter.
- Light/dark theme, responsive layout, dashboard summary, category analytics, CSV export.
- Unit tests for currency math and receipt parsing.

## Requirements
Node.js 20+, npm 10+, Docker Desktop (or any PostgreSQL 14+ instance).

## Windows PowerShell setup
```powershell
# 1. Extract the project and enter its folder
cd .\FLOWMONEY

# 2. Start local PostgreSQL (Docker Desktop must be running)
docker compose up -d postgres

# 3. Install dependencies
npm install

# 4. Configure environment
Copy-Item .env.example server/.env
# Edit server/.env and replace JWT_SECRET with a long random secret.

# 5. Create tables
npm run db:generate
npm run db:migrate

# 6. Start API and frontend in separate terminal processes
npm run dev
```
Open http://localhost:5173. API health check: http://localhost:3001/api/health.

If PowerShell blocks scripts, use `npm.cmd` instead of `npm`.

## OCR and translation
Receipt OCR uses Tesseract.js in the browser. First OCR language download needs an internet connection. It supports Vietnamese and English (`vie+eng`); low-quality or thermal-paper receipts should be checked manually. OCR output is never treated as authoritative: review and edit items before saving. The translation endpoint is an adapter for a LibreTranslate-compatible service. Configure `TRANSLATE_URL` and optional `TRANSLATE_API_KEY` in `server/.env`; if absent, the UI preserves original item text and translation is skipped. Do not upload sensitive receipts to third-party translation services without reviewing their privacy policy.

## Exchange calculations
Rates are manually entered and stored with the exchange record; the app does not pretend that a rate is live. Calculation:
- `VND received = USDT received × VND per USDT − VND fee`
- `effective VND per RUB = VND received ÷ RUB spent`
- `effective RUB per USDT = RUB spent ÷ USDT received`

This captures the real outcome of the two conversions. Enter the actual amount received at each stage to include spread and fees. Values are rounded for display only.

## Production deployment
- Deploy `server` as a Node web service and `client` as a static site, or serve the built client through a reverse proxy.
- Provision managed PostgreSQL and set `DATABASE_URL`, `JWT_SECRET`, `CLIENT_ORIGIN`, `PORT`, and optional translation variables in the backend environment.
- Build with `npm run build`; run API with `npm start` from the repository root.
- Enforce HTTPS, use a unique secret, configure backups, rate limits and monitoring, and set a strict CORS origin before exposing publicly.

## Structure
```text
FLOWMONEY/
├── client/                 # React + TypeScript + Vite
│   └── src/
│       ├── components/     # shared UI, receipt scanner
│       ├── lib/            # API client, calculations, parser, tests
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── server/                 # Express + TypeScript + Prisma
│   ├── prisma/schema.prisma
│   └── src/
│       ├── middleware/     # auth and error handling
│       ├── routes/         # auth, exchange, expense, receipt, translate
│       ├── services/
│       └── index.ts
├── docker-compose.yml
└── README.md
```

## Current scope and limitations
This is a runnable MVP foundation, not a regulated accounting system. It uses manually supplied exchange rates; it does not execute exchanges, connect to banks, or provide tax advice. Receipt OCR is local to the browser, but optional translation can send text to the configured translation provider. Password reset, email verification, refresh-token rotation, and multi-factor authentication are production follow-ups.
