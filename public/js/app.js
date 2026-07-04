(function () {

  // ---------------------------------------------------------------------
  // Sample data (kept for demoing without a CSV on hand)
  // ---------------------------------------------------------------------
  const SAMPLES = {
    bakery: {
      name: "Harlow & Vale Bakery Co.",
      blurb: "3-location artisan bakery, steady revenue, one flagged inconsistency.",
      requestedAmount: "£85,000",
      pnl: { revenue: 612000, cogs: 268000, grossProfit: 344000, opex: 279500, netIncome: 64500 },
      balanceSheet: {
        currentAssets: 118000, longTermAssets: 210000, totalAssets: 328000,
        currentLiabilities: 96000, longTermLiabilities: 140000, totalLiabilities: 236000,
        equity: 88000, retainedEarningsChange: 51000
      },
      cashFlow: { operatingCashFlow: 71000, debtPayments: 22000 },
      ar_aging_over90: 4200,
      ap_aging_over90: 1800
    },
    studio: {
      name: "Kestrel Design Studio Ltd.",
      blurb: "Boutique design agency, thin equity, two flagged issues.",
      requestedAmount: "£40,000",
      pnl: { revenue: 289000, cogs: 96000, grossProfit: 193000, opex: 171000, netIncome: 22000 },
      balanceSheet: {
        currentAssets: 41000, longTermAssets: 38000, totalAssets: 79000,
        currentLiabilities: 46000, longTermLiabilities: 22000, totalLiabilities: 68000,
        equity: 11000, retainedEarningsChange: 15500
      },
      cashFlow: { operatingCashFlow: 18500, debtPayments: 14000 },
      ar_aging_over90: 11400,
      ap_aging_over90: 8600
    }
  };

  // ---------------------------------------------------------------------
  // CSV mapping buckets
  // ---------------------------------------------------------------------
  const BUCKETS = [
    { key: "ignore", label: "Ignore" },
    { key: "revenue", label: "P&L → Revenue", group: "required" },
    { key: "cogs", label: "P&L → Cost of goods sold", group: "required" },
    { key: "opex", label: "P&L → Operating expenses", group: "required" },
    { key: "currentAssets", label: "Balance sheet → Current assets", group: "required" },
    { key: "longTermAssets", label: "Balance sheet → Long-term assets", group: "required" },
    { key: "currentLiabilities", label: "Balance sheet → Current liabilities", group: "required" },
    { key: "longTermLiabilities", label: "Balance sheet → Long-term liabilities", group: "required" },
    { key: "equity", label: "Balance sheet → Owner's equity", group: "required" },
    { key: "retainedEarningsChange", label: "Balance sheet → Change in retained earnings" },
    { key: "operatingCashFlow", label: "Cash flow → Operating cash flow" },
    { key: "debtPayments", label: "Cash flow → Debt payments" },
    { key: "ar_aging_over90", label: "Aging → AR over 90 days" },
    { key: "ap_aging_over90", label: "Aging → AP over 90 days" }
  ];
  const REQUIRED_BUCKETS = BUCKETS.filter(b => b.group === "required").map(b => b.key);

  const GUESS_PATTERNS = [
    { key: "revenue", re: /revenue|sales|total income/i },
    { key: "cogs", re: /cost of goods|cogs|cost of sales/i },
    { key: "opex", re: /operating expense|opex|total expense/i },
    { key: "currentAssets", re: /current asset/i },
    { key: "longTermAssets", re: /fixed asset|long-?term asset|non-?current asset/i },
    { key: "currentLiabilities", re: /current liabilit/i },
    { key: "longTermLiabilities", re: /long-?term liabilit|non-?current liabilit/i },
    { key: "equity", re: /owner'?s? equity|shareholder'?s? equity|^equity$/i },
    { key: "retainedEarningsChange", re: /retained earnings/i },
    { key: "operatingCashFlow", re: /operating cash flow/i },
    { key: "debtPayments", re: /debt payment|loan payment/i },
    { key: "ar_aging_over90", re: /(accounts receivable|\bar\b).*90/i },
    { key: "ap_aging_over90", re: /(accounts payable|\bap\b).*90/i }
  ];

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let state = {
    step: 1,
    activeSource: null,   // 'sample' | 'upload'
    sampleKey: null,
    businessName: "",
    requestedAmount: "",
    customData: null,
    // £ for samples/CSV (no currency metadata available for either); set
    // from the connected company's actual currency on QuickBooks import.
    currencySymbol: "£",
    upload: { status: "idle" }, // idle | parsing | columns | mapping | confirmed | error
    quickbooks: {
      configured: false,
      connected: false,
      importStatus: "idle", // idle | loading | done | error
      error: null
    },
    narrative: "",
    narrativeStatus: "idle", // idle | loading | done | error
    pdfStatus: "idle" // idle | loading | error
  };

  const TABS = [
    { id: 1, label: "Intake" },
    { id: 2, label: "Review" },
    { id: 3, label: "Narrative" },
    { id: 4, label: "Package" }
  ];

  // ISO currency code -> display symbol, used for QuickBooks-sourced data
  // (the company's actual currency comes back from the API). Falls back to
  // "CODE " (e.g. "CHF ") for anything not in this short list rather than
  // guessing wrong.
  const CURRENCY_SYMBOLS = {
    USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AUD: "A$", NZD: "NZ$", JPY: "¥"
  };

  function symbolForCurrencyCode(code) {
    if (!code) return "£";
    return CURRENCY_SYMBOLS[code] || `${code} `;
  }

  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return state.currencySymbol + Math.round(n).toLocaleString("en-GB");
  }

  function safeDiv(a, b) {
    return b > 0 ? a / b : null;
  }

  function getActiveData() {
    if (state.activeSource === "sample" && state.sampleKey) return SAMPLES[state.sampleKey];
    if ((state.activeSource === "upload" || state.activeSource === "quickbooks") && state.customData) return state.customData;
    return null;
  }

  // ---------------------------------------------------------------------
  // Amount parsing for CSV cells: handles "$1,234.56", "(1,234.56)", "1234.56-", "-"
  // ---------------------------------------------------------------------
  function parseAmount(raw) {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim();
    if (s === "" || s === "-" || s === "—") return NaN;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }
    if (/^-/.test(s)) { negative = true; s = s.slice(1); }
    s = s.replace(/[^0-9.]/g, "");
    if (s === "") return NaN;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return NaN;
    return negative ? -n : n;
  }

  function guessColumns(columns, rows) {
    let bestAmountCol = null, bestScore = -1;
    columns.forEach(col => {
      let score = 0;
      rows.forEach(r => { if (!Number.isNaN(parseAmount(r[col]))) score++; });
      if (score > bestScore) { bestScore = score; bestAmountCol = col; }
    });
    const labelCol = columns.find(c => c !== bestAmountCol) || columns[0];
    return { labelCol, amountCol: bestScore > 0 ? bestAmountCol : columns[columns.length - 1] };
  }

  function guessBucket(label) {
    if (!label) return "ignore";
    const match = GUESS_PATTERNS.find(p => p.re.test(label));
    return match ? match.key : "ignore";
  }

  // ---------------------------------------------------------------------
  // Consistency checks (unchanged logic from the prototype, made null-safe)
  // ---------------------------------------------------------------------
  function computeFlags(d) {
    const flags = [];
    const bs = d.balanceSheet;
    const calcTotalAssets = bs.currentAssets + bs.longTermAssets;
    const calcTotalLiabEquity = bs.totalLiabilities + bs.equity;

    if (Math.abs(calcTotalAssets - calcTotalLiabEquity) > 500) {
      flags.push({ severity: "critical", text: `Balance sheet does not balance — assets total ${fmt(calcTotalAssets)} vs liabilities + equity ${fmt(calcTotalLiabEquity)}.` });
    }

    if (Math.abs(d.pnl.netIncome - bs.retainedEarningsChange) > 2000) {
      flags.push({ severity: "medium", text: `Net income (${fmt(d.pnl.netIncome)}) doesn't match the change in retained earnings (${fmt(bs.retainedEarningsChange)}) — worth a note before submission.` });
    }

    const currentRatio = safeDiv(bs.currentAssets, bs.currentLiabilities);
    if (currentRatio !== null && currentRatio < 1.2) {
      flags.push({ severity: currentRatio < 1 ? "critical" : "medium", text: `Current ratio is ${currentRatio.toFixed(2)} — ${currentRatio < 1 ? "below 1, a real liquidity concern to lenders." : "on the thin side; lenders may ask about short-term liquidity."}` });
    }

    const equityRatio = safeDiv(bs.equity, calcTotalAssets);
    if (equityRatio !== null && equityRatio < 0.2) {
      flags.push({ severity: "medium", text: `Equity is only ${(equityRatio * 100).toFixed(1)}% of total assets — thin equity cushion, lenders will scrutinize leverage.` });
    }

    if (d.ar_aging_over90 > 8000) {
      flags.push({ severity: "medium", text: `${fmt(d.ar_aging_over90)} in receivables is over 90 days late — signals possible collection risk.` });
    }

    if (flags.length === 0) {
      flags.push({ severity: "clear", text: "No structural inconsistencies found across the statements provided." });
    }

    const dscr = safeDiv(d.cashFlow.operatingCashFlow, d.cashFlow.debtPayments);

    return { flags, ratios: { currentRatio, equityRatio, dscr } };
  }

  function stampFor(sev) {
    if (sev === "critical") return `<span class="lr-stamp critical">Flagged</span>`;
    if (sev === "medium") return `<span class="lr-stamp medium">Review</span>`;
    return `<span class="lr-stamp clear">Clear</span>`;
  }

  // ---------------------------------------------------------------------
  // Tabs / meta
  // ---------------------------------------------------------------------
  function renderTabs() {
    const el = document.getElementById("lr-tabs");
    const unlocked = !!getActiveData();
    el.innerHTML = TABS.map(t => {
      const locked = t.id > 1 && !unlocked;
      const active = state.step === t.id;
      return `<div class="lr-tab ${active ? 'active' : ''} ${locked ? 'locked' : ''}" data-step="${t.id}">
        <span class="lr-tabnum">0${t.id}</span> ${t.label}
      </div>`;
    }).join("");
    [...el.querySelectorAll(".lr-tab")].forEach(node => {
      node.addEventListener("click", () => {
        const step = parseInt(node.dataset.step, 10);
        if (step > 1 && !getActiveData()) return;
        state.step = step;
        renderPanel();
      });
    });
  }

  function renderMeta() {
    const meta = document.getElementById("lr-case-meta");
    const d = getActiveData();
    if (!d) {
      meta.innerHTML = "File No. &mdash;<br/>Opened &mdash;";
    } else {
      const tag = state.activeSource === "sample" ? state.sampleKey.toUpperCase()
        : state.activeSource === "quickbooks" ? "QBO" : "UPL";
      meta.innerHTML = `File No. LR-${tag}-01<br/>Requested: ${d.requestedAmount}`;
    }
  }

  // ---------------------------------------------------------------------
  // Step 1: Intake (samples + CSV upload/mapping)
  // ---------------------------------------------------------------------
  function renderIntake() {
    return `
      <div class="lr-intro">Load a client's financials to generate a lender-ready package: consistency checks, key ratios, and an AI-drafted summary narrative — the same prep an accountant does by hand, in minutes instead of hours.</div>

      <div class="lr-samplegrid">
        ${Object.entries(SAMPLES).map(([key, d]) => `
          <div class="lr-samplecard ${state.activeSource === 'sample' && state.sampleKey === key ? 'selected' : ''}" data-key="${key}">
            <h4>${d.name}</h4>
            <p>${d.blurb}</p>
            <div class="lr-samplemeta">
              <span>REV ${fmt(d.pnl.revenue)}</span>
              <span>ASK ${d.requestedAmount}</span>
            </div>
          </div>
        `).join("")}
      </div>

      <div class="lr-orbreak">or upload your own financials</div>

      <div class="lr-fieldrow">
        <div class="lr-field">
          <label>Business name</label>
          <input type="text" id="lr-business-name" value="${escapeHtml(state.businessName)}" placeholder="e.g. Harlow & Vale Bakery Co." />
        </div>
        <div class="lr-field">
          <label>Requested loan amount</label>
          <input type="text" id="lr-requested-amount" value="${escapeHtml(state.requestedAmount)}" placeholder="e.g. £85,000" />
        </div>
      </div>

      ${renderUploadSection()}

      <div class="lr-orbreak">or connect QuickBooks</div>

      ${renderQuickbooksSection()}

      <div class="lr-actionrow">
        <button class="lr-btn" id="lr-intake-continue" ${!getActiveData() ? 'disabled' : ''}>Run consistency checks →</button>
      </div>
    `;
  }

  function renderQuickbooksSection() {
    const qb = state.quickbooks;

    if (!qb.configured) {
      return `<div class="lr-intro" style="margin:0;">Not set up yet — add <code>QBO_CLIENT_ID</code> / <code>QBO_CLIENT_SECRET</code> to <code>.env</code> and restart the server. See README.md.</div>`;
    }

    if (!qb.connected) {
      return `
        <div class="lr-actionrow" style="justify-content:flex-start; margin-top:0;">
          <button class="lr-btn secondary small" id="lr-qbo-connect">Connect QuickBooks</button>
        </div>
        ${qb.error ? `<div class="lr-error">${escapeHtml(qb.error)}</div>` : ""}
      `;
    }

    if (qb.importStatus === "loading") {
      return `<div class="lr-intro" style="margin:0;">Pulling P&amp;L and Balance Sheet from QuickBooks…</div>`;
    }

    if (qb.importStatus === "done" && state.activeSource === "quickbooks") {
      return `
        <div class="lr-summarycell" style="border-color:var(--blue); margin-bottom:12px;">
          <div class="lbl">Imported from QuickBooks</div>
          <div class="val" style="font-size:14px;">${escapeHtml(state.customData.name)}</div>
        </div>
        <div class="lr-actionrow" style="justify-content:flex-start; margin-top:0;">
          <button class="lr-btn secondary small" id="lr-qbo-reimport">Re-import</button>
          <button class="lr-btn secondary small" id="lr-qbo-disconnect">Disconnect</button>
        </div>
        <div class="lr-error" style="background:none; border:none; color:var(--ink-soft); padding:10px 0 0;">Cash flow and AR/AP aging aren't pulled from QuickBooks yet — those show as 0 until Phase 2's remaining report wiring is finished. Edit the CSV path above if you need those figures now.</div>
      `;
    }

    return `
      <div class="lr-actionrow" style="justify-content:flex-start; margin-top:0;">
        <button class="lr-btn secondary small" id="lr-qbo-import">Connected — import financials</button>
        <button class="lr-btn secondary small" id="lr-qbo-disconnect">Disconnect</button>
      </div>
      ${qb.importStatus === "error" ? `<div class="lr-error">${escapeHtml(qb.error)}</div>` : ""}
    `;
  }

  function renderUploadSection() {
    const u = state.upload;

    if (u.status === "idle" || u.status === "error") {
      return `
        <div class="lr-dropzone" id="lr-dropzone">
          <p><strong>Click to choose a CSV</strong>, or drag one here.</p>
          <p>Any export works — trial balance, P&amp;L, balance sheet. You'll map rows to statement lines next.</p>
          <input type="file" id="lr-fileinput" accept=".csv,text/csv" />
        </div>
        ${u.status === "error" ? `<div class="lr-error">${escapeHtml(u.error)}</div>` : ""}
      `;
    }

    if (u.status === "parsing") {
      return `<div class="lr-dropzone">Parsing CSV…</div>`;
    }

    if (u.status === "columns") {
      return `
        <div class="lr-mapwrap">
          <div class="lr-sectiontitle" style="border:none; margin-bottom:14px;">Which columns hold the line item and the amount?</div>
          <div class="lr-fieldrow">
            <div class="lr-field">
              <label>Line item / account column</label>
              <select id="lr-labelcol">
                ${u.columns.map(c => `<option value="${escapeHtml(c)}" ${c === u.labelCol ? 'selected' : ''}>${escapeHtml(c)}</option>`).join("")}
              </select>
            </div>
            <div class="lr-field">
              <label>Amount column</label>
              <select id="lr-amountcol">
                ${u.columns.map(c => `<option value="${escapeHtml(c)}" ${c === u.amountCol ? 'selected' : ''}>${escapeHtml(c)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="lr-actionrow" style="margin-top:16px;">
            <button class="lr-btn secondary small" id="lr-upload-restart">Choose a different file</button>
            <button class="lr-btn small" id="lr-confirm-columns">Continue to mapping →</button>
          </div>
        </div>
      `;
    }

    if (u.status === "mapping") {
      return renderMappingTable();
    }

    if (u.status === "confirmed" && state.activeSource === "upload") {
      const d = state.customData;
      return `
        <div class="lr-mapwrap">
          <div class="lr-summarycell" style="border-color:var(--blue);">
            <div class="lbl">Using uploaded data</div>
            <div class="val" style="font-size:14px;">${escapeHtml(d.name)} — ${u.rows.length} rows, ${countMapped()} mapped</div>
          </div>
          <div class="lr-actionrow" style="justify-content:flex-start; margin-top:14px;">
            <button class="lr-btn secondary small" id="lr-edit-mapping">Edit mapping</button>
            <button class="lr-btn secondary small" id="lr-upload-restart">Start over with a new file</button>
          </div>
        </div>
      `;
    }

    if (u.status === "confirmed") {
      return `<button class="lr-btn secondary small" id="lr-upload-restart">Use CSV data instead</button>`;
    }

    return "";
  }

  function countMapped() {
    return state.upload.mapping.filter(b => b !== "ignore").length;
  }

  function renderMappingTable() {
    const u = state.upload;
    const missing = REQUIRED_BUCKETS.filter(key => !u.mapping.includes(key));

    return `
      <div class="lr-mapwrap">
        <div class="lr-intro" style="margin-bottom:14px;">
          Assign each row to a statement line, or leave it "Ignore" — useful for subtotal/total rows so nothing gets double-counted. Multiple rows can map to the same line; amounts are summed.
        </div>
        <div class="lr-scrollbox">
          <table class="lr-maptable">
            <thead><tr><th>${escapeHtml(u.labelCol)}</th><th style="text-align:right;">${escapeHtml(u.amountCol)}</th><th>Maps to</th></tr></thead>
            <tbody id="lr-map-rows">
              ${u.rows.map((r, i) => renderMapRow(r, i)).join("")}
            </tbody>
          </table>
        </div>
        <div id="lr-summary-wrap">${renderSummaryGrid()}</div>
        ${missing.length ? `<div class="lr-error" id="lr-missing-note">Still need at least one row mapped to: ${missing.map(k => BUCKETS.find(b => b.key === k).label).join(", ")}.</div>` : ""}
        <div class="lr-actionrow">
          <button class="lr-btn secondary small" id="lr-upload-restart">Choose a different file</button>
          <button class="lr-btn" id="lr-use-data" ${missing.length ? 'disabled' : ''}>Use this data →</button>
        </div>
      </div>
    `;
  }

  function renderMapRow(r, i) {
    const u = state.upload;
    const amount = parseAmount(r[u.amountCol]);
    const bucket = u.mapping[i];
    return `
      <tr class="${bucket !== 'ignore' ? 'mapped' : ''}" data-row="${i}">
        <td>${escapeHtml(r[u.labelCol] ?? "")}</td>
        <td class="num">${Number.isNaN(amount) ? "—" : fmt(amount)}</td>
        <td>
          <select class="lr-bucket-select" data-row="${i}">
            ${BUCKETS.map(b => `<option value="${b.key}" ${b.key === bucket ? 'selected' : ''}>${b.label}</option>`).join("")}
          </select>
        </td>
      </tr>
    `;
  }

  function computeBucketSums() {
    const u = state.upload;
    const sums = {};
    BUCKETS.forEach(b => { sums[b.key] = 0; });
    u.rows.forEach((r, i) => {
      const bucket = u.mapping[i];
      if (bucket === "ignore") return;
      const amount = parseAmount(r[u.amountCol]);
      if (!Number.isNaN(amount)) sums[bucket] += amount;
    });
    return sums;
  }

  function renderSummaryGrid() {
    const sums = computeBucketSums();
    const shown = BUCKETS.filter(b => b.key !== "ignore");
    return `
      <div class="lr-summarygrid">
        ${shown.map(b => `
          <div class="lr-summarycell ${sums[b.key] === 0 ? 'unset' : ''}">
            <div class="lbl">${b.label.replace(/^.*→\s*/, "")}</div>
            <div class="val">${fmt(sums[b.key])}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function buildCustomData() {
    const sums = computeBucketSums();
    const pnl = {
      revenue: sums.revenue,
      cogs: sums.cogs,
      opex: sums.opex
    };
    pnl.grossProfit = pnl.revenue - pnl.cogs;
    pnl.netIncome = pnl.grossProfit - pnl.opex;

    const balanceSheet = {
      currentAssets: sums.currentAssets,
      longTermAssets: sums.longTermAssets,
      totalAssets: sums.currentAssets + sums.longTermAssets,
      currentLiabilities: sums.currentLiabilities,
      longTermLiabilities: sums.longTermLiabilities,
      totalLiabilities: sums.currentLiabilities + sums.longTermLiabilities,
      equity: sums.equity,
      // If not mapped, assume it matches net income so an unmapped field doesn't
      // manufacture a false "doesn't match retained earnings" flag.
      retainedEarningsChange: countRowsFor("retainedEarningsChange") ? sums.retainedEarningsChange : pnl.netIncome
    };

    const cashFlow = {
      operatingCashFlow: sums.operatingCashFlow,
      debtPayments: sums.debtPayments
    };

    return {
      name: state.businessName.trim() || "Uploaded Financials",
      requestedAmount: state.requestedAmount.trim() || "Not specified",
      pnl,
      balanceSheet,
      cashFlow,
      ar_aging_over90: sums.ar_aging_over90,
      ap_aging_over90: sums.ap_aging_over90
    };
  }

  function countRowsFor(bucketKey) {
    return state.upload.mapping.filter(b => b === bucketKey).length;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function handleFile(file) {
    if (!file) return;
    state.upload = { status: "parsing" };
    renderPanel();

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/csv/parse", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not parse that file.");

      const { labelCol, amountCol } = guessColumns(data.columns, data.rows);
      const mapping = data.rows.map(r => guessBucket(r[labelCol]));

      state.upload = {
        status: "columns",
        columns: data.columns,
        rows: data.rows,
        labelCol,
        amountCol,
        mapping
      };
    } catch (err) {
      state.upload = { status: "error", error: err.message };
    }
    renderPanel();
  }

  // ---------------------------------------------------------------------
  // Step 2: Review
  // ---------------------------------------------------------------------
  function renderReview() {
    const d = getActiveData();
    const { flags, ratios } = computeFlags(d);
    state._flags = flags;
    state._ratios = ratios;
    state._data = d;

    const ratioCell = (val, cls) => val === null ? `<span class="val">n/a</span>` : `<span class="val ${cls}">${val}</span>`;

    return `
      <div class="lr-review">
        <div>
          <div class="lr-sectiontitle">Profit &amp; Loss <span class="tag">FY current</span></div>
          <table class="lr-ledger">
            <tr><td>Revenue</td><td class="num">${fmt(d.pnl.revenue)}</td></tr>
            <tr><td>Cost of goods sold</td><td class="num">(${fmt(d.pnl.cogs)})</td></tr>
            <tr><td>Gross profit</td><td class="num">${fmt(d.pnl.grossProfit)}</td></tr>
            <tr><td>Operating expenses</td><td class="num">(${fmt(d.pnl.opex)})</td></tr>
            <tr class="total"><td>Net income</td><td class="num">${fmt(d.pnl.netIncome)}</td></tr>
          </table>

          <div class="lr-sectiontitle">Balance Sheet <span class="tag">as of period end</span></div>
          <table class="lr-ledger">
            <tr><td>Current assets</td><td class="num">${fmt(d.balanceSheet.currentAssets)}</td></tr>
            <tr><td>Long-term assets</td><td class="num">${fmt(d.balanceSheet.longTermAssets)}</td></tr>
            <tr class="total"><td>Total assets</td><td class="num">${fmt(d.balanceSheet.currentAssets + d.balanceSheet.longTermAssets)}</td></tr>
            <tr><td>Current liabilities</td><td class="num">${fmt(d.balanceSheet.currentLiabilities)}</td></tr>
            <tr><td>Long-term liabilities</td><td class="num">${fmt(d.balanceSheet.longTermLiabilities)}</td></tr>
            <tr><td>Owner's equity</td><td class="num">${fmt(d.balanceSheet.equity)}</td></tr>
            <tr class="total"><td>Total liabilities + equity</td><td class="num">${fmt(d.balanceSheet.totalLiabilities + d.balanceSheet.equity)}</td></tr>
          </table>

          <div class="lr-sectiontitle">Findings <span class="tag">${flags.length} item${flags.length > 1 ? 's' : ''}</span></div>
          <ul class="lr-flaglist">
            ${flags.map(f => `
              <li>
                ${stampFor(f.severity)}
                <div class="lr-flagtext">${f.text}</div>
              </li>
            `).join("")}
          </ul>
        </div>

        <div class="lr-tape">
          <h5>Key Ratios</h5>
          <div class="lr-tapeline"><span>Current ratio</span>${ratioCell(ratios.currentRatio === null ? null : ratios.currentRatio.toFixed(2), ratios.currentRatio === null ? "" : (ratios.currentRatio < 1 ? "bad" : ratios.currentRatio < 1.2 ? "warn" : "good"))}</div>
          <div class="lr-tapeline"><span>Equity / assets</span>${ratioCell(ratios.equityRatio === null ? null : (ratios.equityRatio * 100).toFixed(1) + "%", ratios.equityRatio === null ? "" : (ratios.equityRatio < 0.2 ? "warn" : "good"))}</div>
          <div class="lr-tapeline"><span>DSCR (approx)</span>${ratioCell(ratios.dscr === null ? null : ratios.dscr.toFixed(2) + "x", ratios.dscr === null ? "" : (ratios.dscr < 1.25 ? "warn" : "good"))}</div>
          <div class="lr-tapeline"><span>AR &gt;90 days</span><span class="val ${d.ar_aging_over90 > 8000 ? 'warn' : 'good'}">${fmt(d.ar_aging_over90)}</span></div>
          <div class="lr-tapeline"><span>AP &gt;90 days</span><span class="val">${fmt(d.ap_aging_over90)}</span></div>
        </div>
      </div>

      <div class="lr-actionrow">
        <button class="lr-btn secondary small" id="lr-review-back">← Back</button>
        <button class="lr-btn" id="lr-review-continue">Draft lender narrative →</button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Step 3: Narrative
  // ---------------------------------------------------------------------
  function renderNarrative() {
    let box;
    if (state.narrativeStatus === "idle") {
      box = `<div class="lr-narrativebox placeholder">Click "Generate narrative" to draft a lender-facing summary from the checks and ratios above.</div>`;
    } else if (state.narrativeStatus === "loading") {
      box = `<div class="lr-narrativebox placeholder">Drafting narrative <span class="lr-loadingdots"><span></span><span></span><span></span></span></div>`;
    } else if (state.narrativeStatus === "error") {
      box = `<div class="lr-narrativebox placeholder">${escapeHtml(state.narrativeError || "Couldn't reach the drafting model just now. Try again.")}</div>`;
    } else {
      box = `<div class="lr-narrativebox">${escapeHtml(state.narrative)}</div>`;
    }

    return `
      <div class="lr-intro">An AI-drafted summary, written the way a lender expects to read it — plain language, grounded in the actual figures and flags, not a generic template.</div>
      ${box}
      <div class="lr-actionrow">
        <button class="lr-btn secondary small" id="lr-narrative-back">← Back</button>
        ${state.narrativeStatus === "done"
          ? `<button class="lr-btn" id="lr-narrative-continue">Build final package →</button>`
          : `<button class="lr-btn" id="lr-narrative-generate" ${state.narrativeStatus === 'loading' ? 'disabled' : ''}>${state.narrativeStatus === 'error' ? 'Retry' : 'Generate narrative'}</button>`
        }
      </div>
    `;
  }

  async function generateNarrative() {
    state.narrativeStatus = "loading";
    renderPanel();
    const d = state._data;
    const flags = state._flags;
    const ratios = state._ratios;

    const prompt = `You are drafting a short lender-facing narrative for a small business loan application. Write in plain, professional language a lender would expect. Ground everything in these numbers — do not invent figures.

Business: ${d.name}
Requested amount: ${d.requestedAmount}
Revenue: ${fmt(d.pnl.revenue)}, Net income: ${fmt(d.pnl.netIncome)}
Current ratio: ${ratios.currentRatio === null ? "n/a" : ratios.currentRatio.toFixed(2)}, Equity/assets: ${ratios.equityRatio === null ? "n/a" : (ratios.equityRatio * 100).toFixed(1) + "%"}, DSCR: ${ratios.dscr === null ? "n/a" : ratios.dscr.toFixed(2) + "x"}
Findings: ${flags.map(f => f.text).join(" ")}

Write 3 short paragraphs: (1) business overview and loan purpose, (2) financial position including an honest, brief acknowledgment of any flagged items and why they aren't disqualifying, (3) repayment capacity and closing statement. No headers, no bullet points, no markdown.`;

    try {
      const response = await fetch("/api/narrative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed");
      state.narrative = data.text;
      state.narrativeStatus = "done";
    } catch (e) {
      state.narrativeStatus = "error";
      state.narrativeError = e.message;
    }
    renderPanel();
  }

  // ---------------------------------------------------------------------
  // Step 4: Package
  // ---------------------------------------------------------------------
  function renderPackage() {
    const d = state._data;
    const flags = state._flags;
    const ratios = state._ratios;
    return `
      <div class="lr-doc">
        <div class="lr-corner">DRAFT</div>
        <div class="lr-docheader">
          <h2>${escapeHtml(d.name)}</h2>
          <p>Lender submission package — requested ${escapeHtml(d.requestedAmount)}</p>
        </div>

        <div class="lr-docgrid">
          <div class="lr-dockpi"><div class="num">${fmt(d.pnl.netIncome)}</div><div class="lbl">Net income</div></div>
          <div class="lr-dockpi"><div class="num">${ratios.dscr === null ? "n/a" : ratios.dscr.toFixed(2) + "x"}</div><div class="lbl">DSCR</div></div>
          <div class="lr-dockpi"><div class="num">${ratios.currentRatio === null ? "n/a" : ratios.currentRatio.toFixed(2)}</div><div class="lbl">Current ratio</div></div>
        </div>

        <div class="lr-docsection">
          <h4>Narrative Summary</h4>
          <div style="font-family:'Spectral',serif; font-size:14.5px; line-height:1.7; white-space:pre-wrap;">${escapeHtml(state.narrative || "(no narrative generated)")}</div>
        </div>

        <div class="lr-docsection">
          <h4>Reviewed Items</h4>
          <ul class="lr-docflags">
            ${flags.map(f => `<li>${stampFor(f.severity)} &nbsp; ${f.text}</li>`).join("")}
          </ul>
        </div>
      </div>

      ${state.pdfStatus === "error" ? `<div class="lr-error">${escapeHtml(state.pdfError)}</div>` : ""}

      <div class="lr-actionrow">
        <button class="lr-btn secondary small" id="lr-package-back">← Back</button>
        <button class="lr-btn secondary small" id="lr-package-copy">Copy summary text</button>
        <button class="lr-btn small" id="lr-package-pdf" ${state.pdfStatus === "loading" ? "disabled" : ""}>${state.pdfStatus === "loading" ? "Building PDF…" : "Download PDF"}</button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Render / event wiring
  // ---------------------------------------------------------------------
  function renderPanel() {
    const panel = document.getElementById("lr-panel");
    if (state.step === 1) panel.innerHTML = renderIntake();
    else if (state.step === 2) panel.innerHTML = renderReview();
    else if (state.step === 3) panel.innerHTML = renderNarrative();
    else if (state.step === 4) panel.innerHTML = renderPackage();
    attachPanelEvents();
    renderTabs();
    renderMeta();
  }

  function refreshMappingUI() {
    const summaryWrap = document.getElementById("lr-summary-wrap");
    if (summaryWrap) summaryWrap.innerHTML = renderSummaryGrid();

    const missing = REQUIRED_BUCKETS.filter(key => !state.upload.mapping.includes(key));
    const useBtn = document.getElementById("lr-use-data");
    if (useBtn) useBtn.disabled = missing.length > 0;

    let note = document.getElementById("lr-missing-note");
    if (missing.length) {
      const text = `Still need at least one row mapped to: ${missing.map(k => BUCKETS.find(b => b.key === k).label).join(", ")}.`;
      if (note) {
        note.textContent = text;
      } else {
        note = document.createElement("div");
        note.className = "lr-error";
        note.id = "lr-missing-note";
        note.textContent = text;
        document.getElementById("lr-summary-wrap").after(note);
      }
    } else if (note) {
      note.remove();
    }
  }

  function attachPanelEvents() {
    if (state.step === 1) {
      [...document.querySelectorAll(".lr-samplecard")].forEach(card => {
        card.addEventListener("click", () => {
          state.activeSource = "sample";
          state.sampleKey = card.dataset.key;
          state.currencySymbol = "£";
          state.narrative = "";
          state.narrativeStatus = "idle";
          renderPanel();
        });
      });

      const nameInput = document.getElementById("lr-business-name");
      if (nameInput) nameInput.addEventListener("input", (e) => { state.businessName = e.target.value; });
      const amountInput = document.getElementById("lr-requested-amount");
      if (amountInput) amountInput.addEventListener("input", (e) => { state.requestedAmount = e.target.value; });

      const dropzone = document.getElementById("lr-dropzone");
      const fileInput = document.getElementById("lr-fileinput");
      if (dropzone && fileInput) {
        dropzone.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
        dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
        dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
        dropzone.addEventListener("drop", (e) => {
          e.preventDefault();
          dropzone.classList.remove("dragover");
          if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });
      }

      const restartBtn = document.getElementById("lr-upload-restart");
      if (restartBtn) restartBtn.addEventListener("click", () => {
        state.upload = { status: "idle" };
        if (state.activeSource === "upload") { state.activeSource = null; state.customData = null; }
        renderPanel();
      });

      const confirmCols = document.getElementById("lr-confirm-columns");
      if (confirmCols) confirmCols.addEventListener("click", () => {
        const labelCol = document.getElementById("lr-labelcol").value;
        const amountCol = document.getElementById("lr-amountcol").value;
        state.upload.labelCol = labelCol;
        state.upload.amountCol = amountCol;
        state.upload.mapping = state.upload.rows.map(r => guessBucket(r[labelCol]));
        state.upload.status = "mapping";
        renderPanel();
      });

      [...document.querySelectorAll(".lr-bucket-select")].forEach(sel => {
        sel.addEventListener("change", (e) => {
          const idx = parseInt(e.target.dataset.row, 10);
          state.upload.mapping[idx] = e.target.value;
          const tr = document.querySelector(`tr[data-row="${idx}"]`);
          if (tr) tr.classList.toggle("mapped", e.target.value !== "ignore");
          refreshMappingUI();
        });
      });

      const useDataBtn = document.getElementById("lr-use-data");
      if (useDataBtn) useDataBtn.addEventListener("click", () => {
        state.customData = buildCustomData();
        state.activeSource = "upload";
        state.currencySymbol = "£";
        state.upload.status = "confirmed";
        state.narrative = "";
        state.narrativeStatus = "idle";
        renderPanel();
      });

      const editMapping = document.getElementById("lr-edit-mapping");
      if (editMapping) editMapping.addEventListener("click", () => {
        state.upload.status = "mapping";
        renderPanel();
      });

      const qboConnect = document.getElementById("lr-qbo-connect");
      if (qboConnect) qboConnect.addEventListener("click", () => { window.location.href = "/api/quickbooks/connect"; });

      const qboImport = document.getElementById("lr-qbo-import");
      if (qboImport) qboImport.addEventListener("click", importFromQuickbooks);
      const qboReimport = document.getElementById("lr-qbo-reimport");
      if (qboReimport) qboReimport.addEventListener("click", importFromQuickbooks);

      const qboDisconnect = document.getElementById("lr-qbo-disconnect");
      if (qboDisconnect) qboDisconnect.addEventListener("click", async () => {
        await fetch("/api/quickbooks/disconnect", { method: "POST" });
        state.quickbooks.connected = false;
        state.quickbooks.importStatus = "idle";
        if (state.activeSource === "quickbooks") { state.activeSource = null; state.customData = null; }
        renderPanel();
      });

      const cont = document.getElementById("lr-intake-continue");
      if (cont) cont.addEventListener("click", () => { state.step = 2; renderPanel(); });
    }

    if (state.step === 2) {
      document.getElementById("lr-review-back").addEventListener("click", () => { state.step = 1; renderPanel(); });
      document.getElementById("lr-review-continue").addEventListener("click", () => { state.step = 3; renderPanel(); });
    }

    if (state.step === 3) {
      document.getElementById("lr-narrative-back").addEventListener("click", () => { state.step = 2; renderPanel(); });
      const gen = document.getElementById("lr-narrative-generate");
      if (gen) gen.addEventListener("click", generateNarrative);
      const cont = document.getElementById("lr-narrative-continue");
      if (cont) cont.addEventListener("click", () => { state.step = 4; renderPanel(); });
    }

    if (state.step === 4) {
      document.getElementById("lr-package-back").addEventListener("click", () => { state.step = 3; renderPanel(); });
      document.getElementById("lr-package-copy").addEventListener("click", () => {
        const text = document.querySelector(".lr-doc").innerText;
        navigator.clipboard?.writeText(text);
      });
      const pdfBtn = document.getElementById("lr-package-pdf");
      if (pdfBtn) pdfBtn.addEventListener("click", downloadPackagePdf);
    }
  }

  async function downloadPackagePdf() {
    state.pdfStatus = "loading";
    renderPanel();

    const d = state._data;
    const flags = state._flags;
    const ratios = state._ratios;

    try {
      const response = await fetch("/api/package/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: d.name,
          requestedAmount: d.requestedAmount,
          currencySymbol: state.currencySymbol,
          pnl: d.pnl,
          ratios,
          flags,
          narrative: state.narrative
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = (d.name || "loan-package").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
      a.href = url;
      a.download = `${safeName}-loan-package.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      state.pdfStatus = "idle";
    } catch (e) {
      state.pdfStatus = "error";
      state.pdfError = e.message;
    }
    renderPanel();
  }

  // ---------------------------------------------------------------------
  // QuickBooks: status check + import
  // ---------------------------------------------------------------------
  async function importFromQuickbooks() {
    state.quickbooks.importStatus = "loading";
    renderPanel();
    try {
      const res = await fetch("/api/quickbooks/financials");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      state.customData = {
        name: state.businessName.trim() || data.name,
        requestedAmount: state.requestedAmount.trim() || data.requestedAmount,
        pnl: data.pnl,
        balanceSheet: data.balanceSheet,
        cashFlow: data.cashFlow,
        ar_aging_over90: data.ar_aging_over90,
        ap_aging_over90: data.ap_aging_over90
      };
      state.activeSource = "quickbooks";
      state.currencySymbol = symbolForCurrencyCode(data.currency);
      state.quickbooks.importStatus = "done";
      state.narrative = "";
      state.narrativeStatus = "idle";
    } catch (e) {
      state.quickbooks.importStatus = "error";
      state.quickbooks.error = e.message;
    }
    renderPanel();
  }

  async function initQuickbooksStatus() {
    // Surface the redirect result from /api/quickbooks/callback, then clean
    // the URL so a refresh doesn't re-trigger the message.
    const params = new URLSearchParams(window.location.search);
    const qbParam = params.get("quickbooks");
    if (qbParam === "error") {
      state.quickbooks.error = params.get("message") || "Something went wrong connecting to QuickBooks.";
    }
    if (qbParam) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    try {
      const res = await fetch("/api/quickbooks/status");
      const data = await res.json();
      state.quickbooks.configured = data.configured;
      state.quickbooks.connected = data.connected;
    } catch (e) {
      // status check failing shouldn't block the rest of the app
    }
    renderPanel();
  }

  renderPanel();
  initQuickbooksStatus();
})();
