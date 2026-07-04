# Loan Readiness

A small Node/Express app for accountants: upload a client's financials (or load a demo sample), run consistency checks, draft an AI narrative, and assemble a lender-ready package.

All three phases of the original build plan are in place and verified end-to-end against a real Intuit sandbox company and a real PDF render:

1. **CSV upload** — done
2. **QuickBooks OAuth** — done and validated (2026-07-05)
3. **PDF export** — done and validated (2026-07-05), after fixing two bugs found on first real test (see "PDF export" below)

QuickBooks cash flow and AR/AP aging (added 2026-07-05, see "QuickBooks setup" below) are now fully validated against a live company too — including finding and fixing a real bug in the debt-payments calculation. Currency display was also fixed the same day (QuickBooks-sourced data now shows in the connected company's actual currency instead of always £).

## Setup

```
cd loan-readiness-app
npm install
cp .env.example .env
```

Edit `.env` and set `ANTHROPIC_API_KEY` (from https://console.anthropic.com/) — needed for the "Generate narrative" step. Set `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` — needed for "Connect QuickBooks" (see below). Both are optional; CSV upload and sample data work without either.

```
npm start
```

Then open http://localhost:3000.

## How it works

- **Intake**: pick a sample business, upload a CSV export, or connect QuickBooks.
  - *CSV*: any layout works — trial balance, P&L, balance sheet. You choose which column is the line-item label and which is the amount, then map each row to a statement line (Revenue, Current Assets, etc.) or mark it "Ignore" to skip subtotal/total rows. The app sums whatever you map.
  - *QuickBooks*: connects via OAuth and pulls Profit & Loss, Balance Sheet, Cash Flow, and AR/AP aging reports automatically.
- **Review**: recomputes the same consistency checks as the original prototype (balance sheet doesn't balance, net income vs. retained earnings mismatch, thin current ratio, thin equity, stale receivables) plus the ratio sidebar (current ratio, equity/assets, DSCR).
- **Narrative**: calls `/api/narrative` on the server, which proxies the Anthropic API using your `ANTHROPIC_API_KEY`. (The original prototype called `api.anthropic.com` straight from the browser, which can't work without exposing a secret key in client-side JS — this is why a backend now exists.)
- **Package**: assembles the numbers, flags, and narrative into a one-page draft, with a "Download PDF" button.

## QuickBooks setup

1. Go to https://developer.intuit.com/app/developer/myapps and create an app (free). Choose the Accounting scope.
2. Under the app's "Keys and credentials" page (Development tab), toggle "Show credentials" and copy the **Client ID** and **Client Secret** into `.env` as `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`.
3. Add `http://localhost:3000/api/quickbooks/callback` as a redirect URI on the app (must match `QBO_REDIRECT_URI` in `.env` exactly, no trailing slash).
4. Intuit auto-creates a sandbox test company for you — that's what you'll connect to for development.
5. Restart the server, go to Intake, click "Connect QuickBooks," and sign in with your Intuit developer account.

**Validated 2026-07-05** against a live sandbox company: the imported Balance Sheet balanced exactly (total assets = total liabilities + equity), confirming `sumGroupTotals()` in `lib/quickbooks.js` is picking up the right P&L/Balance Sheet rows. If a different company's chart-of-accounts structure trips up the parser, use `GET /api/quickbooks/financials/raw` to see the untouched report JSON and adjust `sumGroupTotals()`.

**Cash flow and AR/AP aging** (added and fully validated 2026-07-05): operating cash flow comes from the CashFlow report's Operating Activities total. AR/AP over 90 days comes from the AgedReceivables/AgedPayables reports — these are shaped differently (aging buckets like "91 and over" are columns, not rows), so `parseAgingOver90()` finds the right column by title, then reads it off the grand-total row (`{"group": "GrandTotal"}`). Validated against a real sandbox company's AgedPayables report: the parser correctly located the grand-total row and pulled $0.00 from the "91 and over" column, matching the real total exactly (0 + 755 + 847.67 + 0 + 0 = 1,602.67).

"Debt payments" needed an actual fix, not just validation: QuickBooks' Cash Flow statement has no single defined line for it, so `sumMatchingLabels()` keyword-matches likely labels (loan payment, notes payable, debt service, etc.) inside Financing Activities. The first version summed both directions of matching accounts — but a positive value there means new borrowing (a cash inflow), not a payment, and the live sandbox company had a "Notes Payable: +$25,000" line (a new loan draw) that got counted as a $25,000 payment, wrecking the DSCR calculation. Fixed by only counting negative (actual repayment) matches; extend `DEBT_PAYMENT_LABEL_RE` in `lib/quickbooks.js` if a company's account names aren't caught by the current keyword list.

## PDF export

Click "Download PDF" on the Package screen. This renders the package as a standalone HTML page and prints it to PDF using **puppeteer-core**, which drives whatever Chrome/Chromium/Edge is already installed on your machine rather than downloading its own copy (full `puppeteer` tries to download ~200MB of Chromium at install time, which isn't necessary when you already have a browser, and actually failed outright in the sandbox this was built in due to no network access).

`lib/pdf.js` looks for Chrome in the usual install locations for macOS, Windows, and Linux. If it can't find yours, set `PUPPETEER_EXECUTABLE_PATH` in `.env` to the exact path of your browser's executable and restart.

**Validated 2026-07-05** on a real machine, after fixing two bugs the first test caught: (1) this version of `puppeteer-core` returns the PDF as a plain `Uint8Array`, and Express's `res.send()` silently falls back to `res.json()` for anything that isn't a true `Buffer` — corrupting the file into JSON text. Fixed with `Buffer.from()`. (2) A margin set in both Puppeteer's `page.pdf()` options and the HTML's own body padding doubled up and pushed the footnote onto an otherwise-blank second page. Fixed by removing the Puppeteer-level margin and controlling all spacing in the template. Confirmed working: single-page PDF with correct fonts and layout, tested against both CSV-sourced and QuickBooks-sourced data. If a much longer narrative ever overflows to a second page, tighten spacing further in `buildPackageHtml()` in `lib/pdf.js`.

## Deployment (going live with QuickBooks production)

Sandbox mode (everything above) works entirely on localhost. QuickBooks production access requires a public HTTPS redirect URL, so this needs real hosting. **Not build-tested** — there was no Docker available in the environment this was written in, so the Dockerfile follows standard patterns but hasn't been run. If the Render build fails, check its build log; the likely fix is adding a missing library to the `apt-get install` line in the `Dockerfile`.

### Why not a typical serverless host

This app needs a persistent server, not serverless functions: PDF export runs a real headless Chrome process, and the QuickBooks connection is stored in a local file that needs to survive restarts. That rules out platforms like Vercel or Netlify. Render was chosen for a straightforward dashboard, Docker support, and persistent disks.

### 1. Push this folder to GitHub

```
cd loan-readiness-app
git init
git add .
git commit -m "Initial commit"
```

Create a new repository at https://github.com/new (don't initialize it with a README), then:

```
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

`.env` and `.qbo-tokens.json` are already gitignored — your secrets and local QuickBooks connection won't be pushed.

### 2. Create the Render service

1. Sign up at https://render.com and connect your GitHub account.
2. Click **New +** → **Blueprint**, and select the repo you just pushed. Render will read `render.yaml` (already in this folder) and set up most of the service automatically — Docker build, a 1GB persistent disk mounted at `/data`, and placeholders for the environment variables below.
3. If you'd rather set it up by hand instead of using the Blueprint: **New +** → **Web Service** → select the repo → Render should auto-detect the `Dockerfile`. Choose the **Starter** plan (needed for the persistent disk — the free tier doesn't support one, and your QuickBooks connection would be lost on every restart without it). Add a **Disk** under the service's Settings, mounted at `/data`, 1GB is plenty.

### 3. Set environment variables

In the Render dashboard, under Environment, set:

- `ANTHROPIC_API_KEY` — same key as local use.
- `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` — your **production** keys, not the sandbox ones (see step 4).
- `QBO_REDIRECT_URI` — `https://<your-render-url>.onrender.com/api/quickbooks/callback` (Render shows you the URL once the service is created).
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` — **required**. Without these, anyone who finds your Render URL can view a connected company's real financial data — there's no other login on this app. Make up any username/password.

`QBO_ENVIRONMENT=production`, `QBO_TOKEN_FILE=/data/.qbo-tokens.json`, and `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` are already set by `render.yaml`.

### 4. Get QuickBooks production keys

Sandbox and production use **separate** Client ID/Secret pairs on the same Intuit app.

1. In your Intuit app (developer.intuit.com), find the "Production" tab under Keys and credentials (next to the "Development" tab you used for sandbox).
2. Getting production keys unlocked requires completing your developer profile and providing EULA / Privacy Policy URLs. Since this is for your own personal use rather than a publicly distributed app, placeholder URLs (e.g. a plain page you host anywhere, even a Google Doc link) are sufficient — Intuit's own guidance is that a placeholder is fine for private, non-public apps. The more involved "app review" process is mainly for apps being listed publicly on Intuit's app store.
3. Add your Render redirect URI (`https://<your-render-url>.onrender.com/api/quickbooks/callback`) to the **Production** redirect URI list on the app — this is separate from the sandbox redirect URI you added earlier; both can coexist.
4. Copy the Production Client ID/Secret into Render's environment variables from step 3.

### 5. Go live

Once deployed, visit your Render URL, log in with the basic auth credentials you set, and click "Connect QuickBooks." This will now prompt you to authorize a **real** QuickBooks company, not the sandbox test company — double check you're connecting the right one.

## Project structure

```
server.js                Express server — static files, CSV parsing, narrative proxy, QuickBooks OAuth routes, PDF export, basic auth
lib/quickbooks.js        QuickBooks OAuth flow, token storage/refresh, report fetching + parsing
lib/pdf.js               Package HTML template + Chrome-based PDF rendering
public/index.html        App shell
public/css/style.css     Styles (ported from the original prototype)
public/js/app.js         All client-side logic: state, rendering, CSV mapping, QuickBooks import, PDF download, ratio checks
Dockerfile               Node + Chromium image for deployment (PDF export needs a real browser)
render.yaml              Render Blueprint — one-step service setup, see Deployment section
.dockerignore            Keeps node_modules/.env/.qbo-tokens.json out of the built image
.env.example              Copy to .env and fill in
.qbo-tokens.json          Created automatically after connecting — gitignored, holds your local OAuth tokens (or on a mounted disk in production, see Deployment)
```

## Notes on the CSV mapping

- Required buckets (the app won't let you proceed without at least one row mapped to each): Revenue, COGS, Operating expenses, Current assets, Long-term assets, Current liabilities, Long-term liabilities, Owner's equity.
- Optional buckets default to 0 if unmapped: Change in retained earnings (defaults to match net income, so an unmapped field doesn't manufacture a false flag), Operating cash flow, Debt payments, AR/AP over 90 days.
- The app makes a best-effort guess at bucket assignment from row labels (e.g. a row called "Current Assets" auto-suggests that bucket) — always double check the guesses before continuing.
- CSV uploads and sample data always display in GBP (£), matching the original prototype — there's no currency metadata in a generic CSV to detect from. QuickBooks-sourced data uses the connected company's actual currency instead (see below).

## Currency

QuickBooks reports include the company's home currency (e.g. `USD`, `GBP`, `EUR`) in their response header, so importing from QuickBooks now displays amounts in that currency rather than always showing £ — fixed 2026-07-05 after testing against a real US-based sandbox company that reported in USD while the app kept labeling everything in £. The code->symbol mapping is `CURRENCY_SYMBOLS` in `public/js/app.js`; unrecognized codes fall back to showing the raw code (e.g. `CHF 1,234`) rather than guessing a symbol. CSV upload and sample data still default to £, since there's nothing to detect a currency from in a generic CSV.

## What's next

All three original phases, plus QuickBooks cash flow/aging and currency display, are built and verified against real data. Remaining items:

1. **Going live with QuickBooks in production** (rather than sandbox) needs a public HTTPS redirect URL and Intuit app review.
2. Everything currently runs as a single local user with file-based token storage (`.qbo-tokens.json`) — fine for one person's own use, but would need real per-user accounts and a database before sharing this with other accountants.
3. Report parsing (`sumGroupTotals`, `sumMatchingLabels`, `parseAgingOver90` in `lib/quickbooks.js`) has been validated against one real sandbox company's chart of accounts. A different company's account naming or structure could still surface edge cases — use `GET /api/quickbooks/financials/raw` to compare the parsed output against the untouched report JSON if something looks off.
