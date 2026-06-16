import React, { useMemo, useState } from "react";
import { P, MO, fmt, sm } from "./data.js";
import { compute, horizonOf, currentMonthIdx, BASE_YEAR, runwayMonths, baselineBalance } from "./compute.js";
import { EditableNumber } from "./components.jsx";

// Full-horizon (24-month) editing surface for the Forecast tab. Edits the RAW
// inputs that drive the forecast — Marketing revenue, Other Costs, Debt,
// Subscriptions, the employment-fee vectors and opening balance — and shows the
// live impact (runway / ending balance / totals) against the last-saved baseline
// before anything is persisted. Derived rows (Zoho, Infinity Mirror, payroll) are
// shown read-only for context; they're edited on the Clients / Payroll tabs.
//
// Buffers through the same save() callback as everywhere else — no parallel state.
// Expense magnitudes are entered as POSITIVE numbers; the row's sign is applied on
// commit (matches the Payroll tab, where costs are typed positive).

const norm = (a, N) => Array.from({ length: N }, (_, i) => Number(a?.[i] ?? 0));
const moLabel = (i) => (i < 12 ? MO[i] : `${MO[i % 12]}'${String(BASE_YEAR + Math.floor(i / 12)).slice(-2)}`);

const mono = "'JetBrains Mono', monospace";
const sans = "'DM Sans', sans-serif";

// One editable month cell. `sign` -1 => stored negative, displayed positive.
function NumCell({ value, sign, changed, isCurrent, onCommit }) {
  const shown = sign < 0 ? Math.abs(value || 0) : (value || 0);
  return (
    <td style={{ padding: "2px 2px", background: isCurrent ? P.bB : (changed ? P.aB : "transparent") }}>
      <EditableNumber
        value={shown}
        onCommit={(n) => onCommit(sign < 0 ? -Math.abs(n) : n)}
        style={{
          width: 54, boxSizing: "border-box", textAlign: "right",
          background: changed ? `${P.a}14` : P.c2,
          border: `1px solid ${changed ? `${P.a}88` : P.bd}`,
          color: sign < 0 ? P.r : P.g, borderRadius: 4, padding: "3px 4px",
          fontFamily: mono, fontSize: 11,
        }}
      />
    </td>
  );
}

// A full editable vector row (label + N month cells + total), with optional
// rename / remove and a bulk-fill toolbar.
function VectorRow({ label, color = P.tm, values, savedValues, sign = -1, N, cm, onChange, onRemove, onRename }) {
  const [tools, setTools] = useState(false);
  const [bulk, setBulk] = useState("");
  const v = norm(values, N);
  const sv = norm(savedValues, N);

  const setCell = (i, val) => { const next = v.slice(); next[i] = val; onChange(next); };
  const bulkNum = () => Number(bulk) || 0;
  const setAll = () => onChange(Array(N).fill(sign < 0 ? -Math.abs(bulkNum()) : bulkNum()));
  const fillRight = () => { const next = v.slice(); const src = next[cm]; for (let i = cm; i < N; i++) next[i] = src; onChange(next); };
  const scale = () => { const f = 1 + bulkNum() / 100; onChange(v.map((x) => Math.round(x * f))); };

  return (
    <>
      <tr>
        <td style={{ padding: "3px 8px", color, borderBottom: `1px solid ${P.bd}15`, whiteSpace: "nowrap", position: "sticky", left: 0, background: P.bg, zIndex: 1 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {onRemove && <button onClick={onRemove} title="Remove line" style={{ background: "transparent", border: "none", color: P.rM, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>}
            {onRename
              ? <input value={label} onChange={(e) => onRename(e.target.value)} style={{ background: "transparent", border: "none", borderBottom: `1px dashed ${P.bd}`, color, fontFamily: sans, fontSize: 12, width: 120 }} />
              : <span style={{ fontSize: 12 }}>{label}</span>}
            <button onClick={() => setTools(!tools)} title="Bulk fill" style={{ background: tools ? P.c2 : "transparent", border: `1px solid ${P.bd}`, color: P.td, cursor: "pointer", fontSize: 9, borderRadius: 3, padding: "1px 5px" }}>⋯</button>
          </span>
        </td>
        {v.map((x, i) => (
          <NumCell key={i} value={x} sign={sign} changed={x !== sv[i]} isCurrent={i === cm} onCommit={(val) => setCell(i, val)} />
        ))}
        <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 700, color, borderBottom: `1px solid ${P.bd}15`, fontFamily: mono, fontSize: 12 }}>{fmt(sm(v))}</td>
      </tr>
      {tools && (
        <tr>
          <td colSpan={N + 2} style={{ padding: "6px 8px 8px 24px", background: `${P.c2}66`, borderBottom: `1px solid ${P.bd}20` }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: P.tm, fontFamily: sans }}>
              <input type="number" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="value / %"
                style={{ width: 90, background: P.c2, border: `1px solid ${P.bd}`, color: P.tx, borderRadius: 4, padding: "4px 6px", fontFamily: mono, fontSize: 11, textAlign: "right" }} />
              <button onClick={setAll} style={btn}>Set all months</button>
              <button onClick={fillRight} style={btn}>Fill {moLabel(cm)} → end</button>
              <button onClick={scale} style={btn}>Adjust by %</button>
              <span style={{ color: P.td }}>(expenses entered positive)</span>
            </span>
          </td>
        </tr>
      )}
    </>
  );
}
const btn = { background: P.c2, color: P.tm, border: `1px solid ${P.bd}`, borderRadius: 5, padding: "4px 9px", fontSize: 11, cursor: "pointer", fontFamily: sans, fontWeight: 600 };

// A read-only context row (derived streams / payroll / balance).
function ReadRow({ label, vals, color = P.td, N, cm, bold, note }) {
  const v = norm(vals, N);
  return (
    <tr style={bold ? { fontWeight: 800 } : undefined}>
      <td style={{ padding: "3px 8px", color, borderBottom: `1px solid ${P.bd}15`, whiteSpace: "nowrap", position: "sticky", left: 0, background: P.bg, zIndex: 1 }}>
        {label}{note && <span style={{ color: P.td, fontSize: 9, marginLeft: 6, fontStyle: "italic" }}>{note}</span>}
      </td>
      {v.map((x, i) => (
        <td key={i} style={{ padding: "3px 6px", textAlign: "right", color, borderBottom: `1px solid ${P.bd}15`, fontFamily: mono, fontSize: 11, background: i === cm ? P.bB : "transparent" }}>{x ? fmt(x) : "—"}</td>
      ))}
      <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 700, color, borderBottom: `1px solid ${P.bd}15`, fontFamily: mono, fontSize: 12 }}>{fmt(sm(v))}</td>
    </tr>
  );
}

function GroupHead({ label, N, action }) {
  return (
    <tr>
      <td colSpan={N + 2} style={{ padding: "10px 8px 4px", borderBottom: `1px solid ${P.bd}`, position: "sticky", left: 0 }}>
        <span style={{ fontSize: 10, color: P.td, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, fontFamily: sans }}>{label}</span>
        {action}
      </td>
    </tr>
  );
}

// Impact KPI: saved baseline → projected (draft), with delta.
function Impact({ label, savedVal, draftVal, isMoney = true, suffix = "", colorFor }) {
  const delta = draftVal - savedVal;
  const dispVal = (x) => (isMoney ? fmt(x) : `${x}${suffix}`);
  const dColor = Math.abs(delta) < (isMoney ? 1 : 0.01) ? P.td : (delta > 0 ? P.g : P.r);
  const valColor = colorFor ? colorFor(draftVal) : P.tx;
  return (
    <div style={{ background: P.c1, border: `1px solid ${P.bd}`, borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 10, color: P.td, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, fontWeight: 600, fontFamily: sans }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: valColor, fontFamily: mono, lineHeight: 1 }}>{dispVal(draftVal)}</div>
      <div style={{ fontSize: 10, marginTop: 5, fontFamily: mono, color: P.tm }}>
        <span style={{ color: P.td }}>{dispVal(savedVal)}</span>
        {Math.abs(delta) >= (isMoney ? 1 : 0.01) && <span style={{ color: dColor, fontWeight: 700 }}>{"  "}({delta > 0 ? "+" : ""}{isMoney ? fmt(delta) : delta.toFixed(2) + suffix})</span>}
      </div>
    </div>
  );
}

export default function ForecastEditor({ d, saved, save }) {
  const N = horizonOf(d);
  const cm = Math.min(Math.max(0, currentMonthIdx()), N - 1);

  const c = useMemo(() => compute(d), [d]);
  const sc = useMemo(() => (saved ? compute(saved) : c), [saved, c]);

  const blDraft = baselineBalance(c, d.openBal);
  const blSaved = baselineBalance(sc, saved?.openBal ?? d.openBal);
  const runDraft = runwayMonths(blDraft, cm, d.openBal);
  const runSaved = runwayMonths(blSaved, cm, saved?.openBal ?? d.openBal);

  // Derived (read-only) rows for context.
  const derivedRev = c.rvDerived.im.map((_, i) => c.rvDerived.im[i] + c.rvDerived.za[i] + c.rvDerived.zm[i] + c.rvDerived.ot[i]);
  const payroll = c.us.map((_, i) => c.us[i] + c.ph[i] + c.ind[i]);

  const sv = saved || d;

  // --- updaters (all buffer through save) ---
  const setMk = (next) => save({ ...d, rv: { ...d.rv, mk: next } });
  const setVec = (field, next) => save({ ...d, [field]: next });
  const setOpenBal = (n) => save({ ...d, openBal: n });

  const updLine = (field, i, patch) => save({ ...d, [field]: d[field].map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setLineVec = (field, i, next) => updLine(field, i, { v: next });
  const addLine = (field, blank) => save({ ...d, [field]: [...(d[field] || []), blank] });
  const rmLine = (field, i) => save({ ...d, [field]: d[field].filter((_, j) => j !== i) });

  const addSub = () => save({ ...d, sb: [...(d.sb || []), { n: "New subscription", a: 0 }] });
  const updSub = (i, patch) => save({ ...d, sb: d.sb.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const rmSub = (i) => save({ ...d, sb: d.sb.filter((_, j) => j !== i) });

  const th = { padding: "5px 6px", textAlign: "right", color: P.td, fontSize: 10, borderBottom: `1px solid ${P.bd}`, fontFamily: sans, fontWeight: 600 };
  const addBtn = (onClick, text) => <button onClick={onClick} style={{ marginLeft: 10, background: "transparent", color: P.b, border: `1px solid ${P.bd}`, borderRadius: 5, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontFamily: sans, fontWeight: 600 }}>{text}</button>;

  return (
    <div>
      {/* Impact summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
        <Impact label="Baseline Runway" savedVal={runSaved} draftVal={runDraft} isMoney={false} suffix=" mo" colorFor={(v) => (v >= 9 ? P.g : v >= 6 ? P.a : P.r)} />
        <Impact label={`Ending Balance (${moLabel(N - 1)})`} savedVal={blSaved[N - 1]} draftVal={blDraft[N - 1]} colorFor={(v) => (v > 0 ? P.g : P.r)} />
        <Impact label="Total Revenue (horizon)" savedVal={sm(sc.rvBase)} draftVal={sm(c.rvBase)} colorFor={() => P.t} />
        <Impact label="Total Expense (horizon)" savedVal={sm(sc.exBase)} draftVal={sm(c.exBase)} colorFor={() => P.r} />
      </div>

      {/* Opening balance */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: P.td, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, fontFamily: sans }}>Opening Balance (Jan 2026)</span>
        <EditableNumber value={d.openBal} onCommit={setOpenBal}
          style={{ width: 120, textAlign: "right", background: d.openBal !== (sv.openBal) ? `${P.a}14` : P.c2, border: `1px solid ${d.openBal !== sv.openBal ? `${P.a}88` : P.bd}`, color: P.tx, borderRadius: 4, padding: "5px 8px", fontFamily: mono, fontSize: 12 }} />
        <span style={{ fontSize: 10, color: P.td, fontStyle: "italic" }}>shifts the whole balance curve</span>
      </div>

      {/* Subscriptions — flat $/mo with optional start/end, edited as a compact list */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: P.td, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, fontFamily: sans, marginBottom: 6 }}>
          Subscriptions (flat $/mo){addBtn(addSub, "+ Add subscription")}
        </div>
        <div style={{ display: "grid", gap: 5 }}>
          {(d.sb || []).map((s, i) => {
            const before = (sv.sb || [])[i];
            const ch = !before || before.n !== s.n || before.a !== s.a || before.s !== s.s || before.e !== s.e;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: ch ? `${P.a}10` : P.c1, border: `1px solid ${ch ? `${P.a}55` : P.bd}`, borderRadius: 6 }}>
                <button onClick={() => rmSub(i)} title="Remove" style={{ background: "transparent", border: "none", color: P.rM, cursor: "pointer", fontSize: 14 }}>×</button>
                <input value={s.n} onChange={(e) => updSub(i, { n: e.target.value })} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px dashed ${P.bd}`, color: P.tx, fontFamily: sans, fontSize: 12 }} />
                <span style={{ fontSize: 10, color: P.td }}>$/mo</span>
                <EditableNumber value={s.a} onCommit={(n) => updSub(i, { a: Math.abs(n) })} style={{ width: 80, textAlign: "right", background: P.c2, border: `1px solid ${P.bd}`, color: P.r, borderRadius: 4, padding: "4px 6px", fontFamily: mono, fontSize: 11 }} />
                <span style={{ fontSize: 10, color: P.td }}>start</span>
                <select value={s.s ?? ""} onChange={(e) => updSub(i, { s: e.target.value === "" ? undefined : +e.target.value })} style={sel}>
                  <option value="">Jan'26</option>{Array.from({ length: N }, (_, m) => <option key={m} value={m}>{moLabel(m)}</option>)}
                </select>
                <span style={{ fontSize: 10, color: P.td }}>end</span>
                <select value={s.e ?? ""} onChange={(e) => updSub(i, { e: e.target.value === "" ? undefined : +e.target.value })} style={sel}>
                  <option value="">ongoing</option>{Array.from({ length: N }, (_, m) => <option key={m} value={m}>{moLabel(m)}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Month grid for vector rows */}
      <div style={{ overflowX: "auto", border: `1px solid ${P.bd}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", position: "sticky", left: 0, background: P.bg, zIndex: 2, minWidth: 150 }}>Line</th>
              {Array.from({ length: N }, (_, i) => <th key={i} style={{ ...th, background: i === cm ? P.bB : "transparent", color: i === cm ? P.b : P.td }}>{moLabel(i)}</th>)}
              <th style={th}>Total</th>
            </tr>
          </thead>
          <tbody>
            <GroupHead label="Revenue — editable" N={N} />
            <VectorRow label="Marketing" color={P.g} sign={1} values={d.rv?.mk} savedValues={sv.rv?.mk} N={N} cm={cm} onChange={setMk} />
            <ReadRow label="Derived (Zoho · IM · One-Time)" note="↗ Clients tab" vals={derivedRev} N={N} cm={cm} color={P.td} />

            <GroupHead label="Other Costs" N={N} action={addBtn(() => addLine("oc", { n: "New cost", v: Array(N).fill(0) }), "+ Add line")} />
            {(d.oc || []).map((x, i) => (
              <VectorRow key={i} label={x.n} values={x.v} savedValues={(sv.oc || [])[i]?.v} N={N} cm={cm}
                onChange={(next) => setLineVec("oc", i, next)} onRemove={() => rmLine("oc", i)} onRename={(nm) => updLine("oc", i, { n: nm })} />
            ))}

            <GroupHead label="Debt" N={N} action={addBtn(() => addLine("db", { n: "New debt", v: Array(N).fill(0) }), "+ Add line")} />
            {(d.db || []).map((x, i) => (
              <VectorRow key={i} label={x.n} values={x.v} savedValues={(sv.db || [])[i]?.v} N={N} cm={cm}
                onChange={(next) => setLineVec("db", i, next)} onRemove={() => rmLine("db", i)} onRename={(nm) => updLine("db", i, { n: nm })} />
            ))}

            <GroupHead label="Employment Fees" N={N} />
            <VectorRow label="Emp Taxes" values={d.et} savedValues={sv.et} N={N} cm={cm} onChange={(next) => setVec("et", next)} />
            <VectorRow label="ADP Fees" values={d.af} savedValues={sv.af} N={N} cm={cm} onChange={(next) => setVec("af", next)} />
            <VectorRow label="Wise Fees" values={d.wf} savedValues={sv.wf} N={N} cm={cm} onChange={(next) => setVec("wf", next)} />
            <ReadRow label="Payroll (US · PH · IN)" note="↗ Payroll tab" vals={payroll} N={N} cm={cm} color={P.td} />

            <GroupHead label="Result" N={N} />
            <ReadRow label="Net Flow" vals={c.rvBase.map((v, i) => v + c.exBase[i])} N={N} cm={cm} color={P.tm} bold />
            <ReadRow label="Balance (baseline)" vals={blDraft} N={N} cm={cm} color={P.tx} bold />
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: P.td, marginTop: 8, fontFamily: sans }}>
        Edits buffer locally — totals, balance and runway update live above. Nothing is saved until you hit Save (⌘S). Subscriptions row excluded from the grid (it's a flat monthly amount); derived revenue & payroll are read-only here.
      </div>
    </div>
  );
}
const sel = { background: P.c2, border: `1px solid ${P.bd}`, borderRadius: 4, color: P.tx, fontSize: 11, padding: "3px 5px", fontFamily: "'DM Sans', sans-serif" };
