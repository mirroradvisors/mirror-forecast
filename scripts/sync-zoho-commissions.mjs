/**
 * sync-zoho-commissions.mjs — ops/dev fallback for the Zoho commission sync.
 * The PRIMARY path is now the in-app "Sync from Zoho" panel (ClientsTab →
 * ZohoSyncPanel → /api/zoho). This script shares the exact same map/diff rules
 * (src/zohoSync.js) but runs headless for ops, debugging, or bulk re-links.
 *
 * Dry-run by default (prints the diff + review flags, writes nothing). --apply
 * snapshots a backup then writes ALL proposed updates via save_forecast_rows().
 * It never churns/reactivates — those stay human decisions (just flagged).
 *
 * Usage:
 *   node scripts/sync-zoho-commissions.mjs            # dry run
 *   node scripts/sync-zoho-commissions.mjs --apply    # backup + write all updates
 *
 * Requires ZOHO_* creds (scripts/lib/zoho.mjs) + SUPABASE_SERVICE_ROLE_KEY.
 */
import { fetchSubscriptions, fetchCommissions } from './lib/zoho.mjs';
import { loadForecast, saveForecast, snapshotForecast } from './lib/forecastStore.mjs';
import { buildSyncPlan, DIFF_FIELDS } from '../src/zohoSync.js';

const APPLY = process.argv.includes('--apply');
const MONEY = new Set(['monthlyAmount', 'annualAmount']);
const fmt = (field, v) => (v == null ? '—' : MONEY.has(field) ? `$${v}` : String(v));

async function main() {
  console.log(`=== Zoho commission sync — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  let d;
  if (APPLY) { const { path, d: loaded } = await snapshotForecast('pre-zoho-sync'); d = loaded; console.log(`Backup: ${path}\n`); }
  else { d = await loadForecast(); }

  console.log('Fetching Zoho subscriptions + commissions…');
  const [subs, comms] = await Promise.all([fetchSubscriptions(), fetchCommissions()]);
  const plan = buildSyncPlan(d, subs, comms);
  console.log(`  ${plan.counts.subsTotal} subscription(s) (${plan.counts.subsActive} active), ${plan.counts.comms} commission record(s)\n`);

  console.log(`── PROPOSED CHANGES (${plan.updates.length}) ──`);
  if (!plan.updates.length) console.log('  (none — app already matches Zoho)');
  for (const u of plan.updates) {
    console.log(`\n  ${u.clientId} ${u.clientName}${u.isNew ? '  [NEW]' : ''}`);
    for (const ch of u.changes) console.log(`    • ${ch.field}: ${fmt(ch.field, ch.from)} → ${fmt(ch.field, ch.to)}`);
  }
  if (plan.insufficient.length) {
    console.log(`\n── NO COMMISSION $ FROM ZOHO (${plan.insufficient.length}) — amount left unchanged ──`);
    for (const x of plan.insufficient) console.log(`  ${x.clientId} ${x.clientName} (sub ${x.sub.subscriptionId}, ${x.sub.product})`);
  }
  if (plan.vanished.length) {
    console.log(`\n── ⚠ ACTIVE IN APP, NOT IN ZOHO ACTIVE SET (${plan.vanished.length}) — NOT auto-churned ──`);
    for (const v of plan.vanished) console.log(`  ${v.clientId} ${v.clientName} (${v.zc.frequency}, $${v.zc.monthlyAmount || v.zc.annualAmount})`);
  }
  if (plan.resurfaced.length) {
    console.log(`\n── ⚠ CHURNED/EXCLUDED IN APP BUT ACTIVE IN ZOHO (${plan.resurfaced.length}) — NOT auto-reactivated ──`);
    for (const r of plan.resurfaced) console.log(`  ${r.clientId} ${r.clientName} — Zoho ${r.sub.frequency} ${r.sub.product}, recurring $${r.sub.nextRecurring}`);
  }
  if (plan.unmatched.length) {
    console.log(`\n── UNMATCHED ZOHO SUBSCRIPTIONS (${plan.unmatched.length}) — no client by id or email ──`);
    for (const s of plan.unmatched) console.log(`  sub ${s.subscriptionId} — ${s.customerName ?? '?'} <${s.email ?? 'no email'}> ${s.product ?? ''}`);
    console.log('  → add the email to the matching client, or map manually, then re-run.');
  }

  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply once the diff looks right.'); return; }
  if (!plan.updates.length) { console.log('\nNothing to apply.'); return; }

  const byId = new Map(plan.updates.map((u) => [u.clientId, u.after]));
  d.cl = (d.cl || []).map((c) => (byId.has(c.id) ? { ...c, zohoCommission: byId.get(c.id), lastEditedAt: new Date().toISOString() } : c));
  console.log(`\nWriting ${plan.updates.length} update(s) via save_forecast_rows()…`);
  await saveForecast(d);
  console.log('✓ Written.');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
