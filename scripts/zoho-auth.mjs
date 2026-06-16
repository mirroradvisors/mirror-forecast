/**
 * zoho-auth.mjs — one-time: exchange a Self Client GRANT token (authorization
 * code) for a long-lived REFRESH token, and write it to .env.local.
 *
 * Why: a Self Client gives you a short-lived code (the "grant token", valid only
 * a few minutes). It must be exchanged once for a refresh token; that refresh
 * token is what the sync scripts use from then on.
 *
 * Steps:
 *   1. https://api-console.zoho.com/  →  open your Self Client.
 *   2. "Generate Code" tab. Scope (comma-separated, no spaces):
 *        ZohoPayments.subscriptions.READ,ZohoPayments.commissions.READ
 *      Pick 10 minutes. Copy the generated code.
 *   3. Immediately run:
 *        node scripts/zoho-auth.mjs "PASTE_CODE_HERE"
 *
 * Reads ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET (and optional ZOHO_REGION) from
 * .env(.local). Writes/updates ZOHO_REFRESH_TOKEN in .env.local.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const env = {};
  for (const f of ['.env', '.env.local']) {
    try { for (const l of readFileSync(resolve(ROOT, f), 'utf8').split('\n')) { const m = l.match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch {}
  }
  return env;
}
const env = loadEnv();
const REGION = env.ZOHO_REGION || 'com';
const code = process.argv[2];

if (!code) { console.error('Usage: node scripts/zoho-auth.mjs "<grant-code-from-self-client>"'); process.exit(1); }
if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) { console.error('ERROR: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET missing in .env(.local)'); process.exit(1); }

const body = new URLSearchParams({ code, client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, grant_type: 'authorization_code' });
const res = await fetch(`https://accounts.zoho.${REGION}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
const j = await res.json().catch(() => ({}));

if (!j.refresh_token) {
  console.error(`Exchange failed (${res.status}):`, JSON.stringify(j));
  if (j.error === 'invalid_code') console.error('→ The code is expired or already used. Generate a fresh one and re-run within a few minutes.');
  process.exit(1);
}

// Upsert ZOHO_REFRESH_TOKEN into .env.local (it overrides .env on load).
const localPath = resolve(ROOT, '.env.local');
let txt = existsSync(localPath) ? readFileSync(localPath, 'utf8') : '';
const line = `ZOHO_REFRESH_TOKEN=${j.refresh_token}`;
if (/^ZOHO_REFRESH_TOKEN=.*$/m.test(txt)) txt = txt.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, line);
else txt += (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n';
writeFileSync(localPath, txt, 'utf8');

console.log('✓ Refresh token obtained and written to .env.local (ZOHO_REFRESH_TOKEN).');
console.log('  scope:', j.scope);
console.log('  Next: node scripts/zoho-discover.mjs');
