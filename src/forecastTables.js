// Pure mapping between the forecast `d` object (what compute() consumes) and the
// relational tables (supabase/migrations/20260610000001_relational_schema.sql).
//   decompose(d)      -> { tableName: rows[] }   (snake_case columns; ready to insert)
//   reassemble(tables)-> d                        (exact shape compute()/UI expect)
// No imports, no side effects: safe in both the browser (storage.js) and Node (scripts).

const orNull = (v) => (v === undefined ? null : v);
// PostgREST returns `numeric` as a string ("129.60"); coerce back to JS numbers.
const num = (v) => (v === null || v === undefined ? null : Number(v));
const numArr = (a) => (Array.isArray(a) ? a.map((x) => Number(x)) : []);

// Freeze payment_schedule.status to a non-null value (same logic as the app's
// backfillScheduleStatus) so the migrate step stays idempotent afterward.
export function freezeStatus(p, now = new Date()) {
  if (p.status) return p.status;
  if (p.paid === true) return 'P';
  if (p.note === 'Late') return 'L';
  if (p.dueDate && new Date(p.dueDate) < now) return 'L';
  return 'U';
}

// Insertion order honoring FK deps (parents before children). Reverse for deletes.
export const INSERT_ORDER = [
  'forecast_meta', 'forecast_vectors', 'rv_actuals', 'manual_revenue', 'actuals',
  'subscriptions', 'cost_lines', 'team_members', 'scenarios',
  'clients', 'service_contracts', 'payment_schedule', 'zoho_commissions',
];

export function decompose(d, now = new Date()) {
  const rows = {};
  rows.forecast_meta = [{ id: 1, open_bal: d.openBal, cash_now: d.cashNow, savings: d.savings, s_loan: d.sLoan, cc_owe: d.ccOwe, horizon: (d.et || []).length || 24 }];
  rows.forecast_vectors = [{ id: 1, et: d.et || [], af: d.af || [], wf: d.wf || [] }];
  rows.manual_revenue = ['mk', 'ot', 'pCruzy', 'pPatson'].map((s) => ({ stream: s, v: (d.rv && d.rv[s]) || [] }));
  rows.rv_actuals = ['im', 'za', 'zm'].map((s) => ({ stream: s, overrides: (d.rvActuals && d.rvActuals[s]) || {} }));
  rows.subscriptions = (d.sb || []).map((s, i) => ({ pos: i, n: s.n, a: s.a, start_mo: orNull(s.s), end_mo: orNull(s.e) }));
  rows.cost_lines = [
    ...(d.oc || []).map((x, i) => ({ kind: 'oc', pos: i, n: x.n, v: x.v || [] })),
    ...(d.db || []).map((x, i) => ({ kind: 'db', pos: i, n: x.n, v: x.v || [] })),
  ];
  rows.team_members = (d.tm || []).map((t, i) => ({
    id: t.id, pos: i, nm: t.nm, rl: t.rl, dp: t.dp, ct: t.ct, co: t.co, on_flag: !!t.on,
    start_mo: orNull(t.startMo), end_mo: orNull(t.endMo), month_overrides: t.monthOverrides || {},
  }));
  rows.clients = []; rows.service_contracts = []; rows.payment_schedule = []; rows.zoho_commissions = [];
  (d.cl || []).forEach((c, i) => {
    rows.clients.push({ id: c.id, pos: i, nm: c.nm, email: orNull(c.email), notes: c.notes || '', last_edited_at: orNull(c.lastEditedAt), last_edited_by: orNull(c.lastEditedBy) });
    const sc = c.serviceContract;
    if (sc) {
      rows.service_contracts.push({ client_id: c.id, type: sc.type, segment: sc.segment, monthly_amount: orNull(sc.monthlyAmount), monthly_renewal_day: orNull(sc.monthlyRenewalDay), start_date: orNull(sc.startDate), end_date: orNull(sc.endDate), status: sc.status, in_forecast: sc.inForecast !== false });
      (sc.paymentSchedule || []).forEach((p, j) => rows.payment_schedule.push({ client_id: c.id, pos: j, due_date: p.dueDate, amount: p.amount, paid: !!p.paid, paid_date: orNull(p.paidDate), note: p.note || '', status: freezeStatus(p, now) }));
    }
    const zc = c.zohoCommission;
    if (zc) rows.zoho_commissions.push({ client_id: c.id, zoho_product: zc.zohoProduct, licenses: zc.licenses || 0, frequency: zc.frequency, monthly_amount: zc.monthlyAmount || 0, annual_amount: zc.annualAmount || 0, renewal_date: orNull(zc.renewalDate), renewal_day: orNull(zc.renewalDay), status: zc.status, in_forecast: zc.inForecast !== false, note: zc.note || '', zoho_subscription_id: orNull(zc.zohoSubscriptionId), zoho_customer_id: orNull(zc.zohoCustomerId), zoho_synced_at: orNull(zc.zohoSyncedAt) });
  });
  rows.scenarios = (d.scenarios || []).map((s, i) => ({ id: s.id, pos: i, name: s.name, type: s.type, amount: s.amount, start_mo: s.startMo || 0, duration: s.duration || 0, on_flag: !!s.on }));
  rows.actuals = Object.entries(d.actuals || {}).map(([k, a]) => ({ month_idx: +k, closing_bal: orNull(a.closingBal), total_in: orNull(a.totalIn), total_out: orNull(a.totalOut), chase_in: orNull(a.chaseIn), chase_out: orNull(a.chaseOut), stripe_in: orNull(a.stripeIn), stripe_payout: orNull(a.stripePayout), stripe_loan: orNull(a.stripeLoan), wise_out: orNull(a.wiseOut), wise_fees: orNull(a.wiseFees), cc_spend: orNull(a.ccSpend), cc_fees: orNull(a.ccFees), recon_date: orNull(a.reconDate) }));
  return rows;
}

const byPos = (a, b) => (a.pos ?? 0) - (b.pos ?? 0);

// tables: { tableName: rows[] } (as returned by PostgREST selects). Produces `d`.
export function reassemble(t) {
  const meta = (t.forecast_meta || [])[0] || {};
  const vec = (t.forecast_vectors || [])[0] || {};
  const mrev = Object.fromEntries((t.manual_revenue || []).map((r) => [r.stream, numArr(r.v)]));
  const fallback = (vec.et ? vec.et.length : 24);
  const ensure = (a) => (a && a.length ? a : new Array(fallback).fill(0));

  const psByClient = {};
  (t.payment_schedule || []).forEach((p) => (psByClient[p.client_id] ||= []).push(p));
  const scByClient = Object.fromEntries((t.service_contracts || []).map((s) => [s.client_id, s]));
  const zcByClient = Object.fromEntries((t.zoho_commissions || []).map((z) => [z.client_id, z]));

  const d = {
    openBal: num(meta.open_bal), cashNow: num(meta.cash_now), savings: num(meta.savings), sLoan: num(meta.s_loan), ccOwe: num(meta.cc_owe),
    rv: { mk: ensure(mrev.mk), ot: ensure(mrev.ot), pCruzy: ensure(mrev.pCruzy), pPatson: ensure(mrev.pPatson) },
    rvActuals: Object.fromEntries((t.rv_actuals || []).map((r) => [r.stream, r.overrides || {}])),
    sb: [...(t.subscriptions || [])].sort(byPos).map((s) => {
      const o = { n: s.n, a: num(s.a) };
      if (s.start_mo != null) o.s = s.start_mo;
      if (s.end_mo != null) o.e = s.end_mo;
      return o;
    }),
    oc: [...(t.cost_lines || [])].filter((x) => x.kind === 'oc').sort(byPos).map((x) => ({ n: x.n, v: numArr(x.v) })),
    db: [...(t.cost_lines || [])].filter((x) => x.kind === 'db').sort(byPos).map((x) => ({ n: x.n, v: numArr(x.v) })),
    et: numArr(vec.et), af: numArr(vec.af), wf: numArr(vec.wf),
    tm: [...(t.team_members || [])].sort(byPos).map((m) => {
      const o = { id: m.id, nm: m.nm, rl: m.rl, dp: m.dp, ct: m.ct, co: num(m.co), on: !!m.on_flag };
      if (m.start_mo != null) o.startMo = m.start_mo;
      if (m.end_mo != null) o.endMo = m.end_mo;
      if (m.month_overrides && Object.keys(m.month_overrides).length) o.monthOverrides = m.month_overrides;
      return o;
    }),
    cl: [...(t.clients || [])].sort(byPos).map((c) => {
      const sc = scByClient[c.id];
      const zc = zcByClient[c.id];
      let zohoCommission = null;
      if (zc) {
        zohoCommission = {
          zohoProduct: zc.zoho_product, licenses: zc.licenses, frequency: zc.frequency, monthlyAmount: num(zc.monthly_amount), annualAmount: num(zc.annual_amount),
          renewalDate: orNull(zc.renewal_date), renewalDay: orNull(zc.renewal_day), status: zc.status, inForecast: zc.in_forecast !== false, note: zc.note || '',
        };
        // Sync-link fields: omit the key when null so rows never touched by the
        // Zoho sync round-trip byte-identical (matches tm[].startMo handling).
        if (zc.zoho_subscription_id != null) zohoCommission.zohoSubscriptionId = zc.zoho_subscription_id;
        if (zc.zoho_customer_id != null) zohoCommission.zohoCustomerId = zc.zoho_customer_id;
        if (zc.zoho_synced_at != null) zohoCommission.zohoSyncedAt = zc.zoho_synced_at;
      }
      return {
        id: c.id, nm: c.nm, email: orNull(c.email), notes: c.notes || '',
        serviceContract: sc ? {
          type: sc.type, segment: sc.segment, monthlyAmount: num(sc.monthly_amount), monthlyRenewalDay: orNull(sc.monthly_renewal_day),
          startDate: orNull(sc.start_date), endDate: orNull(sc.end_date), status: sc.status, inForecast: sc.in_forecast !== false,
          paymentSchedule: (psByClient[c.id] || []).slice().sort(byPos).map((p) => ({ dueDate: p.due_date, amount: num(p.amount), paid: !!p.paid, paidDate: orNull(p.paid_date), note: p.note || '', status: p.status })),
        } : null,
        zohoCommission,
        lastEditedAt: orNull(c.last_edited_at), lastEditedBy: orNull(c.last_edited_by),
      };
    }),
    scenarios: [...(t.scenarios || [])].sort(byPos).map((s) => ({ id: s.id, name: s.name, type: s.type, amount: num(s.amount), startMo: s.start_mo, duration: s.duration, on: !!s.on_flag })),
    actuals: Object.fromEntries((t.actuals || []).map((a) => [a.month_idx, {
      closingBal: num(a.closing_bal), totalIn: num(a.total_in), totalOut: num(a.total_out), chaseIn: num(a.chase_in), chaseOut: num(a.chase_out),
      stripeIn: num(a.stripe_in), stripePayout: num(a.stripe_payout), stripeLoan: num(a.stripe_loan), wiseOut: num(a.wise_out), wiseFees: num(a.wise_fees),
      ccSpend: num(a.cc_spend), ccFees: num(a.cc_fees), reconDate: a.recon_date,
    }])),
  };
  return d;
}
