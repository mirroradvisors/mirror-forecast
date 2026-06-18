import React, { useState, useEffect, useCallback, useMemo } from "react";
import { MO, P, fmt } from "./data.js";
import { Card, Lbl } from "./components.jsx";
import { compute } from "./compute.js";
import { parseStatement } from "./reconcileParse.js";
import { classifyAll, CATEGORIES, flowOf } from "./reconcileRules.js";
import {
  mergeTransactions, buildMonthlySummaries, coverageFromTransactions, summaryToActual,
} from "./reconcileSummary.js";
import {
  fetchTransactions, fetchRules, commitStatements, saveRule,
} from "./reconcileStore.js";

// Year-aware month label (horizon idx anchored Jan 2026 = 0).
const moLabel = (idx) => `${MO[((idx % 12) + 12) % 12]} ${2026 + Math.floor(idx / 12)}`;

const FLOW_COLOR = { revenue: P.g, expense: P.r, transfer: P.b, financing: P.a, ignore: P.td };
const SOURCE_LABEL = { chase_checking: "Chase Checking", chase_cc: "Chase Card", stripe: "Stripe", wise: "Wise" };

export default function ActualsTab({ d, save, isAdmin, showToast }) {
  const [existing, setExisting] = useState([]);     // committed bank_transactions
  const [rules, setRules] = useState([]);           // learned match_rules
  const [parsed, setParsed] = useState([]);         // statements from this upload session (uncommitted)
  const [overrides, setOverrides] = useState({});   // txnKey -> category (review edits)
  const [learn, setLearn] = useState({});           // txnKey -> true (persist as rule)
  const [selMonth, setSelMonth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const clients = useMemo(() => (d.cl || []).map((c) => ({ id: c.id, nm: c.nm, email: c.email })), [d.cl]);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [txns, rs] = await Promise.all([fetchTransactions(), fetchRules()]);
      setExisting(txns); setRules(rs);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Stable identity for a transaction (committed rows have dbId; parsed rows use a synthetic key).
  const txnKey = (t) => t.dbId != null ? `db:${t.dbId}` : t.extId ? `ext:${t.extId}` : `${t.account}|${t.date}|${t.amount}|${t.description.slice(0, 24)}`;

  // Merge committed + freshly-parsed, classify, apply review overrides.
  const { working, summaries, months } = useMemo(() => {
    const merged = mergeTransactions(existing, parsed).transactions;
    let classified = classifyAll(merged, { rules, clients });
    classified = classified.map((t) => {
      const k = txnKey(t);
      if (overrides[k]) return { ...t, category: overrides[k], flow: flowOf(overrides[k]), reviewed: true };
      return t;
    });
    const cov = coverageFromTransactions(classified);
    const summ = buildMonthlySummaries(classified, cov);
    const monthIdxs = [...new Set(classified.map((t) => t.monthIdx))].sort((a, b) => a - b);
    return { working: classified, summaries: summ, months: monthIdxs };
  }, [existing, parsed, rules, clients, overrides]);

  useEffect(() => {
    if (selMonth == null && months.length) setSelMonth(months[months.length - 1]);
  }, [months, selMonth]);

  const handleFiles = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setErr(null);
    let done = 0; const out = [];
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const st = parseStatement(ev.target.result, file.name);
        if (st.format) out.push(st);
        else setErr(`Couldn't recognize ${file.name} — unsupported format.`);
        if (++done === files.length) setParsed((prev) => [...prev, ...out]);
      };
      reader.readAsText(file);
    });
    e.target.value = ""; // allow re-selecting the same file
  }, []);

  const c = compute(d);
  const sum = selMonth != null ? summaries[selMonth] : null;
  const monthTxns = useMemo(
    () => working.filter((t) => t.monthIdx === selMonth).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [working, selMonth]
  );

  const setCategory = (t, category) => {
    const k = txnKey(t);
    setOverrides((o) => ({ ...o, [k]: category }));
    setLearn((l) => ({ ...l, [k]: true })); // a manual change is worth learning
  };

  const commit = async () => {
    if (!parsed.length) return;
    setBusy(true); setErr(null);
    try {
      // Apply review overrides onto the parsed transactions before writing.
      const statements = parsed.map((st) => ({
        ...st,
        transactions: classifyAll(st.transactions, { rules, clients }).map((t) => {
          const k = txnKey(t);
          if (overrides[k]) return { ...t, category: overrides[k], flow: flowOf(overrides[k]), reviewed: true };
          return t;
        }),
      }));
      await commitStatements(statements, null);

      // Persist learned rules from corrections (one rule per overridden description token).
      const ruleWrites = [];
      for (const [k, want] of Object.entries(overrides)) {
        if (!learn[k]) continue;
        const t = working.find((x) => txnKey(x) === k);
        if (!t) continue;
        const token = (t.description.match(/[A-Za-z][A-Za-z&* ]{3,}/) || [t.description])[0].trim().slice(0, 40);
        if (token) ruleWrites.push(saveRule({ pattern: token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), src: t.source, category: want, priority: 200 }));
      }
      await Promise.allSettled(ruleWrites);

      // Roll the now-committed data into d.actuals so compute()'s lock anchors
      // complete months. Re-fetch happens inside commitStatements; recompute here.
      const fresh = await fetchTransactions();
      const classified = classifyAll(fresh, { rules, clients });
      const freshSumm = buildMonthlySummaries(classified, coverageFromTransactions(classified));
      const nextActuals = { ...(d.actuals || {}) };
      const reconDate = new Date().toISOString();
      for (const [mi, s] of Object.entries(freshSumm)) {
        nextActuals[mi] = summaryToActual(s, reconDate);
      }
      save({ ...d, actuals: nextActuals });

      setExisting(fresh); setParsed([]); setOverrides({}); setLearn({});
      showToast?.("Statements reconciled — press Save (⌘S) to lock the forecast", "ok");
    } catch (e) {
      setErr(e?.message || String(e));
      showToast?.("Reconcile failed — see message above", "err");
    } finally { setBusy(false); }
  };

  if (!isAdmin) return <Card style={{ padding: 20, color: P.tm, fontSize: 13 }}>Reconciliation is admin-only.</Card>;

  return (
    <div>
      {/* Upload */}
      <Card style={{ padding: 16, marginBottom: 16, border: `1px dashed ${P.bd}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <Lbl>Upload Statements</Lbl>
          <span style={{ fontSize: 10, color: P.td }}>Chase checking · Chase card · Stripe · Wise — drop several at once</span>
        </div>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 16px", border: `2px dashed ${P.bd}`, borderRadius: 8, cursor: "pointer", background: `${P.c2}60` }}>
          <input type="file" accept=".csv,.CSV" multiple onChange={handleFiles} style={{ display: "none" }} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, marginBottom: 4 }}>📄</div>
            <div style={{ fontSize: 12, color: P.tm }}>Drop CSVs here or click to browse</div>
            <div style={{ fontSize: 10, color: P.td, marginTop: 4 }}>Re-uploads are de-duplicated automatically</div>
          </div>
        </label>
        {parsed.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            {parsed.map((st, i) => (
              <span key={i} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, background: P.gB, color: P.g }}>
                {SOURCE_LABEL[st.source] || st.source} — {st.transactions.length} txns
                {st.coverage && <span style={{ color: P.tm }}> · {st.coverage.start}→{st.coverage.end}</span>}
              </span>
            ))}
            <button onClick={() => { setParsed([]); setOverrides({}); setLearn({}); }} style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${P.bd}`, color: P.tm, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Clear</button>
          </div>
        )}
      </Card>

      {err && <Card style={{ padding: 12, marginBottom: 16, border: `1px solid ${P.rM}`, background: P.rB, color: P.rF || P.r, fontSize: 12 }}>{err}</Card>}
      {loading && <Card style={{ padding: 20, textAlign: "center", color: P.td, fontSize: 12 }}>Loading reconciled data…</Card>}

      {/* Month selector */}
      {!loading && months.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {months.map((mi) => {
              const s = summaries[mi];
              const active = mi === selMonth;
              const complete = s?.complete;
              return (
                <button key={mi} onClick={() => setSelMonth(mi)} style={{
                  padding: "8px 12px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${active ? P.g : complete ? P.g + "44" : P.a + "44"}`,
                  background: active ? P.gB : "transparent",
                  color: active ? P.g : complete ? P.tm : P.a, fontSize: 11, fontWeight: active ? 700 : 500,
                }}>
                  {moLabel(mi)} {complete ? "✓" : "…"}
                </button>
              );
            })}
          </div>

          {sum && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Summary vs forecast */}
              <Card style={{ padding: 16 }}>
                <Lbl>Actual — {moLabel(selMonth)} {sum.complete ? "" : "(in progress)"}</Lbl>
                <Row label="Closing balance" value={sum.closingBal} bold color={P.g} />
                <Row label="Revenue in" value={sum.revenueIn} color={P.g} />
                <Row label="Expenses out" value={sum.expenseOut} color={P.r} />
                <Row label="Transfers (Stripe etc.)" value={sum.transferNet} color={P.b} small />
                <Row label="Financing (CC/loan/owner)" value={sum.financingNet} color={P.a} small />
                {!sum.complete && <div style={{ fontSize: 10, color: P.a, marginTop: 8 }}>Statement doesn't cover month-end — won't lock the forecast yet.</div>}
              </Card>
              {/* vs forecast */}
              <Card style={{ padding: 16 }}>
                <Lbl>Forecast vs Actual</Lbl>
                {(() => {
                  const fBal = c.bl[selMonth];
                  const dBal = sum.closingBal != null ? sum.closingBal - fBal : null;
                  return (
                    <>
                      <Row label="Forecast balance" value={fBal} color={P.tm} small />
                      <Row label="Actual balance" value={sum.closingBal} color={P.tx} small />
                      {dBal != null && <Row label="Difference" value={dBal} bold color={dBal >= 0 ? P.g : P.r} signed />}
                    </>
                  );
                })()}
              </Card>
            </div>
          )}

          {/* Review grid */}
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${P.bd}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Lbl>Transactions — {moLabel(selMonth)} ({monthTxns.length})</Lbl>
              <span style={{ fontSize: 10, color: P.td }}>Edit a category to teach the matcher for next time</span>
            </div>
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {monthTxns.map((t, i) => {
                    const lowConf = (t.confidence ?? 0) < 0.5 && !t.reviewed && !overrides[txnKey(t)];
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${P.bd}22`, background: lowConf ? `${P.aB}40` : "transparent" }}>
                        <td style={{ padding: "7px 10px", color: P.td, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, whiteSpace: "nowrap" }}>{t.date}</td>
                        <td style={{ padding: "7px 10px", color: P.tx, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.description}>
                          {t.description}
                          {t.counterparty && <span style={{ color: P.t, marginLeft: 6 }}>· {t.counterparty}</span>}
                          <span style={{ color: P.td, marginLeft: 6, fontSize: 9 }}>{SOURCE_LABEL[t.source]}</span>
                        </td>
                        <td style={{ padding: "7px 10px" }}>
                          <select value={t.category || ""} onChange={(e) => setCategory(t, e.target.value)}
                            style={{ background: P.c2, color: FLOW_COLOR[t.flow] || P.tx, border: `1px solid ${P.bd}`, borderRadius: 4, fontSize: 11, padding: "2px 4px", maxWidth: 160 }}>
                            {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: t.amount >= 0 ? P.g : P.r, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Commit */}
          {parsed.length > 0 && (
            <button onClick={commit} disabled={busy}
              style={{ marginTop: 16, width: "100%", padding: "12px 16px", borderRadius: 8, background: P.g, color: P.bg, border: "none", fontSize: 12, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
              {busy ? "Saving…" : `Reconcile ${parsed.reduce((n, s) => n + s.transactions.length, 0)} transactions & update actuals`}
            </button>
          )}
        </>
      )}

      {!loading && months.length === 0 && (
        <Card style={{ padding: 20, textAlign: "center", color: P.td, fontSize: 12 }}>
          No statements yet. Upload your bank, card, and Stripe CSVs to begin.
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, color = P.tx, bold, small, signed }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: small ? "3px 0" : "5px 0", borderBottom: `1px solid ${P.bd}18` }}>
      <span style={{ color: P.tm, fontSize: small ? 11 : 12 }}>{label}</span>
      <span style={{ color, fontWeight: bold ? 800 : 600, fontSize: bold ? 15 : small ? 11 : 13, fontFamily: "'JetBrains Mono', monospace" }}>
        {value == null ? "—" : `${signed && value >= 0 ? "+" : ""}${fmt(value)}`}
      </span>
    </div>
  );
}
