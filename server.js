require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const qbo = require("./lib/quickbooks");
const pdf = require("./lib/pdf");

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ---------------------------------------------------------------------------
// Basic auth
// This app has NO other login/access control. That's fine for local-only use
// where the only person who can reach localhost:3000 is you, but the moment
// this is deployed somewhere with a public URL, anyone who finds that URL
// could view a connected company's real financial data, generate narratives
// against your Anthropic API key, or disconnect/reconnect QuickBooks. Only
// enforced when both env vars are set, so local dev is unaffected — but set
// them before deploying anywhere reachable from the internet.
// ---------------------------------------------------------------------------
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;

if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === BASIC_AUTH_USER && pass === BASIC_AUTH_PASS) {
        return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Loan Readiness"');
    res.status(401).send("Authentication required.");
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// CSV intake
// Accepts any CSV export (trial balance, P&L, balance sheet, etc). Returns the
// raw columns + rows so the client can do the label/amount column selection
// and per-row bucket mapping. Deliberately does not assume a fixed schema —
// that mapping step is what makes this work with whatever an accountant's
// software exports.
// ---------------------------------------------------------------------------
app.post("/api/csv/parse", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }

  if (!records.length) {
    return res.status(400).json({ error: "CSV appears to be empty." });
  }

  const columns = Object.keys(records[0]);

  if (records.length > 2000) {
    return res.status(400).json({ error: "That CSV has more rows than expected for a financial statement export (max 2000)." });
  }

  res.json({ columns, rows: records });
});

// ---------------------------------------------------------------------------
// Narrative generation
// The original prototype called api.anthropic.com directly from the browser,
// which can't work without exposing a secret key client-side. This proxies
// the call server-side using ANTHROPIC_API_KEY from the environment.
// ---------------------------------------------------------------------------
app.post("/api/narrative", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in .env and restart." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || `Anthropic API returned ${response.status}`;
      return res.status(502).json({ error: message });
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      return res.status(502).json({ error: "Model returned an empty response." });
    }

    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: `Could not reach the drafting model: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// QuickBooks OAuth
// See lib/quickbooks.js for the full flow and a note on what's still rough
// (report parsing hasn't been validated against a live sandbox company).
// ---------------------------------------------------------------------------
let pendingOAuthState = null;

app.get("/api/quickbooks/status", (req, res) => {
  res.json({
    configured: qbo.isConfigured(),
    connected: qbo.isConnected()
  });
});

app.get("/api/quickbooks/connect", (req, res) => {
  if (!qbo.isConfigured()) {
    return res.status(500).json({ error: "Server is missing QBO_CLIENT_ID / QBO_CLIENT_SECRET. Set them in .env and restart. See README.md for how to get these from developer.intuit.com." });
  }
  pendingOAuthState = crypto.randomBytes(16).toString("hex");
  res.redirect(qbo.buildAuthorizeUrl(pendingOAuthState));
});

app.get("/api/quickbooks/callback", async (req, res) => {
  const { code, state, realmId, error } = req.query;

  if (error) {
    return res.redirect(`/?quickbooks=error&message=${encodeURIComponent(String(error))}`);
  }
  if (!state || state !== pendingOAuthState) {
    return res.redirect(`/?quickbooks=error&message=${encodeURIComponent("State mismatch — possible CSRF, try connecting again.")}`);
  }
  if (!code || !realmId) {
    return res.redirect(`/?quickbooks=error&message=${encodeURIComponent("Missing code or realmId from QuickBooks.")}`);
  }

  pendingOAuthState = null;

  try {
    await qbo.exchangeCodeForTokens(String(code), String(realmId));
    res.redirect("/?quickbooks=connected");
  } catch (err) {
    res.redirect(`/?quickbooks=error&message=${encodeURIComponent(err.message)}`);
  }
});

app.post("/api/quickbooks/disconnect", async (req, res) => {
  await qbo.disconnect();
  res.json({ ok: true });
});

app.get("/api/quickbooks/financials", async (req, res) => {
  if (!qbo.isConnected()) {
    return res.status(400).json({ error: "Not connected to QuickBooks yet." });
  }
  try {
    const data = await qbo.getFinancials();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Debug helper: returns the raw QBO report JSON so mismatches between what
// the parser extracted and the real P&L/Balance Sheet can be tracked down.
app.get("/api/quickbooks/financials/raw", async (req, res) => {
  if (!qbo.isConnected()) {
    return res.status(400).json({ error: "Not connected to QuickBooks yet." });
  }
  try {
    const data = await qbo.getRawReports();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PDF export
// Renders the Package view server-side via a local Chrome install (see
// lib/pdf.js) — not full puppeteer, so nothing gets downloaded at npm
// install time. Not yet tested against a real Chrome render (no browser
// binary available in the environment this was built in); the HTML template
// itself has been checked, but the actual PDF output should be spot-checked
// once run locally.
// ---------------------------------------------------------------------------
app.post("/api/package/pdf", async (req, res) => {
  const { name, requestedAmount, currencySymbol, pnl, ratios, flags, narrative } = req.body || {};
  if (!name || !pnl || !ratios || !flags) {
    return res.status(400).json({ error: "Missing package data." });
  }

  try {
    const html = pdf.buildPackageHtml({ name, requestedAmount, currencySymbol, pnl, ratios, flags, narrative });
    const buffer = await pdf.renderPdf(html);
    const safeName = String(name).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "loan-package";
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeName}-loan-package.pdf"`
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Loan-readiness app running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY not set — narrative generation will fail until it is.");
  }
  if (!qbo.isConfigured()) {
    console.warn("Note: QBO_CLIENT_ID / QBO_CLIENT_SECRET not set — QuickBooks connect will fail until they are (CSV upload and sample data still work).");
  }
  if (!pdf.findChrome()) {
    console.warn("Note: no local Chrome/Chromium/Edge install found — PDF export will fail until PUPPETEER_EXECUTABLE_PATH is set in .env.");
  }
});
