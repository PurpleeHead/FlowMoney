# FLOWMONEY

A full-stack personal finance workspace for tracking the real cost of exchanging RUB → USDT → VND, expenses in multiple currencies, receipt OCR, translation, and spending analytics.

**Live demo:** https://purpleehead.github.io/FlowMoney/  
**Backend health:** https://flowmoney-app.onrender.com/api/health

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

## Windows PowerShell setup (automated)

Requirements: Node.js 20+ / npm 10+ and Docker Desktop installed and running.

1. Extract this archive.
2. Open the extracted `FLOWMONEY` folder in File Explorer.
3. Right-click `START-FLOWMONEY.ps1` and choose **Run with PowerShell**, or open PowerShell in this folder and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\START-FLOWMONEY.ps1
```

The script creates `server/.env` with the local PostgreSQL URL and a random development JWT secret if it does not exist, starts PostgreSQL on port `5433`, waits for it to become ready, installs npm dependencies, generates Prisma Client, applies the initial migration, and starts the API and Vite frontend. Keep that terminal open while using the app. Open `http://localhost:5173`; API health check: `http://localhost:3001/api/health`.

If the script reports that Docker is missing or not running, start Docker Desktop and run the script again. If ports `5433`, `3001`, or `5173` are already occupied, close the conflicting app or change the corresponding port configuration.

Manual alternative: `docker compose up -d postgres`, `npm install`, copy `.env.example` to `server/.env`, then run `npm run db:generate`, `npm run db:migrate`, and `npm run dev`.

## OCR and translation
Receipt OCR uses Tesseract.js in the browser. First OCR language download needs an internet connection. It supports Vietnamese and English (`vie+eng`); low-quality or thermal-paper receipts should be checked manually. OCR output is never treated as authoritative: review and edit items before saving. The translation endpoint first uses `TRANSLATE_URL` and optional `TRANSLATE_API_KEY` when configured, then attempts a free MyMemory fallback. Translation depends on external service availability; original OCR text and prices are preserved. Do not upload sensitive receipts to third-party translation services without reviewing their privacy policy.

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


## Observed card exchange rates (October 2026 update)

FLOWMONEY does not require a VND rate when recording a RUB → USDT exchange. Enter the actual RUB spent and USDT received first. After a shop purchase, enter the expense in VND and optionally fill in **Actual card debit in USDT** using the amount shown by the card provider.

The observed rate is calculated from all purchases with a card debit recorded:

`observed VND per USDT = sum(VND purchase amounts) / sum(USDT card debits)`

Example: `100,000 VND / 3 USDT = 33,333.33 VND per USDT`. If the exchange history says `10,000 RUB / 100 USDT = 100 RUB per USDT`, the effective expense cost is about `300 RUB` for that purchase. The rate is weighted by actual USDT amounts, not averaged as a simple mean of individual purchase rates.

### Applying the database update to an existing local installation

1. Extract the updated archive **over the existing FLOWMONEY folder**, preserving your `.env` and existing migration history.
2. From the project root run `npm install` if dependencies changed, then `npm run db:generate`.
3. Run `npm run db:migrate` to apply `20261014100000_observed_card_rates` (it only makes three exchange columns nullable and adds optional `Expense.usdtCharged`; it does not delete existing data).
4. Restart `npm run dev`.

The `401 Unauthorized` response from `/api/auth/login` usually means there is no account for that email yet or the password does not match. On the sign-in screen, choose **Create account** once, then sign in with that account. Do not delete the database to fix a login response.
