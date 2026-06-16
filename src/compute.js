import { MO } from "./data.js";

// Forecast horizon is anchored at Jan 2026 (idx 0). The horizon LENGTH (N) is now
// DERIVED from the data (longest monthly vector, floored at 24) so the forecast
// rolls forward automatically as later-dated months are added — see horizonOf().
export const BASE_YEAR = 2026;
const idxRange = (n) => Array.from({ length: n }, (_, i) => i);

// Length of the forecast horizon for dataset d: explicit d.horizon wins, else the
// longest monthly vector present, never below 24 months.
export function horizonOf(d) {
  const lens = [d?.et, d?.af, d?.wf, d?.rv?.mk, d?.rv?.ot, d?.rv?.pCruzy, d?.rv?.pPatson];
  (d?.oc || []).forEach((x) => lens.push(x?.v));
  (d?.db || []).forEach((x) => lens.push(x?.v));
  const max = lens.reduce((m, a) => Math.max(m, Array.isArray(a) ? a.length : 0), 0);
  return d?.horizon || Math.max(24, max);
}

// Horizon index of the current calendar month, anchored at BASE_YEAR/Jan (idx 0).
// Date-driven so it stays correct across the 2026→2027 rollover (getMonth() alone
// would reset to 0 every January). Callers clamp to [0, N-1].
export function currentMonthIdx(today = new Date()) {
  const t = today instanceof Date ? today : new Date();
  return (t.getFullYear() - BASE_YEAR) * 12 + t.getMonth();
}

// "2026-05-01" → 4 (May 2026, 0-indexed within the horizon)
function monthIdxFromDate(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  return (y - BASE_YEAR) * 12 + (mo - 1);
}

// Status gate — active or at-risk contracts contribute; churned/pipeline don't.
const isLive = (status) => status === "active" || status === "at-risk";

// Decimal runway in months, walking positive balances from `fromIdx` and
// interpolating the fractional remainder when crossing zero — or projecting past
// the array end on the last-3-month average burn. Rounded to 0.25. Extracted from
// App so the Forecast editor's impact panel computes runway identically.
export function runwayMonths(bal, fromIdx, openBal) {
  let count = 0;
  let i = fromIdx;
  while (i < bal.length && bal[i] > 0) { count++; i++; }
  if (i < bal.length) {
    const lastPos = bal[i - 1];
    const burn = lastPos - bal[i];
    if (burn > 0) count += Math.min(lastPos / burn, 1);
  } else {
    const buffer = bal[bal.length - 1];
    const ntDerived = bal.map((v, idx) => idx === 0 ? v - openBal : v - bal[idx - 1]);
    const last3 = ntDerived.slice(-3);
    const avgNet = last3.reduce((s, v) => s + v, 0) / last3.length;
    const projectedBurn = -avgNet;
    if (projectedBurn > 0 && buffer > 0) count += buffer / projectedBurn;
  }
  return Math.round(count * 4) / 4;
}

// Baseline (scenario-free) balance curve from compute() output + opening balance.
export function baselineBalance(c, openBal) {
  const nt = c.rvBase.map((v, i) => v + c.exBase[i]);
  const bl = [];
  nt.forEach((n, i) => bl.push(i === 0 ? openBal + n : bl[i - 1] + n));
  return bl;
}

export function compute(d) {
  const N = horizonOf(d);
  // === Derive per-stream revenue from cl[] ===
  const rvDerived = {
    im: new Array(N).fill(0),
    za: new Array(N).fill(0),
    zm: new Array(N).fill(0),
    ot: new Array(N).fill(0),
  };
  const rvBreakdown = { im: [], za: [], zm: [], ot: [] };

  (d.cl || []).forEach(c => {
    const sc = c.serviceContract;
    const zc = c.zohoCommission;

    if (sc && sc.inForecast !== false && isLive(sc.status)) {
      // Retainer / support-retainer → rv.im monthly through endDate (contract terms).
      if (sc.type === "retainer" || sc.type === "support-retainer") {
        const monthly = new Array(N).fill(0);
        const startIdx = sc.startDate ? Math.max(0, monthIdxFromDate(sc.startDate) ?? 0) : 0;
        const endIdx = sc.endDate
          ? Math.min(N - 1, monthIdxFromDate(sc.endDate) ?? (N - 1))
          : (N - 1);
        for (let i = startIdx; i <= endIdx; i++) monthly[i] = sc.monthlyAmount || 0;
        for (let i = 0; i < N; i++) rvDerived.im[i] += monthly[i];
        rvBreakdown.im.push({ clientId: c.id, clientName: c.nm, monthly });
      }

      // Project → rv.im from unpaid future paymentSchedule entries (E2c.4: F1 extended).
      // paymentSchedule is canonical; contract endDate becomes advisory.
      if (sc.type === "project") {
        const sched = sc.paymentSchedule || [];
        const monthly = new Array(N).fill(0);
        sched.forEach(p => {
          if (p.paid) return;
          const idx = monthIdxFromDate(p.dueDate);
          if (idx === null || idx < 0 || idx >= N) return;
          monthly[idx] += p.amount || 0;
        });
        for (let i = 0; i < N; i++) rvDerived.im[i] += monthly[i];
        rvBreakdown.im.push({ clientId: c.id, clientName: c.nm, monthly });
      }

      // Bank-of-hours / one-time → unpaid future paymentSchedule entries → rv.ot.
      // F1 fix (E2b): forward revenue from drawdown contracts must land in the forecast.
      if (sc.type === "bank-of-hours" || sc.type === "one-time") {
        const sched = sc.paymentSchedule || [];
        let otEntry = null;
        sched.forEach(p => {
          if (p.paid) return; // historical paid — already in actuals or not forward
          const idx = monthIdxFromDate(p.dueDate);
          if (idx === null || idx < 0 || idx >= N) return;
          if (!otEntry) {
            otEntry = { clientId: c.id, clientName: c.nm, monthly: new Array(N).fill(0) };
            rvBreakdown.ot.push(otEntry);
          }
          otEntry.monthly[idx] += p.amount || 0;
          rvDerived.ot[idx] += p.amount || 0;
        });
      }
    }

    // Zoho commission → monthly to rv.zm; annual chunk to rv.za at renewal month.
    if (zc && zc.inForecast !== false && isLive(zc.status)) {
      const monthly = new Array(N).fill(0);
      if (zc.frequency === "monthly") {
        // Q1 lockin: monthly Zoho renewalDate is informational only — recurs indefinitely.
        const amt = zc.monthlyAmount || 0;
        for (let i = 0; i < N; i++) monthly[i] = amt;
        for (let i = 0; i < N; i++) rvDerived.zm[i] += monthly[i];
        rvBreakdown.zm.push({ clientId: c.id, clientName: c.nm, monthly });
      } else if (zc.frequency === "annual") {
        // Derive renewalMonth from renewalDate (single source of truth — no drift).
        const renewalIdx = zc.renewalDate ? monthIdxFromDate(zc.renewalDate) : null;
        if (renewalIdx !== null && renewalIdx >= 0 && renewalIdx < N) {
          monthly[renewalIdx] = zc.annualAmount || 0;
          rvDerived.za[renewalIdx] += monthly[renewalIdx];
        }
        rvBreakdown.za.push({ clientId: c.id, clientName: c.nm, monthly });
      }
    }
  });

  // Apply Q1 2026 actuals overrides (idx 0-3) — preserves reconciled history
  const ra = d.rvActuals || {};
  ["im", "za", "zm"].forEach(stream => {
    if (ra[stream]) {
      Object.entries(ra[stream]).forEach(([k, v]) => {
        const idx = parseInt(k, 10);
        if (idx >= 0 && idx < N) rvDerived[stream][idx] = v;
      });
    }
  });

  // Manual streams: mk + pipeline (pCruzy, pPatson) — extend to 24 if shorter
  const padTo = (arr) => {
    const a = (arr || []).slice(0, N);
    while (a.length < N) a.push(0);
    return a;
  };
  const rvManual = {
    mk: padTo(d.rv?.mk),
    pCruzy: padTo(d.rv?.pCruzy),
    pPatson: padTo(d.rv?.pPatson),
  };

  // Total revenue across all streams
  const rv = idxRange(N).map(i =>
    rvDerived.im[i] + rvDerived.za[i] + rvDerived.zm[i] + rvDerived.ot[i] +
    rvManual.mk[i] + rvManual.pCruzy[i] + rvManual.pPatson[i]
  );

  // === Expenses (unchanged structure) ===
  const sb = idxRange(N).map(i => -d.sb.reduce((s, x) => {
    if (x.s && i < x.s) return s;
    if (x.e !== undefined && i > x.e) return s;
    return s + x.a;
  }, 0));
  const oc = idxRange(N).map(i => d.oc.reduce((s, c) => s + (c.v[i] || 0), 0));
  const db = idxRange(N).map(i => d.db.reduce((s, c) => s + (c.v[i] || 0), 0));
  const at = d.tm.filter(t => t.on);
  // monthOverrides trumps startMo/endMo — checked first.
  // If override exists for month i, use it regardless of range.
  // Otherwise fall through to range check + co (or named-person hardcode).
  const tmCost = (p, i) => {
    const mo = p.monthOverrides;
    if (mo && i in mo) return mo[i];
    const sm = p.startMo ?? 0;
    const em = p.endMo ?? (N - 1);
    if (i < sm || i > em) return 0;
    return p.co;
  };
  const us = idxRange(N).map(i => {
    let t = (d.et[i] || 0) + (d.af[i] || 0);
    at.filter(p => p.ct === "US").forEach(p => {
      if (p.nm === "Paul") { if (i === 0) return; if (i === 1) { t -= 3917; return; } t -= tmCost(p, i); return; }
      if (p.nm === "Sara") { t -= (i === 0 ? 824 : i === 1 ? 180 : i === 4 ? 324 : tmCost(p, i)); return; }
      t -= tmCost(p, i);
    });
    return t;
  });
  const ph = idxRange(N).map(i => {
    let t = 0;
    at.filter(p => p.ct === "PH").forEach(p => {
      if (p.nm === "Janna") { t -= (i < 2 ? 800 : tmCost(p, i)); return; }
      t -= tmCost(p, i);
    });
    return t;
  });
  const ind = idxRange(N).map(i => {
    let t = d.wf[i] || 0;
    at.filter(p => p.ct === "IN").forEach(p => {
      if (p.nm === "Soorya" && i === 0) { t -= 2000; return; }
      t -= tmCost(p, i);
    });
    return t;
  });
  const ex = idxRange(N).map(i => us[i] + ph[i] + ind[i] + oc[i] + db[i]);

  // === Scenarios ===
  const scRv = new Array(N).fill(0);
  const scEx = new Array(N).fill(0);
  const scenarios = d.scenarios || [];
  scenarios.filter(s => s.on).forEach(s => {
    const start = s.startMo || 0;
    const dur = s.duration || 0;
    const end = dur > 0 ? Math.min(start + dur - 1, N - 1) : (N - 1);
    for (let i = start; i <= end; i++) {
      if (s.type === "revenue") scRv[i] += s.amount;
      else scEx[i] -= s.amount;
    }
  });

  const rvT = rv.map((v, i) => v + scRv[i]);
  const exT = ex.map((v, i) => v + scEx[i]);
  const nt = idxRange(N).map(i => rvT[i] + exT[i]);
  const bl = [];
  nt.forEach((n, i) => bl.push(i === 0 ? d.openBal + n : bl[i - 1] + n));

  return {
    rv: rvT, rvBase: rv,
    rvDerived, rvBreakdown,
    sb, oc, db, us, ph, ind,
    ex: exT, exBase: ex,
    nt, bl, at, scRv, scEx,
    otMerged: rvDerived.ot,
  };
}
