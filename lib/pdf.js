// -----------------------------------------------------------------------------
// PDF export for the final lender package.
//
// Uses puppeteer-core (no bundled browser download — it drives whatever Chrome
// is already installed on the machine) rather than full puppeteer, which
// downloads its own ~200MB Chromium. That download failed outright in the
// sandbox this was built in (no network route to storage.googleapis.com), and
// even where it succeeds it's a slow, heavy first install for what should be
// a small local tool. Since every dev machine running this app already has a
// browser installed, puppeteer-core + auto-detecting that browser is the
// lighter path.
//
// NOT YET TESTED against a real render — this sandbox has no Chrome/Chromium
// binary at all, so the HTML->PDF step itself (as opposed to the HTML
// generation, which is plain string building) could not be run end-to-end
// here. Try it locally; if `findChrome()` doesn't locate your browser, set
// PUPPETEER_EXECUTABLE_PATH in .env to its exact path.
// -----------------------------------------------------------------------------

const fs = require("fs");

const CANDIDATE_PATHS = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return CANDIDATE_PATHS.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (e) {
      return false;
    }
  }) || null;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmt(n, currencySymbol) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return (currencySymbol || "£") + Math.round(n).toLocaleString("en-GB");
}

function stampLabel(sev) {
  if (sev === "critical") return "Flagged";
  if (sev === "medium") return "Review";
  return "Clear";
}

function stampColor(sev) {
  if (sev === "critical") return "#DC2626";
  if (sev === "medium") return "#D97706";
  return "#16A34A";
}

// data: { name, requestedAmount, pnl, balanceSheet, cashFlow, ar_aging_over90,
//         ap_aging_over90, flags, ratios, narrative }
// This mirrors the .lr-doc markup/styling in public/css/style.css so the PDF
// matches what's shown on the Package screen (modern/clean palette).
function buildPackageHtml(data) {
  const { name, requestedAmount, currencySymbol, pnl, ratios, flags, narrative } = data;

  const dscrText = ratios.dscr === null || ratios.dscr === undefined ? "n/a" : `${Number(ratios.dscr).toFixed(2)}x`;
  const currentRatioText = ratios.currentRatio === null || ratios.currentRatio === undefined ? "n/a" : Number(ratios.currentRatio).toFixed(2);

  const flagsHtml = flags.map(f => `
    <li>
      <span style="display:inline-block; font-family:'Inter',sans-serif; font-size:9px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; padding:3px 9px; background:${stampColor(f.severity)}; color:#fff; border-radius:999px; margin-right:8px;">${stampLabel(f.severity)}</span>
      <span>${escapeHtml(f.text)}</span>
    </li>
  `).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700;800&display=swap');
  * { box-sizing: border-box; }
  @page { size: A4; margin: 0; }
  html, body { height: auto; }
  body {
    font-family: 'Inter', sans-serif;
    color: #0F172A;
    background: #F8FAFC;
    margin: 0;
    /* Puppeteer's own page.pdf() margin option is set to 0 — all spacing is
       controlled here so it isn't doubled up (that doubling previously
       pushed the footnote onto an otherwise-empty second page). */
    padding: 22px;
  }
  .doc {
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 10px;
    padding: 28px 32px;
  }
  .header { text-align: center; border-bottom: 1px solid #E2E8F0; padding-bottom: 14px; margin-bottom: 16px; }
  .header h1 { font-family: 'Inter', sans-serif; font-weight: 800; font-size: 20px; margin: 0 0 4px; letter-spacing: -0.3px; }
  .header p { font-family: 'Inter', sans-serif; font-weight: 600; font-size: 11px; color: #64748B; margin: 0; letter-spacing: 0.8px; text-transform: uppercase; }
  .kpigrid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 18px; }
  .kpi { text-align: center; padding: 10px 6px; border: 1px solid #E2E8F0; border-radius: 8px; background: #F8FAFC; }
  .kpi .num { font-family: 'IBM Plex Mono', monospace; font-size: 19px; font-weight: 600; }
  .kpi .lbl { font-size: 10px; color: #64748B; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 4px; }
  .section h2 { font-family: 'Inter', sans-serif; font-weight: 700; font-size: 14px; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px; margin: 14px 0 8px; }
  .narrative { font-family: 'Inter', sans-serif; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; }
  .flaglist { list-style: none; padding: 0; margin: 0; font-size: 12.5px; }
  .flaglist li { padding: 4px 0; }
  .footnote { margin-top: 16px; font-size: 10.5px; color: #64748B; text-align: center; }
</style>
</head>
<body>
  <div class="doc">
    <div class="header">
      <h1>${escapeHtml(name)}</h1>
      <p>Lender submission package — requested ${escapeHtml(requestedAmount)}</p>
    </div>

    <div class="kpigrid">
      <div class="kpi"><div class="num">${fmt(pnl.netIncome, currencySymbol)}</div><div class="lbl">Net income</div></div>
      <div class="kpi"><div class="num">${dscrText}</div><div class="lbl">DSCR</div></div>
      <div class="kpi"><div class="num">${currentRatioText}</div><div class="lbl">Current ratio</div></div>
    </div>

    <div class="section">
      <h2>Narrative Summary</h2>
      <div class="narrative">${escapeHtml(narrative || "(no narrative generated)")}</div>
    </div>

    <div class="section">
      <h2>Reviewed Items</h2>
      <ul class="flaglist">${flagsHtml}</ul>
    </div>
  </div>
  <div class="footnote">Generated by the loan-readiness pipeline — figures reflect the data provided at the time of generation.</div>
</body>
</html>`;
}

async function renderPdf(html) {
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      "Couldn't find a local Chrome/Chromium/Edge install to render the PDF. " +
      "Set PUPPETEER_EXECUTABLE_PATH in .env to your browser's executable path and restart the server."
    );
  }

  // Required lazily so the app still boots if puppeteer-core somehow isn't
  // installed (e.g. someone deletes node_modules partially) — every other
  // route keeps working.
  const puppeteer = require("puppeteer-core");

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // No margin here — the HTML template's own body padding provides the
      // visual margin. Setting both doubles up the spacing, which is what
      // pushed content onto a near-empty second page previously.
      margin: { top: "0px", bottom: "0px", left: "0px", right: "0px" }
    });
    // Newer Puppeteer versions return a plain Uint8Array here, not a Node
    // Buffer. Express's res.send() only writes raw bytes for a real Buffer —
    // anything else object-shaped silently falls through to res.json(),
    // which JSON-serializes the byte array instead of sending binary PDF
    // data. Wrapping in Buffer.from() guarantees Buffer.isBuffer() is true.
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

module.exports = { buildPackageHtml, renderPdf, findChrome };
