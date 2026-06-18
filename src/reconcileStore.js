// Direct Supabase access for the statement-reconcile domain (bank_transactions,
// statement_uploads, match_rules). Deliberately NOT part of the forecast `d`
// round-trip / save_forecast_rows() — transaction history accumulates and must not
// bloat every forecast save. Admin RLS gates writes (browser anon key + session).
//
// The per-month rollup that DOES feed the forecast (closing balance + complete
// flag) is written separately into d.actuals via the normal save path.

import { supabase } from "./supabase.js";

// --- row <-> normalized transaction mapping --------------------------------

const rowToTxn = (r) => ({
  dbId: r.id,
  extId: r.ext_id,
  source: r.source,
  account: r.account,
  date: r.txn_date,
  monthIdx: r.month_idx,
  amount: Number(r.amount),
  description: r.description || "",
  rawType: r.raw_type || "",
  balance: r.balance == null ? null : Number(r.balance),
  category: r.category,
  flow: r.flow,
  counterparty: r.counterparty || "",
  clientId: r.client_id || null,
  confidence: r.confidence == null ? null : Number(r.confidence),
  reviewed: !!r.reviewed,
  meta: r.meta || {},
});

const txnToRow = (t, uploadId) => ({
  ext_id: t.extId || null,
  source: t.source,
  account: t.account,
  txn_date: t.date,
  month_idx: t.monthIdx,
  amount: t.amount,
  description: t.description || "",
  raw_type: t.rawType || "",
  balance: t.balance ?? null,
  category: t.category || null,
  flow: t.flow || null,
  counterparty: t.counterparty || null,
  client_id: t.clientId || null,
  confidence: t.confidence ?? null,
  reviewed: !!t.reviewed,
  meta: t.meta || {},
  upload_id: uploadId ?? null,
});

const ruleRowToRule = (r) => ({
  id: r.id,
  re: new RegExp(r.pattern, "i"),
  pattern: r.pattern,
  src: r.source || undefined,
  sign: r.sign || undefined,
  category: r.category,
  counterparty: r.counterparty || "",
  clientId: r.client_id || null,
  priority: r.priority ?? 100,
});

// --- reads ------------------------------------------------------------------

export async function fetchTransactions() {
  const { data, error } = await supabase
    .from("bank_transactions").select("*").order("txn_date", { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToTxn);
}

export async function fetchRules() {
  const { data, error } = await supabase
    .from("match_rules").select("*").order("priority", { ascending: false });
  if (error) throw error;
  // Higher priority first (tried ahead of DEFAULT_RULES).
  return (data || []).map(ruleRowToRule);
}

export async function fetchUploads() {
  const { data, error } = await supabase
    .from("statement_uploads").select("*").order("uploaded_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// --- writes -----------------------------------------------------------------

// Persist a batch of parsed+classified statements:
//   1. record each upload (audit + coverage),
//   2. supersede superseded bank rows (replace-by-range, per account window),
//   3. delete any Stripe/Wise rows whose ext_id is being re-uploaded,
//   4. insert the new transactions.
// `statements`: [{ source, fileName, accounts, coverage, transactions(classified) }]
// `uploadedBy`: email/string for the audit trail.
// Returns the fresh full transaction set (re-fetched).
//
// NOTE: not a single DB transaction (no RPC) — steps run sequentially. Acceptable
// for the single-operator reconcile flow; an RPC can wrap it later if needed.
export async function commitStatements(statements, uploadedBy = null) {
  // Coverage windows per bank account + ext_id set being replaced.
  const windows = {};
  const extIds = [];
  for (const st of statements) {
    for (const t of st.transactions) {
      if (t.extId) { extIds.push(t.extId); continue; }
      const w = windows[t.account] || { start: t.date, end: t.date };
      if (t.date < w.start) w.start = t.date;
      if (t.date > w.end) w.end = t.date;
      windows[t.account] = w;
    }
  }

  for (const st of statements) {
    // 1. upload record
    const { data: up, error: upErr } = await supabase.from("statement_uploads").insert({
      source: st.source, file_name: st.fileName, accounts: st.accounts || [],
      coverage_start: st.coverage?.start || null, coverage_end: st.coverage?.end || null,
      row_count: st.transactions.length, uploaded_by: uploadedBy,
    }).select("id").single();
    if (upErr) throw upErr;
    const uploadId = up.id;

    // 2 + 4. (per-statement) insert this statement's rows after superseding.
    st._uploadId = uploadId;
  }

  // 2. Supersede bank rows by range (per account).
  for (const [account, w] of Object.entries(windows)) {
    const { error } = await supabase.from("bank_transactions")
      .delete().eq("account", account).gte("txn_date", w.start).lte("txn_date", w.end);
    if (error) throw error;
  }
  // 3. Replace re-uploaded id-based rows.
  if (extIds.length) {
    const { error } = await supabase.from("bank_transactions").delete().in("ext_id", extIds);
    if (error) throw error;
  }

  // 4. Insert.
  const rows = [];
  for (const st of statements) for (const t of st.transactions) rows.push(txnToRow(t, st._uploadId));
  if (rows.length) {
    const { error } = await supabase.from("bank_transactions").insert(rows);
    if (error) throw error;
  }

  return fetchTransactions();
}

// Update one transaction's classification (review-screen override).
export async function updateTransaction(dbId, patch) {
  const row = {};
  if ("category" in patch) row.category = patch.category;
  if ("flow" in patch) row.flow = patch.flow;
  if ("counterparty" in patch) row.counterparty = patch.counterparty;
  if ("clientId" in patch) row.client_id = patch.clientId;
  row.reviewed = true;
  const { error } = await supabase.from("bank_transactions").update(row).eq("id", dbId);
  if (error) throw error;
}

// Save a learned rule (from a review-screen correction).
export async function saveRule(rule, createdBy = null) {
  const { error } = await supabase.from("match_rules").insert({
    pattern: rule.pattern, source: rule.src || null, sign: rule.sign || null,
    category: rule.category, counterparty: rule.counterparty || null,
    client_id: rule.clientId || null, priority: rule.priority ?? 200, created_by: createdBy,
  });
  if (error) throw error;
}

export async function deleteRule(id) {
  const { error } = await supabase.from("match_rules").delete().eq("id", id);
  if (error) throw error;
}
