// Statement parsing for the Actuals/Reconcile flow.
//
// Turns a raw CSV (bank, credit card, or Stripe export) into a list of NORMALIZED
// transactions plus statement-level metadata (covered date range). Pure + no
// imports beyond BASE_YEAR, so it runs in the browser (upload handler) and in Node
// (tests). Detection is by column headers, so the CEO can drop any file and the
// right parser is chosen.
//
// Normalized transaction shape:
//   {
//     extId,        // stable external id (Stripe charge id) or null for bank rows
//     source,       // 'chase_checking' | 'chase_cc' | 'stripe' | 'wise'
//     account,      // account key, e.g. 'chase_6692', 'chase_cc_3209', 'stripe', 'wise'
//     date,         // ISO 'YYYY-MM-DD' (posting/post date)
//     monthIdx,     // absolute horizon index (year-aware, anchored Jan 2026 = 0)
//     amount,       // signed: positive = into the account, negative = out
//     description,  // raw description text
//     rawType,      // source's own type label ('ACH_DEBIT', 'Sale', 'charge', ...)
//     balance,      // running balance after this row (checking only), else null
//     meta,         // source-specific extras (Stripe metadata, CC category, ...)
//   }

import { BASE_YEAR } from "./compute.js";

// --- CSV parsing ------------------------------------------------------------

// Minimal RFC-4180-ish parser: handles quoted fields with embedded commas and
// doubled "" escapes. Chase/Stripe exports stay within this subset.
export function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
      return o;
    });
}

export function detectFormat(headers) {
  const h = headers.map((x) => x.toLowerCase());
  const has = (...names) => names.every((n) => h.some((x) => x.includes(n)));
  // Chase checking: Posting Date + Balance, no Card column.
  if (has("posting date", "balance") && !h.some((x) => x === "card")) return "chase_checking";
  // Chase credit card.
  if (has("card", "transaction date", "category")) return "chase_cc";
  // Stripe "unified payments" export (per-charge, with fee + metadata).
  if (has("amount", "fee", "status") && h.some((x) => x.includes("created date"))) return "stripe";
  // Stripe balance-transactions export (legacy: Type/Source/Net).
  if (has("type", "source", "net", "currency")) return "stripe_balance";
  // Wise.
  if (has("direction", "source amount", "target name")) return "wise";
  return null;
}

// --- helpers ----------------------------------------------------------------

const decodeEntities = (s) => (s || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const toNum = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Parse MM/DD/YYYY (Chase) or YYYY-MM-DD[ HH:MM:SS] (Stripe) → {iso, monthIdx}.
export function parseDate(str) {
  if (!str) return null;
  let y, m, d;
  const s = str.trim();
  let mm;
  if ((mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) {
    m = +mm[1]; d = +mm[2]; y = +mm[3];
  } else if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) {
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const monthIdx = (y - BASE_YEAR) * 12 + (m - 1);
  return { iso, monthIdx, y, m, d };
}

const digits = (s) => (String(s).match(/\d{3,}/) || [])[0] || "";

// --- per-format normalizers -------------------------------------------------

function normChaseChecking(rows, fileName) {
  const acct = "chase_" + (digits(fileName) || "checking");
  const txns = [];
  rows.forEach((r) => {
    const dt = parseDate(r["Posting Date"]);
    const amount = toNum(r["Amount"]);
    if (!dt || amount === null) return;
    txns.push({
      extId: null, source: "chase_checking", account: acct,
      date: dt.iso, monthIdx: dt.monthIdx, amount,
      description: decodeEntities(r["Description"]),
      rawType: r["Type"] || "", balance: toNum(r["Balance"]), meta: {},
    });
  });
  return txns;
}

function normChaseCC(rows, fileName) {
  const txns = [];
  rows.forEach((r) => {
    const dt = parseDate(r["Post Date"] || r["Transaction Date"]);
    const amount = toNum(r["Amount"]);
    if (!dt || amount === null) return;
    const card = r["Card"] || digits(fileName) || "cc";
    txns.push({
      extId: null, source: "chase_cc", account: "chase_cc_" + card,
      date: dt.iso, monthIdx: dt.monthIdx, amount,
      description: decodeEntities(r["Description"]),
      rawType: r["Type"] || "", balance: null,
      meta: { category: r["Category"] || "" },
    });
  });
  return txns;
}

function normStripe(rows) {
  const txns = [];
  rows.forEach((r) => {
    const dt = parseDate(r["Created date (UTC)"] || r["Created (UTC)"]);
    const amount = toNum(r["Amount"]);
    if (!dt || amount === null) return;
    const status = (r["Status"] || "").toLowerCase();
    if (status && status !== "paid") return; // skip failed/uncaptured
    const fee = toNum(r["Fee"]) || 0;
    txns.push({
      extId: r["id"] || null, source: "stripe", account: "stripe",
      date: dt.iso, monthIdx: dt.monthIdx, amount,
      description: r["Description"] || "", rawType: "charge", balance: null,
      meta: {
        fee,
        net: Math.round((amount - fee) * 100) / 100,
        clientName: r["Name (metadata)"] || r["Customer Description"] || "",
        email: r["email (metadata)"] || r["Customer Email"] || "",
        merchantRef: r["merchant_reference (metadata)"] || "",
        invoiceId: r["Invoice ID"] || "",
      },
    });
  });
  return txns;
}

function normWise(rows) {
  const txns = [];
  rows.forEach((r) => {
    if (r["Status"] && r["Status"] !== "COMPLETED") return;
    const dt = parseDate(r["Finished on"] || r["Created on"]);
    if (!dt) return;
    const dir = (r["Direction"] || "").toUpperCase();
    const srcAmt = toNum(r["Source amount (after fees)"]) || 0;
    const fee = toNum(r["Source fee amount"]) || 0;
    const amount = dir === "OUT" ? -(srcAmt + fee) : srcAmt;
    txns.push({
      extId: r["ID"] || r["Reference"] || null, source: "wise", account: "wise",
      date: dt.iso, monthIdx: dt.monthIdx, amount,
      description: r["Target name"] || r["Reference"] || "Wise transfer",
      rawType: dir, balance: null, meta: { fee },
    });
  });
  return txns;
}

// --- public entry -----------------------------------------------------------

// Parse one CSV file → { format, source, accounts, transactions, coverage }.
// coverage = { start, end } ISO dates spanning the statement (null if no rows).
export function parseStatement(text, fileName = "") {
  const rows = parseCSV(text);
  if (!rows.length) return { format: null, transactions: [], coverage: null, fileName };
  const format = detectFormat(Object.keys(rows[0]));
  let transactions = [];
  if (format === "chase_checking") transactions = normChaseChecking(rows, fileName);
  else if (format === "chase_cc") transactions = normChaseCC(rows, fileName);
  else if (format === "stripe" || format === "stripe_balance") transactions = normStripe(rows);
  else if (format === "wise") transactions = normWise(rows);

  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  const coverage = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
  const accounts = [...new Set(transactions.map((t) => t.account))];
  return { format, source: format, accounts, transactions, coverage, fileName, rowCount: transactions.length };
}
