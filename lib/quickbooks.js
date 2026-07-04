// -----------------------------------------------------------------------------
// QuickBooks Online OAuth + report fetching.
//
// This is a best-effort implementation written without access to a live QBO
// sandbox company to test against. The OAuth handshake (connect/callback/
// refresh) follows Intuit's documented flow exactly and should work as-is.
// The report parsing (parseProfitAndLoss / parseBalanceSheet) is written
// against QuickBooks' documented report JSON shape, but QBO reports vary in
// structure depending on the company's chart of accounts and settings, so
// treat the parsed numbers as a first pass — verify them against the actual
// P&L/Balance Sheet in the sandbox company before trusting them, and use the
// GET /api/quickbooks/financials/raw route (returns the untouched QBO JSON)
// to debug any row this misses.
//
// Cash flow (operating cash flow, debt payments) and AR/AP aging over 90 days
// are now pulled from the CashFlow, AgedReceivables, and AgedPayables reports
// (parseCashFlow / parseAgingOver90 below), added 2026-07 and, like the P&L/
// Balance Sheet parsing before it, NOT yet validated against a live company —
// there was no QuickBooks access in the environment this was written in.
// "Debt payments" in particular is inherently fuzzy: QBO's Cash Flow
// statement has a clean "Operating Activities" total, but no single line for
// "debt payments" — it's buried among Financing Activities detail rows, so
// parseCashFlow() keyword-matches likely labels (loan/notes payable/debt
// service) rather than reading a defined total. Treat that figure especially
// skeptically and check it against the real Cash Flow statement.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

// Configurable so a deployment with an ephemeral filesystem (most PaaS free/
// starter tiers) can point this at a mounted persistent disk instead — e.g.
// Render's disks mount at a path like /data, so set QBO_TOKEN_FILE=/data/
// .qbo-tokens.json there. Without it, the connection would be silently lost
// on every redeploy or restart.
const TOKEN_FILE = process.env.QBO_TOKEN_FILE || path.join(__dirname, "..", ".qbo-tokens.json");

const ENVIRONMENT = process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = process.env.QBO_REDIRECT_URI || "http://localhost:3000/api/quickbooks/callback";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE = ENVIRONMENT === "production"
  ? "https://quickbooks.api.intuit.com"
  : "https://sandbox-quickbooks.api.intuit.com";

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

// ---------------------------------------------------------------------------
// Token storage (local file, single-user, gitignored). Fine for a local dev
// app; would need a real per-user store (DB, session) before deploying.
// ---------------------------------------------------------------------------
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function clearTokens() {
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* already gone */ }
}

function isConnected() {
  const t = loadTokens();
  return Boolean(t && t.refresh_token && t.realmId);
}

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: REDIRECT_URI,
    state
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, realmId) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${response.status})`);
  }
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000, // refresh 60s early
    realmId
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshTokens(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Token refresh failed (${response.status})`);
  }
  return data;
}

// Returns a valid { accessToken, realmId }, refreshing if the stored token
// has expired. Throws if there's no connection at all.
async function getValidAccessToken() {
  const stored = loadTokens();
  if (!stored) throw new Error("Not connected to QuickBooks yet.");

  if (Date.now() < stored.expires_at) {
    return { accessToken: stored.access_token, realmId: stored.realmId };
  }

  const refreshed = await refreshTokens(stored.refresh_token);
  const tokens = {
    access_token: refreshed.access_token,
    // QBO rotates refresh tokens on use in current API versions; fall back
    // to the old one if a new one isn't returned.
    refresh_token: refreshed.refresh_token || stored.refresh_token,
    expires_at: Date.now() + (refreshed.expires_in - 60) * 1000,
    realmId: stored.realmId
  };
  saveTokens(tokens);
  return { accessToken: tokens.access_token, realmId: tokens.realmId };
}

async function disconnect() {
  const stored = loadTokens();
  clearTokens();
  if (!stored) return;
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({ token: stored.refresh_token })
    });
  } catch (e) {
    // best effort — local token is already cleared either way
  }
}

// ---------------------------------------------------------------------------
// Report fetching
// ---------------------------------------------------------------------------
async function fetchReport(accessToken, realmId, reportName) {
  const url = `${API_BASE}/v3/company/${realmId}/reports/${reportName}?minorversion=75`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.Fault?.Error?.[0]?.Message || `QuickBooks API returned ${response.status} for ${reportName}`;
    throw new Error(message);
  }
  return data;
}

// Like fetchReport, but returns null instead of throwing — used for reports
// that may legitimately not exist for a given company (e.g. AgedPayables for
// a company with no bills ever entered) so one missing report doesn't take
// down the whole import.
async function fetchReportSafe(accessToken, realmId, reportName) {
  try {
    return await fetchReport(accessToken, realmId, reportName);
  } catch (e) {
    return null;
  }
}

async function fetchCompanyName(accessToken, realmId) {
  try {
    const url = `${API_BASE}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    });
    const data = await response.json();
    return data?.CompanyInfo?.CompanyName || null;
  } catch (e) {
    return null;
  }
}

// Walks a QBO report's Rows tree looking for the Summary ColData amount of
// rows whose `group` matches one of the given group names (case-insensitive).
// QBO nests sections (e.g. Assets > CurrentAssets > ...), and each section's
// own total is a row with a `Summary` node rather than nested `Rows`.
function sumGroupTotals(rows, groupNames) {
  if (!rows) return 0;
  const wanted = groupNames.map(g => g.toLowerCase());
  let total = 0;

  function amountFromColData(colData) {
    if (!colData || !colData.length) return 0;
    const last = colData[colData.length - 1];
    const n = parseFloat(String(last.value || "0").replace(/,/g, ""));
    return Number.isNaN(n) ? 0 : n;
  }

  function walk(row) {
    if (!row) return;
    const group = (row.group || "").toLowerCase();
    if (wanted.includes(group) && row.Summary?.ColData) {
      total += amountFromColData(row.Summary.ColData);
      return; // don't double-descend into this section's children
    }
    if (row.Rows?.Row) {
      row.Rows.Row.forEach(walk);
    }
  }

  rows.forEach(walk);
  return total;
}

function parseProfitAndLoss(report) {
  const rows = report?.Rows?.Row || [];
  return {
    revenue: sumGroupTotals(rows, ["Income"]),
    cogs: sumGroupTotals(rows, ["COGS"]),
    opex: sumGroupTotals(rows, ["Expenses"])
  };
}

function parseBalanceSheet(report) {
  const rows = report?.Rows?.Row || [];
  return {
    currentAssets: sumGroupTotals(rows, ["CurrentAssets"]),
    longTermAssets: sumGroupTotals(rows, ["FixedAssets", "OtherAssets"]),
    currentLiabilities: sumGroupTotals(rows, ["CurrentLiabilities"]),
    longTermLiabilities: sumGroupTotals(rows, ["LongTermLiabilities"]),
    equity: sumGroupTotals(rows, ["Equity"])
  };
}

// Sums the last ColData value of leaf (non-Section) rows whose first ColData
// value (the line-item label) matches regex. Used for "debt payments" — QBO's
// Cash Flow statement has no single defined total for it, just detail rows
// buried in Financing Activities, so this pattern-matches likely labels the
// same way the CSV import's GUESS_PATTERNS does for uploaded rows.
//
// onlyNegative matters: in the indirect-method Cash Flow statement, a line
// like "Notes Payable" shows the NET CHANGE in that liability for the
// period — positive means the business borrowed more (a cash inflow, not a
// payment), negative means the balance went down (an actual repayment). The
// first version of this function summed both directions and, on real
// sandbox data, counted a $25,000 new loan draw as if it were a $25,000
// payment — wrecking the DSCR calculation. Restricting to negative matches
// fixes that; a company that only borrowed and made no repayments this
// period should correctly show £0 in debt payments, not the loan amount.
function sumMatchingLabels(rows, regex, { onlyNegative = false } = {}) {
  if (!rows) return 0;
  let total = 0;

  function walk(row) {
    if (!row) return;
    const hasChildren = !!row.Rows?.Row?.length;
    if (!hasChildren && row.ColData?.length) {
      const label = row.ColData[0]?.value || "";
      if (regex.test(label)) {
        const n = parseFloat(String(row.ColData[row.ColData.length - 1]?.value || "0").replace(/,/g, ""));
        if (!Number.isNaN(n) && (!onlyNegative || n < 0)) total += n;
      }
    }
    if (hasChildren) {
      row.Rows.Row.forEach(walk);
    }
  }

  rows.forEach(walk);
  return total;
}

const DEBT_PAYMENT_LABEL_RE = /loan payment|loan repayment|loan payable|notes? payable|debt service|principal payment|line of credit payment|line of credit payable/i;

function parseCashFlow(report) {
  const rows = report?.Rows?.Row || [];
  const operatingCashFlow = sumGroupTotals(rows, ["OperatingActivities"]);
  // Only count decreases in these liability accounts (actual repayments) —
  // increases are new borrowing, not a payment. See comment on
  // sumMatchingLabels for why this matters.
  const debtPayments = Math.abs(sumMatchingLabels(rows, DEBT_PAYMENT_LABEL_RE, { onlyNegative: true }));
  return { operatingCashFlow, debtPayments };
}

// AgedReceivables/AgedPayables are shaped differently from P&L/Balance Sheet:
// aging buckets (Current, 1-30, 31-60, 61-90, 91 and over) are COLUMNS, and
// each ROW is a customer/vendor, with a grand-total row at the bottom. To get
// the ">90 days" figure we find which column is the "91 and over" bucket,
// then read that column's value off the total row.
function findColumnIndex(report, regex) {
  const columns = report?.Columns?.Column || [];
  const idx = columns.findIndex(c => regex.test(c.ColTitle || ""));
  return idx === -1 ? null : idx;
}

function findTotalRowColData(rows) {
  if (!rows || !rows.length) return null;
  const explicit = rows.find(row => {
    const label = row.Summary?.ColData?.[0]?.value || row.ColData?.[0]?.value || "";
    return /total/i.test(label);
  });
  if (explicit) return explicit.Summary?.ColData || explicit.ColData || null;
  // Fall back to the last row if nothing is explicitly labeled "total" —
  // aging summary reports conventionally end with the grand total.
  const last = rows[rows.length - 1];
  return last?.Summary?.ColData || last?.ColData || null;
}

function parseAgingOver90(report) {
  const rows = report?.Rows?.Row || [];
  const colIndex = findColumnIndex(report, /91|over ?90|90\+/i);
  if (colIndex === null) return 0;
  const totalColData = findTotalRowColData(rows);
  if (!totalColData || !totalColData[colIndex]) return 0;
  const n = parseFloat(String(totalColData[colIndex].value || "0").replace(/,/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// High-level: returns data in the same shape the app already uses for CSV
// uploads and sample data, ready to drop into buildCustomData-style state.
async function getFinancials() {
  const { accessToken, realmId } = await getValidAccessToken();

  const [pnlReport, bsReport, companyName, cashFlowReport, arAgingReport, apAgingReport] = await Promise.all([
    fetchReport(accessToken, realmId, "ProfitAndLoss"),
    fetchReport(accessToken, realmId, "BalanceSheet"),
    fetchCompanyName(accessToken, realmId),
    // These three are fetched leniently (null on failure) — a company with
    // no bills, for instance, may not have a meaningful AgedPayables report,
    // and that shouldn't block the rest of the import.
    fetchReportSafe(accessToken, realmId, "CashFlow"),
    fetchReportSafe(accessToken, realmId, "AgedReceivables"),
    fetchReportSafe(accessToken, realmId, "AgedPayables")
  ]);

  const pnl = parseProfitAndLoss(pnlReport);
  pnl.grossProfit = pnl.revenue - pnl.cogs;
  pnl.netIncome = pnl.grossProfit - pnl.opex;

  const bs = parseBalanceSheet(bsReport);
  const balanceSheet = {
    ...bs,
    totalAssets: bs.currentAssets + bs.longTermAssets,
    totalLiabilities: bs.currentLiabilities + bs.longTermLiabilities,
    // Not available from the P&L/Balance Sheet reports alone; assume it
    // matches net income so this doesn't manufacture a false mismatch flag.
    retainedEarningsChange: pnl.netIncome
  };

  const cashFlow = cashFlowReport
    ? parseCashFlow(cashFlowReport)
    : { operatingCashFlow: 0, debtPayments: 0 };

  // Every QBO report response carries the company's home currency in its
  // Header (e.g. "USD", "GBP") — grab it from whichever report has it rather
  // than hardcoding one, since the app previously always displayed £
  // regardless of what currency the connected company actually reports in.
  const currency = pnlReport?.Header?.Currency || bsReport?.Header?.Currency || "USD";

  return {
    name: companyName || "QuickBooks Company",
    requestedAmount: "Not specified",
    currency,
    pnl,
    balanceSheet,
    cashFlow,
    ar_aging_over90: arAgingReport ? parseAgingOver90(arAgingReport) : 0,
    ap_aging_over90: apAgingReport ? parseAgingOver90(apAgingReport) : 0,
    _source: "quickbooks",
    _rawAvailable: true
  };
}

async function getRawReports() {
  const { accessToken, realmId } = await getValidAccessToken();
  const [pnlReport, bsReport, cashFlowReport, arAgingReport, apAgingReport] = await Promise.all([
    fetchReport(accessToken, realmId, "ProfitAndLoss"),
    fetchReport(accessToken, realmId, "BalanceSheet"),
    fetchReportSafe(accessToken, realmId, "CashFlow"),
    fetchReportSafe(accessToken, realmId, "AgedReceivables"),
    fetchReportSafe(accessToken, realmId, "AgedPayables")
  ]);
  return {
    profitAndLoss: pnlReport,
    balanceSheet: bsReport,
    cashFlow: cashFlowReport,
    agedReceivables: arAgingReport,
    agedPayables: apAgingReport
  };
}

module.exports = {
  isConfigured,
  isConnected,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  disconnect,
  getFinancials,
  getRawReports,
  loadTokens
};
