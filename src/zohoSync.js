// Pure Zoho → forecast mapping + diff logic. No I/O, no Node/browser deps, so the
// UI (ZohoSyncPanel), the Vercel proxy, and the CLI ops script all share ONE set
// of rules. Given raw Zoho /subscriptions + /commissions arrays and the current
// forecast `d`, buildSyncPlan() returns the proposed zohoCommission changes plus
// the review flags (unmatched / churned-but-active / active-but-gone / no-$).
//
// Commission model: per-period commission = subscription.next_recurring_amount_usd
// × rate, where rate = usd_commission / eligible_txn_amount from the most recent
// POSITIVE "Base" payout. The rate varies per sub and over time (most 18%, some
// 25%), and the raw history is full of proration fragments and ± reversal pairs,
// so we never just take the latest record's amount.

const toNum = (v) => (v == null || v === "" ? undefined : Number(String(v).replace(/[^0-9.\-]/g, "")));
const isoDate = (v) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined; };
const dayOfMonth = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return m ? Number(m[3]) : undefined; };

// Statuses that mean a subscription is currently earning. Others (expired,
// cancelled, dead, …) drop out of the active set → flag any client linked to them.
export const ACTIVE_STATUSES = new Set(["active", "live"]);

// Fields whose change counts as a "real" diff worth showing/applying.
export const DIFF_FIELDS = ["zohoProduct", "licenses", "frequency", "monthlyAmount", "annualAmount", "renewalDate", "renewalDay"];

export function mapSubscription(sub) {
  const bf = String(sub.billing_frequency || "").toLowerCase();
  let frequency;
  if (/year|annual/.test(bf)) frequency = "annual";
  else if (/month/.test(bf)) frequency = "monthly";
  const renewal = isoDate(sub.next_recurring_date);
  return {
    subscriptionId: String(sub.subscription_id ?? sub.id ?? ""),
    customerId: sub.org_id != null ? String(sub.org_id) : (sub.zuid != null ? String(sub.zuid) : undefined),
    email: String(sub.email_id || "").toLowerCase() || undefined,
    customerName: sub.org_name || sub.customer_company_name,
    product: sub.service_name,
    licenses: toNum(sub.paid_users) ?? 0,
    frequency,
    nextRecurring: toNum(sub.next_recurring_amount_usd),
    renewalDate: renewal,
    renewalDay: dayOfMonth(renewal),
    status: String(sub.status || "").toLowerCase(),
  };
}

export function commissionRate(subscriptionId, commissions) {
  const pos = commissions.filter((c) =>
    String(c.subscription?.subscription_id ?? "") === subscriptionId &&
    String(c.commission_type || "").toLowerCase() === "base" &&
    Number(c.eligible_txn_amount) > 0 && Number(c.usd_commission) > 0);
  if (!pos.length) return null;
  pos.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return Number(pos[0].usd_commission) / Number(pos[0].eligible_txn_amount);
}

export function mapCommission(sub, commissions) {
  const rate = commissionRate(sub.subscriptionId, commissions);
  if (rate != null && sub.nextRecurring) return Math.round(sub.nextRecurring * rate * 100) / 100;
  const pos = commissions
    .filter((c) => String(c.subscription?.subscription_id ?? "") === sub.subscriptionId && Number(c.usd_commission) > 0 && String(c.commission_type || "").toLowerCase() === "base")
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return pos.length ? toNum(pos[0].usd_commission) : undefined;
}

// Build the proposed zohoCommission for a matched client. Preserves the human
// fields (status / inForecast / note) and the app's richer product name.
export function proposeCommission(existing, sub, commissionAmt, nowISO) {
  const base = existing || { zohoProduct: undefined, licenses: 0, frequency: undefined, monthlyAmount: 0, annualAmount: 0, renewalDate: null, renewalDay: null, status: "active", inForecast: true, note: "" };
  const next = { ...base };

  if (sub.product) {
    const cur = (base.zohoProduct || "").toLowerCase();
    if (!cur || !cur.includes(String(sub.product).toLowerCase())) next.zohoProduct = sub.product;
  }
  if (sub.licenses != null) next.licenses = sub.licenses;
  if (sub.frequency) next.frequency = sub.frequency;

  const freq = next.frequency;
  if (commissionAmt != null) {
    if (freq === "monthly") { next.monthlyAmount = commissionAmt; next.annualAmount = 0; }
    else if (freq === "annual") { next.annualAmount = commissionAmt; next.monthlyAmount = 0; }
  }
  if (freq === "annual" && sub.renewalDate) { next.renewalDate = sub.renewalDate; next.renewalDay = null; }
  if (freq === "monthly" && sub.renewalDay != null) { next.renewalDay = sub.renewalDay; next.renewalDate = null; }

  next.zohoSubscriptionId = sub.subscriptionId || base.zohoSubscriptionId;
  if (sub.customerId != null) next.zohoCustomerId = String(sub.customerId);
  if (nowISO) next.zohoSyncedAt = nowISO;
  return next;
}

export function diffFields(before, after) {
  const out = [];
  for (const k of DIFF_FIELDS) {
    const av = before ? before[k] : undefined, bv = after[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) out.push({ field: k, from: av ?? null, to: bv ?? null });
  }
  if ((before?.zohoSubscriptionId ?? null) !== (after.zohoSubscriptionId ?? null)) out.push({ field: "link", from: before?.zohoSubscriptionId ?? null, to: after.zohoSubscriptionId });
  return out;
}

// The whole plan: proposed updates + review flags. Pure — never mutates `d`.
export function buildSyncPlan(d, subsRaw, commsRaw, nowISO = new Date().toISOString()) {
  const subs = (subsRaw || []).map(mapSubscription).filter((s) => s.subscriptionId && ACTIVE_STATUSES.has(s.status));
  const clients = d.cl || [];
  const bySubId = new Map(), byEmail = new Map();
  for (const c of clients) {
    const sid = c.zohoCommission?.zohoSubscriptionId;
    if (sid) bySubId.set(String(sid), c);
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
  }

  const updates = [], unmatched = [], insufficient = [], resurfaced = [];
  const matchedSubIds = new Set();

  for (const sub of subs) {
    const client = bySubId.get(sub.subscriptionId) || (sub.email && byEmail.get(sub.email));
    if (!client) { unmatched.push(sub); continue; }
    matchedSubIds.add(sub.subscriptionId);

    const commissionAmt = mapCommission(sub, commsRaw);
    const before = client.zohoCommission || null;
    if (commissionAmt == null) insufficient.push({ clientId: client.id, clientName: client.nm, sub });
    if (before && (before.status === "churned" || before.inForecast === false)) resurfaced.push({ clientId: client.id, clientName: client.nm, sub });

    const after = proposeCommission(before, sub, commissionAmt, nowISO);
    const changes = diffFields(before, after);
    if (changes.length) updates.push({ clientId: client.id, clientName: client.nm, before, after, changes, isNew: !before });
  }

  const vanished = clients.filter((c) => {
    const zc = c.zohoCommission;
    if (!zc || zc.status === "churned" || zc.inForecast === false) return false;
    const sid = zc.zohoSubscriptionId ? String(zc.zohoSubscriptionId) : null;
    if (sid) return !matchedSubIds.has(sid);
    return !(c.email && subs.some((s) => s.email === c.email.toLowerCase()));
  }).map((c) => ({ clientId: c.id, clientName: c.nm, zc: c.zohoCommission }));

  return { updates, unmatched, insufficient, resurfaced, vanished, counts: { subsTotal: (subsRaw || []).length, subsActive: subs.length, comms: (commsRaw || []).length } };
}
