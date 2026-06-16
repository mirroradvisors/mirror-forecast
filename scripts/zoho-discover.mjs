/**
 * zoho-discover.mjs — one-time shape probe for the Zoho Partner API.
 *
 * The Partner API docs list the endpoints but not their JSON response schemas,
 * so before we map Zoho → d.cl[].zohoCommission we dump a small live sample and
 * inspect the real field names. Output goes to scripts/zoho-sample.json (gitignored
 * by you — it contains customer data) and a field summary prints to the console.
 *
 * READ-ONLY: hits only GET endpoints. Writes nothing to Supabase.
 *
 * Usage:
 *   node scripts/zoho-discover.mjs            # subscriptions (active) + commissions
 *   node scripts/zoho-discover.mjs --all      # also pull ALL subscriptions + transactions
 *
 * Requires ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN in .env(.local).
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zohoGet, fetchActiveSubscriptions, fetchAllSubscriptions, fetchCommissions, config } from './lib/zoho.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wantAll = process.argv.includes('--all');

// Print the key/type shape of the first item in a list so we can map fields.
function summarize(label, list) {
  console.log(`\n── ${label} — ${list.length} record(s) ──`);
  if (!list.length) { console.log('  (empty)'); return; }
  const sample = list[0];
  if (sample && typeof sample === 'object') {
    for (const [k, v] of Object.entries(sample)) {
      const t = Array.isArray(v) ? `array[${v.length}]` : v === null ? 'null' : typeof v;
      const preview = t === 'string' || t === 'number' || t === 'boolean' ? ` = ${JSON.stringify(v)}` : '';
      console.log(`    ${k}: ${t}${preview}`);
    }
  } else {
    console.log(`  (scalar) ${JSON.stringify(sample)}`);
  }
}

async function main() {
  console.log(`Zoho Partner API — region "${config.REGION}"`);
  console.log(`  accounts: ${config.ACCOUNTS_URL}`);
  console.log(`  api base: ${config.API_BASE}\n`);

  const out = {};

  // Raw first page of /subscriptions so we can see the envelope (page_context etc.)
  try {
    out.rawSubscriptionsPage = await zohoGet('/subscriptions', { page: 1, per_page: 5 });
    console.log('Envelope keys on /subscriptions:', Object.keys(out.rawSubscriptionsPage || {}).join(', ') || '(array)');
  } catch (e) { console.error('  ! /subscriptions raw page failed:', e.message); }

  try {
    out.activeSubscriptions = await fetchActiveSubscriptions({ perPage: 200, maxPages: 5 });
    summarize('subscriptions (active)', out.activeSubscriptions);
  } catch (e) { console.error('  ! active subscriptions failed:', e.message); }

  try {
    out.commissions = await fetchCommissions({ perPage: 200, maxPages: 5 });
    summarize('commissions', out.commissions);
  } catch (e) { console.error('  ! commissions failed:', e.message); }

  if (wantAll) {
    try { out.allSubscriptions = await fetchAllSubscriptions({ perPage: 200, maxPages: 20 }); summarize('subscriptions (all)', out.allSubscriptions); }
    catch (e) { console.error('  ! all subscriptions failed:', e.message); }
    try { out.transactions = await zohoGet('/transactions', { page: 1, per_page: 20 }); console.log('\nFetched /transactions sample.'); }
    catch (e) { console.error('  ! transactions failed:', e.message); }
  }

  const path = resolve(ROOT, 'scripts', 'zoho-sample.json');
  writeFileSync(path, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n✓ Full sample written to ${path}`);
  console.log('  Inspect it, then tune mapSubscription()/mapCommission() in sync-zoho-commissions.mjs.');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
