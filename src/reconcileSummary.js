// Merge, dedup, running-balance reconstruction, and monthly rollup for the
// Actuals/Reconcile flow. Pure (no imports), Node + browser safe.
//
// Dedup strategy differs by source (see the plan):
//   • Stripe / Wise (rows carry a stable extId): union by extId, newest wins.
//   • Chase checking / CC (no row id): REPLACE-BY-RANGE — a newer upload supersedes
//     any transaction for the same account whose date falls inside the new upload's
//     covered window. This keeps genuine same-day/same-amount duplicates (e.g. two
//     identical hotel charges) while preventing re-upload double counting.

import { flowOf } from "./reconcileRules.js";

const lastDayOfMonthIso = (monthIdx) => {
  // monthIdx anchored Jan 2026 = 0.
  const year = 2026 + Math.floor(monthIdx / 12);
  const month = (monthIdx % 12) + 1; // 1-12
  const day = new Date(year, month, 0).getDate(); // day 0 of next month = last day
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

// Merge a batch of newly-parsed statements into the existing transaction store.
//   existing: prior transactions (already stored)
//   incoming: { transactions, coverageByAccount: {account: {start,end}} }
// Returns { transactions, superseded } where superseded is the count dropped.
export function mergeTransactions(existing, statements) {
  // Build coverage windows per bank account from the incoming statements.
  const windows = {}; // account -> {start, end}
  const idBased = new Map(); // extId -> txn (incoming wins)
  const incomingBank = []; // bank rows (no extId)
  const incomingAll = [];

  for (const st of statements) {
    for (const t of st.transactions) {
      incomingAll.push(t);
      if (t.extId) { idBased.set(t.extId, t); continue; }
      incomingBank.push(t);
      const w = windows[t.account] || { start: t.date, end: t.date };
      if (t.date < w.start) w.start = t.date;
      if (t.date > w.end) w.end = t.date;
      windows[t.account] = w;
    }
  }

  let superseded = 0;
  const kept = [];
  for (const t of existing) {
    if (t.extId) {
      if (idBased.has(t.extId)) { superseded++; continue; } // replaced below
      kept.push(t);
      continue;
    }
    // Bank row: drop if it falls inside a newly-covered window for its account.
    const w = windows[t.account];
    if (w && t.date >= w.start && t.date <= w.end) { superseded++; continue; }
    kept.push(t);
  }

  const merged = [...kept, ...incomingBank, ...idBased.values()];
  return { transactions: merged, superseded, windows };
}

// Reconstruct a post-transaction running balance for every row of a checking
// account, filling blank balances by anchoring on the nearest known balance and
// walking with signed amounts. Mutates copies; returns a new array (chronological).
export function reconstructBalances(txns) {
  // Stable chronological order. Within a date, preserve input order (statements are
  // newest-first; reverse so oldest-first), then anchor off any known balance.
  const ordered = txns
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : b.i - a.i))
    .map((x) => ({ ...x.t }));

  // Find first known balance to anchor.
  let anchor = ordered.findIndex((t) => t.balance != null);
  if (anchor === -1) return ordered; // nothing to anchor on; leave balances null

  // Walk forward from anchor.
  for (let i = anchor + 1; i < ordered.length; i++) {
    if (ordered[i].balance == null) ordered[i].balance = round2(ordered[i - 1].balance + ordered[i].amount);
  }
  // Walk backward from anchor (balance before row i = balance[i] - amount[i]).
  for (let i = anchor - 1; i >= 0; i--) {
    if (ordered[i].balance == null) ordered[i].balance = round2(ordered[i + 1].balance - ordered[i + 1].amount);
  }
  return ordered;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Build per-month summaries from the full deduped transaction set.
//   transactions: normalized + classified (must have .flow/.category) txns
//   coverageByAccount: {account: endIso} latest covered date per checking account,
//     used to decide whether a month is "complete" (locks the forecast).
// Returns { [monthIdx]: summary }.
export function buildMonthlySummaries(transactions, coverageByAccount = {}) {
  // Reconstruct balances per checking account.
  const checkingByAcct = {};
  for (const t of transactions) {
    if (t.source !== "chase_checking") continue;
    (checkingByAcct[t.account] ||= []).push(t);
  }
  const reconByAcct = {};
  for (const [acct, rows] of Object.entries(checkingByAcct)) {
    reconByAcct[acct] = reconstructBalances(rows);
  }

  const months = {};
  const ensure = (m) => (months[m] ||= {
    monthIdx: m, closingBal: null, cashIn: 0, cashOut: 0,
    revenueIn: 0, expenseOut: 0, transferNet: 0, financingNet: 0,
    byCategory: {}, accounts: {}, complete: false,
    counts: { checking: 0, cc: 0, stripe: 0, wise: 0 },
  });

  // Cash in/out + revenue/expense split from CHECKING rows only.
  for (const t of transactions) {
    const m = ensure(t.monthIdx);
    m.counts[t.source === "chase_checking" ? "checking" : t.source === "chase_cc" ? "cc" : t.source] ??= 0;
    if (t.source === "chase_checking") m.counts.checking++;
    else if (t.source === "chase_cc") m.counts.cc++;
    else if (t.source === "stripe") m.counts.stripe++;
    else if (t.source === "wise") m.counts.wise++;

    const flow = t.flow || flowOf(t.category);
    // Per-category breakdown spans all sources (useful for the review UI).
    const key = t.category || "uncategorized";
    m.byCategory[key] = round2((m.byCategory[key] || 0) + t.amount);

    if (t.source !== "chase_checking") continue; // only checking moves cash here
    if (t.amount >= 0) m.cashIn = round2(m.cashIn + t.amount);
    else m.cashOut = round2(m.cashOut + t.amount);
    if (flow === "revenue") m.revenueIn = round2(m.revenueIn + t.amount);
    else if (flow === "expense") m.expenseOut = round2(m.expenseOut + t.amount);
    else if (flow === "transfer") m.transferNet = round2(m.transferNet + t.amount);
    else if (flow === "financing") m.financingNet = round2(m.financingNet + t.amount);
  }

  // Closing balance per month = reconstructed balance of the last checking row in
  // that month, summed across checking accounts that have data in the month.
  for (const [acct, rows] of Object.entries(reconByAcct)) {
    const byMonth = {};
    for (const r of rows) (byMonth[r.monthIdx] ||= []).push(r);
    for (const [m, rs] of Object.entries(byMonth)) {
      const last = rs[rs.length - 1]; // chronological → last = month close
      if (last.balance == null) continue;
      const mm = ensure(+m);
      mm.accounts[acct] = last.balance;
      mm.closingBal = round2((mm.closingBal || 0) + last.balance);
    }
  }

  // Completeness: a month locks only when a checking statement covers month-end.
  for (const m of Object.values(months)) {
    const end = lastDayOfMonthIso(m.monthIdx);
    const covered = Object.entries(coverageByAccount).some(
      ([acct, endIso]) => acct.startsWith("chase_") && !acct.startsWith("chase_cc_") && endIso >= end
    );
    m.complete = covered && m.closingBal != null;
  }

  return months;
}

// Convenience: derive coverageByAccount (latest covered date per checking account)
// from the full transaction set.
export function coverageFromTransactions(transactions) {
  const cov = {};
  for (const t of transactions) {
    if (t.source !== "chase_checking") continue;
    if (!cov[t.account] || t.date > cov[t.account]) cov[t.account] = t.date;
  }
  return cov;
}

// Map a monthly summary to the existing d.actuals[monthIdx] shape (so it persists
// via the actuals table and feeds the forecast lock). Only `complete` months should
// be written as locked; partial months can be stored with complete:false.
export function summaryToActual(summary, reconDate) {
  return {
    closingBal: summary.closingBal,
    totalIn: round2(summary.revenueIn),
    totalOut: round2(summary.expenseOut),
    chaseIn: round2(summary.cashIn),
    chaseOut: round2(summary.cashOut),
    revenueIn: round2(summary.revenueIn),
    expenseOut: round2(summary.expenseOut),
    transferNet: round2(summary.transferNet),
    financingNet: round2(summary.financingNet),
    complete: !!summary.complete,
    reconDate: reconDate || null,
  };
}
