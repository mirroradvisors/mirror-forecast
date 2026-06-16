import { useState, useEffect } from "react";
import { P, MO, fmt, sm } from "./data.js";

// Number input that holds its value in local state while the user is typing
// and only commits to the parent on blur / Enter. Prevents intermediate
// values (empty string, 0, NaN) from triggering parent re-renders that
// could filter the row out mid-edit.
// `live`: commit each keystroke that parses to a valid number (so dependent
// computations update as you type); blur still normalizes empty → 0.
export function EditableNumber({ value, onCommit, style, placeholder, min, max, live = false }) {
  const [local, setLocal] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(value == null ? "" : String(value)); }, [value, focused]);
  const commit = () => {
    const raw = local.trim();
    if (raw === "") { if (0 !== value) onCommit(0); return; }
    const n = +raw;
    if (isNaN(n)) { setLocal(value == null ? "" : String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      value={local}
      placeholder={placeholder}
      min={min}
      max={max}
      onChange={(e) => {
        const v = e.target.value;
        setLocal(v);
        if (live) { const t = v.trim(); if (t !== "") { const n = +t; if (!isNaN(n) && n !== value) onCommit(n); } }
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      style={style}
    />
  );
}

export function Toast({ message, type }) {
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 1100,
      padding: "10px 18px", borderRadius: 8,
      background: type === "ok" ? P.gB : P.rB,
      border: `1px solid ${type === "ok" ? P.gM : P.rM}`,
      color: type === "ok" ? P.g : P.r,
      fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans', sans-serif",
      display: "flex", alignItems: "center", gap: 8,
      boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
    }}>
      <span>{type === "ok" ? "\u2713" : "\u2715"}</span>
      {message}
    </div>
  );
}

export function ClientProgressRow({ cl, onSegmentClick, expanded, onToggleExpand, children }) {
  const smo = cl.startMo ?? 0;
  const emo = cl.endMo ?? 11;
  const rate = cl.rt || 0;
  const termSegs = [];
  for (let i = smo; i <= emo; i++) termSegs.push({ i, s: cl.st[i] || "U" });
  const paid = termSegs.filter(x => x.s === "P").length;
  const late = termSegs.filter(x => x.s === "L").length;
  const total = termSegs.length;
  const collected = paid * rate;
  const maxT = total * rate;
  const segColor = s => s === "P" ? P.g : s === "L" ? P.r : s === "C" ? P.b : P.a;
  return (
    <div style={{ marginBottom: 8 }}>
      <div onClick={onToggleExpand} style={{ padding: "12px 4px 14px", cursor: onToggleExpand ? "pointer" : "default" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: P.tx, fontFamily: "'DM Sans', sans-serif", display: "flex", alignItems: "center", gap: 8 }}>
            {onToggleExpand && (
              <span style={{ fontSize: 9, color: P.td, display: "inline-block", transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "none" }}>{"\u25b6"}</span>
            )}
            {cl.nm}
          </div>
          <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>
            <span style={{ color: late > 0 ? P.r : P.tm, fontWeight: 600 }}>{paid}/{total} paid</span>
            <span style={{ color: P.td }}>{" \u00b7 "}</span>
            <span style={{ color: P.g }}>{fmt(collected)}</span>
            <span style={{ color: P.td }}>{" / "}{fmt(maxT)}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "hidden" }}>
          {termSegs.map((seg, i) => (
            <div key={i}
              onClick={(e) => { if (onSegmentClick) { e.stopPropagation(); onSegmentClick(seg.i); } }}
              title={`${MO[seg.i]}: ${seg.s}`}
              style={{ flex: 1, background: segColor(seg.s), cursor: onSegmentClick ? "pointer" : "default", borderRadius: 1 }} />
          ))}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "16px 18px", background: P.c2, borderRadius: 8, border: `1px solid ${P.bd}`, marginTop: 4, marginBottom: 4 }} onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}

// Shared status chip — same size/radius across the app.
// selected=true fills the chip; false shows an outline.
// active=false dims it (out-of-term cells).
export function StatusChip({ value, onClick, selected = false, active = true, size = 24 }) {
  const color = value === "P" ? P.g : value === "U" ? P.a : value === "L" ? P.r : value === "C" ? P.b : P.td;
  const bg = value === "P" ? P.gB : value === "U" ? P.aB : value === "L" ? P.rB : value === "C" ? P.bB : "transparent";
  return (
    <div onClick={active ? onClick : undefined} style={{
      width: size, height: size, borderRadius: 4,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
      background: selected ? bg : "transparent",
      color,
      border: `1px solid ${selected ? color : P.bd}`,
      cursor: active && onClick ? "pointer" : "default",
      userSelect: "none",
      opacity: active ? 1 : 0.4,
    }}>{active ? (value || "") : ""}</div>
  );
}

export function SaveBar({ dirty, saving, onSave, count, onDiscard }) {
  if (!dirty && !saving) return null;
  const label = typeof count === "number" && count > 0
    ? `${count} unsaved change${count === 1 ? "" : "s"}`
    : "Unsaved changes";
  return (
    <div style={{
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      background: P.c1,
      borderTop: `1px solid ${P.bd}`,
      padding: "14px 24px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      boxShadow: "0 -4px 20px rgba(0,0,0,0.5)",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: P.a }} />
        <span style={{ fontSize: 13, color: P.tx, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {onDiscard && (
          <button onClick={onDiscard} disabled={saving} style={{
            background: "transparent",
            color: P.tm,
            border: `1px solid ${P.bd}`,
            borderRadius: 6,
            padding: "9px 16px",
            fontSize: 12,
            fontWeight: 600,
            cursor: saving ? "default" : "pointer",
            fontFamily: "'DM Sans', sans-serif",
          }}>Discard</button>
        )}
        <button onClick={onSave} disabled={saving} style={{
          background: saving ? P.c2 : P.b,
          color: saving ? P.td : "#ffffff",
          border: "none",
          borderRadius: 6,
          padding: "9px 22px",
          fontSize: 13,
          fontWeight: 700,
          cursor: saving ? "default" : "pointer",
          fontFamily: "'DM Sans', sans-serif",
        }}>{saving ? "Saving\u2026" : "Save (\u2318S)"}</button>
      </div>
    </div>
  );
}

// Phase E2b \u2014 generic edit-in-place field. Click to enter edit mode, blur or
// Enter to commit (calls onChange with new value), Esc reverts. Integrates with
// the existing d/saved dirty mechanism \u2014 onChange just bubbles up to App's
// save() callback, which buffers the change. No parallel dirty system.
//
// Types: text | currency | integer | date | enum | boolean | longText
//   - longText: textarea with explicit \u2713 Save button (not blur-commit)
//   - boolean: toggle (no edit-mode dance \u2014 click flips immediately)
//   - enum: requires `options` prop = array of [value, label] pairs (or strings)
export function EditableField({ type = "text", value, onChange, options, placeholder, canEdit = true, displayFmt }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // ===== boolean: instant toggle, no edit mode =====
  if (type === "boolean") {
    const on = !!value;
    return (
      <button
        disabled={!canEdit}
        onClick={() => canEdit && onChange(!on)}
        style={{
          background: on ? P.gB : P.c2,
          color: on ? P.g : P.tm,
          border: `1px solid ${on ? P.gM : P.bd}`,
          borderRadius: 4,
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 600,
          cursor: canEdit ? "pointer" : "default",
          fontFamily: "'DM Sans', sans-serif",
          opacity: canEdit ? 1 : 0.6,
        }}
      >{on ? "Yes" : "No"}</button>
    );
  }

  // ===== enum: select element =====
  if (type === "enum") {
    const opts = (options || []).map(o => Array.isArray(o) ? o : [o, o]);
    return (
      <select
        disabled={!canEdit}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        style={{
          background: P.c2, border: `1px solid ${P.bd}`, borderRadius: 4,
          color: value ? P.tx : P.td, fontSize: 12, padding: "4px 8px",
          fontFamily: "'DM Sans', sans-serif",
          cursor: canEdit ? "pointer" : "default",
          opacity: canEdit ? 1 : 0.6,
        }}
      >
        <option value="">\u2014</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }

  // ===== display formatter (used in non-edit mode for currency/integer/date) =====
  const display = (() => {
    if (displayFmt) return displayFmt(value);
    if (value == null || value === "") return placeholder || "\u2014";
    if (type === "currency") return `$${Number(value).toLocaleString()}`;
    if (type === "integer") return String(value);
    return String(value);
  })();

  // ===== longText: textarea with explicit Save (per spec) =====
  if (type === "longText") {
    if (!editing) {
      return (
        <div
          onClick={() => { if (canEdit) { setDraft(value || ""); setEditing(true); } }}
          style={{
            color: value ? P.tx : P.td,
            fontStyle: value ? "normal" : "italic",
            fontSize: 13,
            fontFamily: "'DM Sans', sans-serif",
            lineHeight: 1.5,
            padding: "8px 10px",
            cursor: canEdit ? "text" : "default",
            background: P.c1,
            border: `1px solid ${P.bd}40`,
            borderRadius: 4,
            minHeight: 32,
            whiteSpace: "pre-wrap",
          }}
        >{value || (placeholder || "Click to add notes\u2026")}</div>
      );
    }
    return (
      <div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setDraft(""); } }}
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box",
            background: P.c2, border: `1px solid ${P.b}`, borderRadius: 4,
            color: P.tx, fontSize: 13, padding: 10, resize: "vertical",
            fontFamily: "'DM Sans', sans-serif", lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" }}>
          <button
            onClick={() => { setEditing(false); setDraft(""); }}
            style={{ background: "transparent", color: P.tm, border: `1px solid ${P.bd}`, borderRadius: 4, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}
          >Cancel</button>
          <button
            onClick={() => { onChange(draft); setEditing(false); }}
            style={{ background: P.b, color: "#ffffff", border: "none", borderRadius: 4, padding: "4px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 700 }}
          >\u2713 Save</button>
        </div>
      </div>
    );
  }

  // ===== text / currency / integer / date \u2014 click to edit, blur/Enter commits =====
  if (!editing) {
    return (
      <span
        onClick={() => { if (canEdit) { setDraft(value == null ? "" : String(value)); setEditing(true); } }}
        style={{
          color: value != null && value !== "" ? P.tx : P.td,
          fontStyle: value != null && value !== "" ? "normal" : "italic",
          fontSize: 12,
          fontFamily: type === "currency" || type === "integer" ? "'JetBrains Mono', monospace" : "'DM Sans', sans-serif",
          fontWeight: 500,
          padding: "2px 6px",
          borderRadius: 3,
          cursor: canEdit ? "text" : "default",
          borderBottom: canEdit ? `1px dashed ${P.bd}` : "none",
        }}
      >{display}</span>
    );
  }

  const commit = () => {
    let next = draft.trim();
    if (next === "") {
      onChange(null);
    } else if (type === "currency" || type === "integer") {
      const n = Number(next);
      if (!isNaN(n)) onChange(type === "integer" ? Math.round(n) : n);
    } else {
      onChange(next);
    }
    setEditing(false);
  };

  return (
    <input
      autoFocus
      type={type === "date" ? "date" : type === "currency" || type === "integer" ? "number" : "text"}
      step={type === "currency" ? "0.01" : type === "integer" ? "1" : undefined}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        else if (e.key === "Escape") { setDraft(value == null ? "" : String(value)); setEditing(false); }
      }}
      style={{
        background: P.c2, border: `1px solid ${P.b}`, borderRadius: 4,
        color: type === "currency" || type === "integer" ? P.a : P.tx,
        fontSize: 12, padding: "3px 8px",
        fontFamily: type === "currency" || type === "integer" ? "'JetBrains Mono', monospace" : "'DM Sans', sans-serif",
        textAlign: type === "currency" || type === "integer" ? "right" : "left",
        width: type === "currency" || type === "integer" ? 120 : 180,
      }}
    />
  );
}

export const Card = ({ children, style: s }) => (
  <div style={{ background: P.c1, borderRadius: 10, padding: 20, border: `1px solid ${P.bd}`, ...s }}>{children}</div>
);

export const Lbl = ({ children }) => (
  <div style={{ fontSize: 10, color: P.td, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>{children}</div>
);

export const Bdg = ({ children, c }) => (
  <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: c === "g" ? P.gB : c === "r" ? P.rB : P.aB, color: c === "g" ? P.g : c === "r" ? P.r : P.a }}>{children}</span>
);

export const NumIn = ({ value, onChange, w }) => (
  <input type="number" value={value} onChange={onChange} style={{ background: P.c2, border: `1px solid ${P.bd}`, color: P.a, borderRadius: 4, padding: "5px 8px", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, width: w || 70, textAlign: "right" }} />
);

export function Pie({ data: dd, size }) {
  const sz = size || 170;
  const total = dd.reduce((s, x) => s + x.value, 0);
  if (!total) return null;
  let cum = 0;
  const sl = dd.filter(x => x.value > 0).map(x => {
    const st = cum, pc = x.value / total; cum += pc;
    const r = sz / 2 - 3, cx = sz / 2, cy = sz / 2;
    const a1 = Math.PI * 2 * st - Math.PI / 2, a2 = Math.PI * 2 * (st + pc) - Math.PI / 2;
    return { ...x, pc, path: `M${cx},${cy} L${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} A${r},${r} 0 ${pc > .5 ? 1 : 0} 1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)} Z` };
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={sz} height={sz}>{sl.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke={P.bg} strokeWidth={2} />)}</svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>{sl.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
          <span style={{ color: P.tm }}>{s.label}</span>
          <span style={{ color: P.tx, fontWeight: 700, marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace" }}>{(s.pc * 100).toFixed(0)}%</span>
        </div>
      ))}</div>
    </div>
  );
}

// V2.1: XRow — line item numbers in muted white (P.tm), only TOTAL row stays red
export function XRow({ label, vals, details, win }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr style={{ cursor: details ? "pointer" : "default" }} onClick={() => details && setOpen(!open)}>
        <td style={{ padding: "5px 10px", color: P.tm, borderBottom: `1px solid ${P.bd}20` }}>
          {details ? <span style={{ display: "inline-block", width: 14, fontSize: 9, color: P.td, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0)" }}>{"\u25b6"}</span> : null}{label}
        </td>
        {vals.map((v, i) => <td key={i} style={{ padding: "5px 6px", textAlign: "right", color: P.tm, borderBottom: `1px solid ${P.bd}20`, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: win ? (win[i]?.isCurrent ? P.bB : "transparent") : "transparent" }}>{fmt(v)}</td>)}
        <td style={{ padding: "5px 6px", textAlign: "right", fontWeight: 700, color: P.r, borderBottom: `1px solid ${P.bd}20`, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{fmt(sm(vals))}</td>
      </tr>
      {open && details ? details.map((dd, di) => (
        <tr key={di} style={{ background: `${P.c2}80` }}>
          <td style={{ padding: "3px 10px 3px 30px", fontSize: 11, color: P.td, borderBottom: `1px solid ${P.bd}15`, fontFamily: "'DM Sans', sans-serif" }}>{dd.n}</td>
          {dd.v.map((v, i) => <td key={i} style={{ padding: "3px 6px", textAlign: "right", fontSize: 11, color: v ? P.td : `${P.td}60`, borderBottom: `1px solid ${P.bd}15`, fontFamily: "'JetBrains Mono', monospace" }}>{v ? fmt(v) : "\u2014"}</td>)}
          <td style={{ padding: "3px 6px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.tm, borderBottom: `1px solid ${P.bd}15`, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(sm(dd.v))}</td>
        </tr>
      )) : null}
    </>
  );
}

export function Sld({ label, value, onChange, min, max, step = 1, pre = "", suf = "", color = P.g }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: P.td, letterSpacing: "0.05em", textTransform: "uppercase", fontFamily: "'DM Sans', sans-serif" }}>{label}</span>
        <span style={{ fontSize: 12, color, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{pre}{typeof value === "number" ? value.toLocaleString() : value}{suf}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 5, appearance: "none", borderRadius: 3, cursor: "pointer", background: `linear-gradient(to right,${color} 0%,${color} ${pct}%,${P.c2} ${pct}%,${P.c2} 100%)`, outline: "none" }} />
    </div>
  );
}

export function KPI({ label, value, sub, color = P.g }) {
  return (
    <div style={{ background: P.c1, border: `1px solid ${P.bd}`, borderRadius: 8, padding: "12px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 10, color: P.td, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: P.td, marginTop: 4, fontFamily: "'DM Sans', sans-serif" }}>{sub}</div>}
    </div>
  );
}

export function Toggle({ label, value, onChange, color = P.g }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
      <div onClick={() => onChange(!value)} style={{
        width: 36, height: 20, borderRadius: 10, position: "relative",
        background: value ? `${color}40` : P.c2, border: `1px solid ${value ? color : P.bd}`,
        transition: "all 0.2s"
      }}>
        <div style={{
          width: 14, height: 14, borderRadius: 7, position: "absolute", top: 2,
          left: value ? 19 : 2, background: value ? color : P.td,
          transition: "left 0.2s"
        }} />
      </div>
      <span style={{ fontSize: 11, color: value ? P.tx : P.tm, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>{label}</span>
    </label>
  );
}