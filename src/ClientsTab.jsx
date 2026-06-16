// Clients tab — Paul-only reference list.
// One row per client with active service contract OR active Zoho commission.
// Service-ended-but-Zoho-active rows (Gomes, VanBoxel) intentionally surface
// as "Zoho · svc ended" so a churned service never hides a live commission.
// Admins can edit in place (Edit toggle in the detail panel); edits buffer into
// the draft `d` and persist via the SaveBar/⌘S. Forecast math is untouched.

import React, { useState, useMemo } from "react";
import ZohoSyncPanel from "./ZohoSyncPanel.jsx";

// Spec palette — scoped to this tab; intentionally not folded into P.
const T = {
  bg: "#111318",
  surface: "#1a1d24",
  surfaceAlt: "#22262e",
  hover: "#15181f",
  divider: "#ffffff0a",
  border: "#2a2e38",
  txt: "#ffffff",
  txtMuted: "#9b9790",
  txtChurned: "#c8c5be",
  green: "#7ec89b",
  blue: "#5a7fb0",
  greyEnded: "#6b6864",
  amber: "#e0a890",
  serviceChurned: "#a37272",
};

const MO_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const FONT_SANS = "'DM Sans', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

// ─── helpers ────────────────────────────────────────────────────────────────

function isScActive(sc) {
  return !!sc && sc.status !== "churned" && sc.inForecast !== false;
}
function isZcActive(zc) {
  return !!zc && zc.status !== "churned" && zc.inForecast !== false;
}

// kind: "service-zoho" | "zoho-only" | "svc-ended" | null (excluded from list)
function statusKind(c) {
  const scActive = isScActive(c.serviceContract);
  const zcActive = isZcActive(c.zohoCommission);
  if (scActive) return "service-zoho";
  if (zcActive && c.serviceContract) return "svc-ended";
  if (zcActive) return "zoho-only";
  return null;
}

// Total annual value.
// - Retainer / support-retainer: monthlyAmount * 12 (forward run rate)
// - Project / bank-of-hours / one-time: sum of unpaid future paymentSchedule
//   entries (Plastics monthlyAmount=12000 is legacy; the schedule is truth).
// - Zoho: monthlyAmount*12 + annualAmount (whichever applies per frequency).
function annualValue(c, today) {
  const sc = c.serviceContract;
  const zc = c.zohoCommission;
  let svc = 0;
  if (isScActive(sc)) {
    if (sc.type === "retainer" || sc.type === "support-retainer") {
      svc = (sc.monthlyAmount || 0) * 12;
    } else {
      svc = (sc.paymentSchedule || [])
        .filter(p => !p.paid && new Date(p.dueDate) >= today)
        .reduce((s, p) => s + (p.amount || 0), 0);
    }
  }
  let zoho = 0;
  if (isZcActive(zc)) {
    zoho = (zc.monthlyAmount || 0) * 12 + (zc.annualAmount || 0);
  }
  return svc + zoho;
}

function endsSoon(sc, today) {
  if (!sc?.endDate) return false;
  const d = new Date(sc.endDate);
  if (isNaN(d)) return false;
  const days = (d.getTime() - today.getTime()) / 86400000;
  return days >= 0 && days <= 90;
}

function fmtEndDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return `${MO_SHORT[m - 1]} ${d} '${String(y).slice(-2)}`;
}

function endDateInline(c) {
  const sc = c.serviceContract;
  if (!isScActive(sc)) return null;
  if (sc.endDate) return `service ends ${fmtEndDate(sc.endDate)}`;
  return "month-to-month";
}

function fmtAnnual(n) {
  if (!n || n <= 0) return "$0/yr";
  if (n < 1000) return `$${Math.round(n)}/yr`;
  return `$${(n / 1000).toFixed(1)}k/yr`;
}

function nextZohoRenewal(c, today) {
  const zc = c.zohoCommission;
  if (!isZcActive(zc)) return Number.POSITIVE_INFINITY;
  if (zc.frequency === "annual" && zc.renewalDate) {
    const t = new Date(zc.renewalDate).getTime();
    return isNaN(t) ? Number.POSITIVE_INFINITY : t;
  }
  if (zc.frequency === "monthly" && zc.renewalDay) {
    const next = new Date(today.getFullYear(), today.getMonth(), zc.renewalDay);
    if (next < today) next.setMonth(next.getMonth() + 1);
    return next.getTime();
  }
  return Number.POSITIVE_INFINITY;
}

const dotColorFor = (kind) =>
  kind === "service-zoho" ? T.green : kind === "zoho-only" ? T.blue : T.greyEnded;

const statusLabelFor = (kind) =>
  kind === "service-zoho" ? "Service + Zoho" : kind === "zoho-only" ? "Zoho only" : "Zoho · svc ended";

const SERVICE_TYPE_LABEL = {
  "retainer":          "Retainer",
  "support-retainer":  "Support retainer",
  "project":           "Project",
  "bank-of-hours":     "Bank of hours",
  "one-time":          "One-time",
};

const hasMonthlyAmount = (type) => type === "retainer" || type === "support-retainer";

// ─── inline SVG flag (lieu of @tabler/icons-react ti-flag) ──────────────────

function FlagIcon({ color = T.amber, size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M4 22V4a2 2 0 0 1 2-2h11l-2 5h7v8H8" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

// ─── row ────────────────────────────────────────────────────────────────────

function ClientRow({ client, today, selected, onClick }) {
  const kind = statusKind(client);
  const sc = client.serviceContract;
  const dot = dotColorFor(kind);
  const flag = endsSoon(sc, today);
  const endStr = endDateInline(client);
  const annual = annualValue(client, today);
  const churnedRow = kind === "svc-ended";
  const [hover, setHover] = useState(false);
  const isLit = hover || selected;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 16px",
        background: isLit ? T.hover : "transparent",
        borderBottom: `1px solid ${T.divider}`,
        borderRadius: isLit ? 6 : 0,
        cursor: "pointer",
        transition: "background 0.08s",
        opacity: churnedRow ? 0.92 : 1,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <span style={{ fontSize: 14, fontWeight: 500, color: churnedRow ? T.txtChurned : T.txt, fontFamily: FONT_SANS, whiteSpace: "nowrap" }}>
        {client.nm}
      </span>
      {endStr && (
        <span style={{ fontSize: 12, color: flag ? T.amber : T.txtMuted, fontFamily: FONT_SANS, whiteSpace: "nowrap" }}>
          {endStr}
        </span>
      )}
      {flag && <FlagIcon color={T.amber} />}
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
        <span
          style={{
            fontSize: 10, fontWeight: 600,
            padding: "3px 10px", borderRadius: 11,
            background: `${dot}1f`, color: dot,
            fontFamily: FONT_SANS, whiteSpace: "nowrap",
            letterSpacing: "0.01em",
          }}
        >
          {statusLabelFor(kind)}
        </span>
        <span style={{ fontSize: 12, color: T.txtMuted, fontFamily: FONT_MONO, minWidth: 72, textAlign: "right" }}>
          {fmtAnnual(annual)}
        </span>
      </span>
    </div>
  );
}

// ─── detail panel (below the list) ──────────────────────────────────────────

function DetailRow({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: T.txtMuted, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600, marginBottom: 6, fontFamily: FONT_SANS }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: T.txt, fontFamily: FONT_SANS }}>{children}</div>
    </div>
  );
}

// ─── in-place edit primitives (admin only) ──────────────────────────────────

const inputStyle = {
  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5, color: T.txt,
  fontFamily: FONT_SANS, fontSize: 13, padding: "6px 8px", width: "100%", boxSizing: "border-box",
};
const EText = ({ value, onChange, placeholder, mono }) => (
  <input value={value ?? ""} placeholder={placeholder} onChange={e => onChange(e.target.value)}
    style={{ ...inputStyle, fontFamily: mono ? FONT_MONO : FONT_SANS }} />
);
const ELong = ({ value, onChange, placeholder }) => (
  <textarea value={value ?? ""} placeholder={placeholder} rows={2} onChange={e => onChange(e.target.value)}
    style={{ ...inputStyle, resize: "vertical" }} />
);
const ENum = ({ value, onChange, min }) => (
  <input type="number" value={value ?? ""} min={min}
    onChange={e => onChange(e.target.value === "" ? null : (min != null ? Math.max(min, Number(e.target.value)) : Number(e.target.value)))}
    style={{ ...inputStyle, fontFamily: FONT_MONO, textAlign: "right" }} />
);
const EDate = ({ value, onChange }) => (
  <input type="date" value={value ?? ""} onChange={e => onChange(e.target.value || null)}
    style={{ ...inputStyle, fontFamily: FONT_MONO }} />
);
const ESelect = ({ value, onChange, options }) => (
  <select value={value ?? ""} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);
const EBool = ({ value, onChange, label }) => (
  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.txt, cursor: "pointer", fontFamily: FONT_SANS, paddingTop: 6 }}>
    <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {label}
  </label>
);
const Field = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 10, color: T.txtMuted, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600, marginBottom: 5, fontFamily: FONT_SANS }}>{label}</div>
    {children}
  </div>
);

const CONTRACT_TYPES = ["retainer", "support-retainer", "project", "bank-of-hours", "one-time"].map(v => ({ value: v, label: SERVICE_TYPE_LABEL[v] }));
const SEGMENTS = ["infinityMirror", "supportRetainer", "bankOfHours", "fullProject", "zohoCommissionOnly", "oneTime"].map(v => ({ value: v, label: v }));
const STATUSES = [["active", "Active"], ["at-risk", "At risk"], ["churned", "Churned"], ["pipeline", "Pipeline"]].map(([value, label]) => ({ value, label }));
const FREQS = [["monthly", "Monthly"], ["annual", "Annual"]].map(([value, label]) => ({ value, label }));
const PAY_STATUSES = [["P", "Paid"], ["U", "Upcoming"], ["L", "Late"], ["C", "Churned"]].map(([value, label]) => ({ value, label }));

const sectionHdr = { fontSize: 12, fontWeight: 700, color: T.txt, margin: "18px 0 10px", fontFamily: FONT_SANS };
const grid2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
const ghostBtn = { background: "transparent", border: `1px solid ${T.border}`, color: T.txtMuted, borderRadius: 5, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS };

// Full edit form for one client. Every change calls onChange(updatedClient),
// which buffers into the draft `d`; the global SaveBar/⌘S persists (cl bundle
// → atomic save_forecast_rows RPC).
function EditForm({ client, onChange }) {
  const c = client;
  const sc = c.serviceContract;
  const zc = c.zohoCommission;
  const set = (patch) => onChange({ ...c, ...patch });
  const setSc = (patch) => onChange({ ...c, serviceContract: { ...sc, ...patch } });
  const setZc = (patch) => onChange({ ...c, zohoCommission: { ...zc, ...patch } });

  const addContract = () => set({ serviceContract: { type: "retainer", segment: "infinityMirror", monthlyAmount: 0, monthlyRenewalDay: null, startDate: null, endDate: null, status: "active", inForecast: true, paymentSchedule: [] } });
  const addZoho = () => set({ zohoCommission: { zohoProduct: "One", licenses: 0, frequency: "monthly", monthlyAmount: 0, annualAmount: 0, renewalDate: null, renewalDay: null, status: "active", inForecast: true, note: "" } });

  const sched = sc?.paymentSchedule || [];
  const setSched = (ns) => setSc({ paymentSchedule: ns });
  const editEntry = (i, patch) => setSched(sched.map((p, j) => j === i ? { ...p, ...patch } : p));
  const addEntry = () => setSched([...sched, { dueDate: null, amount: 0, paid: false, paidDate: null, note: "", status: "U" }]);
  const delEntry = (i) => setSched(sched.filter((_, j) => j !== i));

  return (
    <div>
      <div style={grid2}>
        <Field label="Client name"><EText value={c.nm} onChange={v => set({ nm: v })} placeholder="Name" /></Field>
        <Field label="Email"><EText value={c.email} onChange={v => set({ email: v || null })} placeholder="email@…" mono /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Field label="Notes"><ELong value={c.notes} onChange={v => set({ notes: v })} placeholder="Notes" /></Field>
      </div>

      {/* Service contract */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={sectionHdr}>Service Contract</div>
        {sc
          ? <button onClick={() => set({ serviceContract: null })} style={{ ...ghostBtn, color: T.serviceChurned, borderColor: T.serviceChurned + "66", marginTop: 8 }}>Remove</button>
          : <button onClick={addContract} style={{ ...ghostBtn, marginTop: 8 }}>+ Add contract</button>}
      </div>
      {sc && (
        <>
          <div style={grid2}>
            <Field label="Type"><ESelect value={sc.type} onChange={v => setSc({ type: v })} options={CONTRACT_TYPES} /></Field>
            <Field label="Segment"><ESelect value={sc.segment} onChange={v => setSc({ segment: v })} options={SEGMENTS} /></Field>
            <Field label="Monthly amount"><ENum value={sc.monthlyAmount} onChange={v => setSc({ monthlyAmount: v })} min={0} /></Field>
            <Field label="Renewal day"><ENum value={sc.monthlyRenewalDay} onChange={v => setSc({ monthlyRenewalDay: v })} min={1} /></Field>
            <Field label="Start date"><EDate value={sc.startDate} onChange={v => setSc({ startDate: v })} /></Field>
            <Field label="End date"><EDate value={sc.endDate} onChange={v => setSc({ endDate: v })} /></Field>
            <Field label="Status"><ESelect value={sc.status} onChange={v => setSc({ status: v })} options={STATUSES} /></Field>
            <Field label="In forecast"><EBool value={sc.inForecast !== false} onChange={v => setSc({ inForecast: v })} label="Counts toward forecast" /></Field>
          </div>

          <div style={{ ...sectionHdr, fontSize: 11, color: T.txtMuted }}>Payment schedule</div>
          {sched.length === 0 && <div style={{ fontSize: 12, color: T.txtMuted, marginBottom: 8 }}>No entries.</div>}
          {sched.map((p, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "130px 90px 100px 90px 1fr 28px", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <EDate value={p.dueDate} onChange={v => editEntry(i, { dueDate: v })} />
              <ENum value={p.amount} onChange={v => editEntry(i, { amount: v })} min={0} />
              <ESelect value={p.status || "U"} onChange={v => editEntry(i, { status: v })} options={PAY_STATUSES} />
              <EBool value={p.paid} onChange={v => editEntry(i, { paid: v })} label="paid" />
              <EText value={p.note} onChange={v => editEntry(i, { note: v })} placeholder="note" />
              <button onClick={() => delEntry(i)} style={{ background: "transparent", border: "none", color: T.serviceChurned, fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
          ))}
          <button onClick={addEntry} style={{ ...ghostBtn, marginTop: 4 }}>+ Add payment</button>
        </>
      )}

      {/* Zoho commission */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={sectionHdr}>Zoho Commission</div>
        {zc
          ? <button onClick={() => set({ zohoCommission: null })} style={{ ...ghostBtn, color: T.serviceChurned, borderColor: T.serviceChurned + "66", marginTop: 8 }}>Remove</button>
          : <button onClick={addZoho} style={{ ...ghostBtn, marginTop: 8 }}>+ Add Zoho</button>}
      </div>
      {zc && (
        <div style={grid2}>
          <Field label="Product"><EText value={zc.zohoProduct} onChange={v => setZc({ zohoProduct: v })} /></Field>
          <Field label="Licenses"><ENum value={zc.licenses} onChange={v => setZc({ licenses: v })} min={0} /></Field>
          <Field label="Frequency"><ESelect value={zc.frequency} onChange={v => setZc({ frequency: v })} options={FREQS} /></Field>
          <Field label="Status"><ESelect value={zc.status} onChange={v => setZc({ status: v })} options={STATUSES} /></Field>
          <Field label="Monthly amount"><ENum value={zc.monthlyAmount} onChange={v => setZc({ monthlyAmount: v })} min={0} /></Field>
          <Field label="Annual amount"><ENum value={zc.annualAmount} onChange={v => setZc({ annualAmount: v })} min={0} /></Field>
          <Field label="Renewal date"><EDate value={zc.renewalDate} onChange={v => setZc({ renewalDate: v })} /></Field>
          <Field label="Renewal day"><ENum value={zc.renewalDay} onChange={v => setZc({ renewalDay: v })} min={1} /></Field>
          <Field label="In forecast"><EBool value={zc.inForecast !== false} onChange={v => setZc({ inForecast: v })} label="Counts toward forecast" /></Field>
          <Field label="Note"><EText value={zc.note} onChange={v => setZc({ note: v })} /></Field>
        </div>
      )}
    </div>
  );
}

function DetailPanel({ client, today, onClose, canEdit, onChange }) {
  const [editing, setEditing] = useState(false);
  const kind = statusKind(client);
  const dot = dotColorFor(kind);
  const sc = client.serviceContract;
  const zc = client.zohoCommission;
  const annual = annualValue(client, today);
  const scActive = isScActive(sc);

  return (
    <div style={{ background: T.surface, borderLeft: `3px solid ${dot}`, borderRadius: 6, padding: "20px 24px", marginTop: 18, fontFamily: FONT_SANS }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: T.txt }}>{client.nm}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {canEdit && (
            <button onClick={() => setEditing(e => !e)} style={{ background: editing ? `${T.green}22` : "transparent", border: `1px solid ${editing ? T.green + "66" : T.border}`, color: editing ? T.green : T.txtMuted, borderRadius: 5, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS }}>{editing ? "Done" : "Edit"}</button>
          )}
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: T.txtMuted, fontSize: 22, lineHeight: 1, cursor: "pointer", padding: "0 6px" }}>×</button>
        </div>
      </div>

      {editing ? (
        <EditForm client={client} onChange={onChange} />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 18 }}>
            <DetailRow label="Service">
              {sc ? (
                scActive ? (
                  hasMonthlyAmount(sc.type) ? (
                    <span>
                      <span style={{ fontFamily: FONT_MONO }}>${(sc.monthlyAmount || 0).toLocaleString()}</span>
                      <span style={{ color: T.txtMuted }}>/mo · </span>
                      <span style={{ color: T.txtMuted }}>{sc.endDate ? `ends ${fmtEndDate(sc.endDate)}` : "month-to-month"}</span>
                    </span>
                  ) : (
                    <span>
                      <span>{SERVICE_TYPE_LABEL[sc.type] || sc.type}</span>
                      <span style={{ color: T.txtMuted }}>{sc.endDate ? ` · ends ${fmtEndDate(sc.endDate)}` : ""}</span>
                    </span>
                  )
                ) : (
                  <span style={{ color: T.serviceChurned, fontStyle: "italic" }}>churned</span>
                )
              ) : (
                <span style={{ color: T.txtMuted }}>—</span>
              )}
            </DetailRow>

            <DetailRow label="Zoho Commission">
              {isZcActive(zc) ? (
                zc.frequency === "monthly" ? (
                  <span>
                    <span style={{ fontFamily: FONT_MONO }}>${(zc.monthlyAmount || 0).toLocaleString()}</span>
                    <span style={{ color: T.txtMuted }}>/mo · monthly</span>
                    {zc.renewalDay ? (<span style={{ color: T.txtMuted }}> · renews day {zc.renewalDay}</span>) : null}
                  </span>
                ) : (
                  <span>
                    <span style={{ fontFamily: FONT_MONO }}>${(zc.annualAmount || 0).toLocaleString()}</span>
                    <span style={{ color: T.txtMuted }}>/yr · annual</span>
                    {zc.renewalDate ? (<span style={{ color: T.txtMuted }}> · renews <span style={{ fontFamily: FONT_MONO }}>{fmtEndDate(zc.renewalDate)}</span></span>) : null}
                  </span>
                )
              ) : (
                <span style={{ color: T.txtMuted }}>—</span>
              )}
            </DetailRow>
          </div>

          <div style={{ borderTop: `1px solid ${T.divider}`, paddingTop: 14 }}>
            <div style={{ fontSize: 10, color: T.txtMuted, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600, marginBottom: 6 }}>Total Annual Value</div>
            <div style={{ fontSize: 20, color: T.green, fontFamily: FONT_MONO, fontWeight: 600 }}>{fmtAnnual(annual)}</div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── legend ─────────────────────────────────────────────────────────────────

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      <span>{label}</span>
    </span>
  );
}

// ─── main ───────────────────────────────────────────────────────────────────

export default function ClientsTab({ d, save, isAdmin }) {
  const today = useMemo(() => new Date(), []);
  const [filter, setFilter] = useState("all");      // all | service | zoho
  const [sortBy, setSortBy] = useState("value");    // value | zoho
  const [selectedId, setSelectedId] = useState(null);
  const [showSync, setShowSync] = useState(false);

  // Admin edits buffer into the draft `d` (replace the edited client by id);
  // the global SaveBar/⌘S persists — cl changes route through the atomic RPC.
  const onClientChange = (updated) => {
    if (!isAdmin || !save) return;
    const stamped = { ...updated, lastEditedAt: new Date().toISOString() };
    save({ ...d, cl: (d.cl || []).map(c => (c.id === stamped.id ? stamped : c)) });
  };

  // One pass: enrich each cl[] entry with derived fields, drop excluded clients.
  const enriched = useMemo(() => {
    return (d.cl || [])
      .map(c => ({
        c,
        kind: statusKind(c),
        annual: annualValue(c, today),
        nextRenew: nextZohoRenewal(c, today),
      }))
      .filter(x => x.kind !== null);
  }, [d.cl, today]);

  const filtered = useMemo(() => {
    if (filter === "service") return enriched.filter(x => x.kind === "service-zoho");
    if (filter === "zoho") return enriched.filter(x => x.kind === "zoho-only" || x.kind === "svc-ended");
    return enriched;
  }, [enriched, filter]);

  const sorted = useMemo(() => {
    const a = [...filtered];
    if (sortBy === "value") a.sort((x, y) => y.annual - x.annual);
    else if (sortBy === "zoho") a.sort((x, y) => x.nextRenew - y.nextRenew);
    return a;
  }, [filtered, sortBy]);

  const selected = enriched.find(x => x.c.id === selectedId) || null;

  const pillBtn = (active) => ({
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 600,
    fontFamily: FONT_SANS,
    background: active ? T.surfaceAlt : "transparent",
    color: active ? T.txt : T.txtMuted,
    border: `1px solid ${active ? T.border : "transparent"}`,
    borderRadius: 6,
    cursor: "pointer",
  });

  return (
    <div style={{ color: T.txt, fontFamily: FONT_SANS }}>
      {/* Header */}
      <div style={{ marginBottom: 24, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", color: T.txt }}>
            Clients
          </div>
          <div style={{ fontSize: 12, color: T.txtMuted, marginTop: 4 }}>
            {enriched.length} active · service + Zoho licensing
          </div>
        </div>
        {isAdmin && (
          <button onClick={() => setShowSync(v => !v)} style={{ background: showSync ? T.surfaceAlt : "transparent", color: showSync ? T.txt : T.txtMuted, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap" }}>
            {showSync ? "Hide Zoho sync" : "⟳ Sync from Zoho"}
          </button>
        )}
      </div>

      {isAdmin && showSync && <ZohoSyncPanel d={d} save={save} onClose={() => setShowSync(false)} />}

      {/* Filter + sort */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "All"], ["service", "Service"], ["zoho", "Zoho only"]].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} style={pillBtn(filter === k)}>{l}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          style={{
            background: T.surface,
            color: T.txtMuted,
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 11,
            fontFamily: FONT_SANS,
            cursor: "pointer",
          }}
        >
          <option value="value">Sort: total annual value</option>
          <option value="zoho">Sort: Zoho renewal date</option>
        </select>
      </div>

      {/* List */}
      <div style={{ background: T.surface, borderRadius: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
        {sorted.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: T.txtMuted, fontSize: 12 }}>
            No clients match this filter.
          </div>
        ) : (
          sorted.map(({ c }) => (
            <ClientRow
              key={c.id}
              client={c}
              today={today}
              selected={selectedId === c.id}
              onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
            />
          ))
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel client={selected.c} today={today} onClose={() => setSelectedId(null)} canEdit={!!isAdmin} onChange={onClientChange} />
      )}

      {/* Legend */}
      <div
        style={{
          marginTop: 28,
          paddingTop: 14,
          borderTop: `1px solid ${T.divider}`,
          display: "flex",
          gap: 24,
          fontSize: 11,
          color: T.txtMuted,
          flexWrap: "wrap",
          fontFamily: FONT_SANS,
        }}
      >
        <LegendDot color={T.green} label="Service + Zoho" />
        <LegendDot color={T.blue} label="Zoho only" />
        <LegendDot color={T.greyEnded} label="Service ended · Zoho continues" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <FlagIcon color={T.amber} />
          <span>Ending within 90 days</span>
        </span>
      </div>
    </div>
  );
}
