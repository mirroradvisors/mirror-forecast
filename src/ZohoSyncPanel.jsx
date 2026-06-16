import React, { useState } from "react";
import { P, fmt } from "./data.js";
import { supabase } from "./supabase.js";
import { buildSyncPlan } from "./zohoSync.js";

// "Sync from Zoho" panel. Calls the admin-gated /api/zoho proxy, diffs the result
// against the current draft `d` (shared logic with the CLI script), and lets the
// admin apply selected changes — which merge into `d` via save() and then show up
// in the global SaveBar as unsaved changes to review and persist (or discard).

const sans = "'DM Sans', sans-serif";
const mono = "'JetBrains Mono', monospace";
const MONEY = new Set(["monthlyAmount", "annualAmount"]);

const fmtVal = (field, v) => {
  if (v == null) return "—";
  if (MONEY.has(field)) return fmt(Number(v));
  return String(v);
};

export default function ZohoSyncPanel({ d, save, onClose }) {
  const [state, setState] = useState("idle"); // idle | loading | ready | error | applied
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [sel, setSel] = useState(() => new Set());

  const runSync = async () => {
    setState("loading"); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const res = await fetch("/api/zoho", { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `proxy ${res.status}`);
      const p = buildSyncPlan(d, body.subscriptions, body.commissions);
      setPlan(p);
      setSel(new Set(p.updates.map((u) => u.clientId))); // default: all selected
      setState("ready");
    } catch (e) {
      setError(String(e?.message || e)); setState("error");
    }
  };

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const apply = () => {
    if (!plan) return;
    const now = new Date().toISOString();
    const byId = new Map(plan.updates.filter((u) => sel.has(u.clientId)).map((u) => [u.clientId, u.after]));
    if (!byId.size) return;
    const cl = (d.cl || []).map((c) => (byId.has(c.id) ? { ...c, zohoCommission: byId.get(c.id), lastEditedAt: now } : c));
    save({ ...d, cl });
    setState("applied");
  };

  const card = { background: P.c1, border: `1px solid ${P.bd}`, borderRadius: 10, padding: 18, marginBottom: 16, fontFamily: sans };
  const flagBox = (title, color) => ({ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${P.bd}` });
  const flagHdr = (color) => ({ fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, marginBottom: 6 });

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: P.tx }}>Sync from Zoho</div>
          <div style={{ fontSize: 11, color: P.tm, marginTop: 2 }}>Pulls live subscriptions & commissions, previews the diff. Applied changes go to the Save bar — nothing is written until you Save.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runSync} disabled={state === "loading"} style={{ background: P.b, color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: state === "loading" ? "default" : "pointer", fontFamily: sans }}>
            {state === "loading" ? "Syncing…" : plan ? "Re-sync" : "Sync from Zoho"}
          </button>
          {onClose && <button onClick={onClose} style={{ background: "transparent", color: P.tm, border: `1px solid ${P.bd}`, borderRadius: 6, padding: "8px 12px", fontSize: 12, cursor: "pointer", fontFamily: sans }}>Close</button>}
        </div>
      </div>

      {state === "error" && <div style={{ fontSize: 12, color: P.r, background: P.rB, border: `1px solid ${P.rM}`, borderRadius: 6, padding: "8px 12px" }}>Sync failed: {error}</div>}

      {state === "applied" && <div style={{ fontSize: 12, color: P.g, background: P.gB, border: `1px solid ${P.gM}`, borderRadius: 6, padding: "8px 12px" }}>Applied to draft ✓ — review in the Save bar below, then Save (⌘S) or Discard.</div>}

      {plan && state !== "applied" && (
        <>
          <div style={{ fontSize: 11, color: P.td, marginBottom: 10 }}>
            {plan.counts.subsActive} active subscriptions · {plan.counts.comms} commission records · {plan.updates.length} proposed change{plan.updates.length === 1 ? "" : "s"}
          </div>

          {plan.updates.length === 0 && <div style={{ fontSize: 12, color: P.tm }}>App already matches Zoho — no changes.</div>}

          {plan.updates.length > 0 && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {plan.updates.map((u) => (
                  <label key={u.clientId} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", background: sel.has(u.clientId) ? `${P.b}10` : P.c2, border: `1px solid ${sel.has(u.clientId) ? `${P.b}66` : P.bd}`, borderRadius: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={sel.has(u.clientId)} onChange={() => toggle(u.clientId)} style={{ marginTop: 2 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: P.tx }}>{u.clientId} {u.clientName} {u.isNew && <span style={{ fontSize: 9, fontWeight: 700, color: P.a, background: P.aB, padding: "1px 5px", borderRadius: 3, marginLeft: 4 }}>NEW</span>}</div>
                      <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 1 }}>
                        {u.changes.map((ch, i) => (
                          <div key={i} style={{ fontSize: 11, fontFamily: mono, color: P.tm }}>
                            {ch.field}: <span style={{ color: P.td }}>{fmtVal(ch.field, ch.from)}</span> → <span style={{ color: P.tx }}>{fmtVal(ch.field, ch.to)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <button onClick={apply} disabled={sel.size === 0} style={{ background: sel.size ? P.g : P.c2, color: sel.size ? P.bg : P.td, border: "none", borderRadius: 6, padding: "9px 18px", fontSize: 12, fontWeight: 700, cursor: sel.size ? "pointer" : "default", fontFamily: sans }}>
                  Apply {sel.size} change{sel.size === 1 ? "" : "s"} to draft
                </button>
              </div>
            </>
          )}

          {/* Review flags — informational, not auto-applied */}
          {plan.resurfaced.length > 0 && (
            <div style={flagBox()}>
              <div style={flagHdr(P.a)}>⚠ Churned/excluded in app but ACTIVE in Zoho ({plan.resurfaced.length})</div>
              {plan.resurfaced.map((r, i) => <div key={i} style={{ fontSize: 11, color: P.tm }}>{r.clientId} {r.clientName} — Zoho {r.sub.frequency} {r.sub.product}, recurring {fmt(r.sub.nextRecurring)}</div>)}
            </div>
          )}
          {plan.vanished.length > 0 && (
            <div style={flagBox()}>
              <div style={flagHdr(P.a)}>⚠ Active in app but NOT in Zoho active set ({plan.vanished.length})</div>
              {plan.vanished.map((v, i) => <div key={i} style={{ fontSize: 11, color: P.tm }}>{v.clientId} {v.clientName} ({v.zc.frequency}, {fmt(v.zc.monthlyAmount || v.zc.annualAmount)})</div>)}
            </div>
          )}
          {plan.insufficient.length > 0 && (
            <div style={flagBox()}>
              <div style={flagHdr(P.td)}>No commission $ from Zoho yet — amount left unchanged ({plan.insufficient.length})</div>
              {plan.insufficient.map((x, i) => <div key={i} style={{ fontSize: 11, color: P.tm }}>{x.clientId} {x.clientName} (sub {x.sub.subscriptionId}, {x.sub.product})</div>)}
            </div>
          )}
          {plan.unmatched.length > 0 && (
            <div style={flagBox()}>
              <div style={flagHdr(P.td)}>Unmatched Zoho subscriptions — no client by id or email ({plan.unmatched.length})</div>
              {plan.unmatched.map((s, i) => <div key={i} style={{ fontSize: 11, color: P.tm }}>{s.customerName || "?"} &lt;{s.email || "no email"}&gt; — {s.product} {s.frequency}</div>)}
              <div style={{ fontSize: 10, color: P.td, marginTop: 4, fontStyle: "italic" }}>Add the email to the matching client, then re-sync.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
