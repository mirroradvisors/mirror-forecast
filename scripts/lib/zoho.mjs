// Zoho Store Partner API client for ops scripts (read-only).
// OAuth 2.0 refresh-token flow + paginated GET helpers. No Supabase here, so the
// discovery probe can run with only Zoho creds present.
//
// Docs: https://www.zoho.com/store/partner/help/partner-api.html
//   Base:  https://store.zoho{REGION}/api/v1/partner
//   Auth:  Authorization: Zoho-oauthtoken {access_token}   (token valid ~1h)
//   Scopes: ZohoPayments.subscriptions.READ, ZohoPayments.commissions.READ
//   Limits: 100 req/min (10/min for invoice attachments)
//
// Required in .env / .env.local:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// Optional:
//   ZOHO_REGION = com (default) | eu | in | com.au       (US store => "com")
//   ZOHO_ACCOUNTS_URL / ZOHO_API_BASE  to override the derived URLs outright.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv() {
  const env = { ...process.env };
  for (const f of ['.env', '.env.local']) {
    let txt;
    try { txt = readFileSync(resolve(ROOT, f), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const env = loadEnv();

const REGION = env.ZOHO_REGION || 'com';
const ACCOUNTS_URL = env.ZOHO_ACCOUNTS_URL || `https://accounts.zoho.${REGION}`;
const API_BASE = env.ZOHO_API_BASE || `https://store.zoho.${REGION}/api/v1/partner`;

export function requireCreds() {
  const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`ERROR: missing Zoho creds in .env / .env.local: ${missing.join(', ')}`);
    console.error('Generate them via a Self Client at https://api-console.zoho.com/ with scopes');
    console.error('  ZohoPayments.subscriptions.READ, ZohoPayments.commissions.READ');
    process.exit(1);
  }
}

// --- OAuth: exchange the long-lived refresh token for a ~1h access token. ---
let _token = null; // { value, expiresAt }
export async function getAccessToken() {
  requireCreds();
  if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Zoho OAuth failed (${res.status}): ${json.error || JSON.stringify(json)}`);
  }
  const ttl = (json.expires_in || 3600) * 1000;
  _token = { value: json.access_token, expiresAt: Date.now() + ttl };
  return _token.value;
}

// --- Single authenticated GET. Returns parsed JSON. ---
export async function zohoGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`Zoho GET ${path} failed (${res.status}): ${typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// Pull the list payload out of a Zoho response. The exact key is unknown until
// the discovery probe runs, so we accept an explicit key or auto-detect the first
// array-valued property. TUNE `listKey` once zoho-discover.mjs shows the shape.
export function extractList(json, listKey) {
  if (Array.isArray(json)) return json;
  if (listKey && Array.isArray(json?.[listKey])) return json[listKey];
  if (json && typeof json === 'object') {
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [];
}

// Detect "is there another page?" across the field names Zoho uses in different
// products (page_context.has_more_page / has_more / more_records). TUNE after discovery.
function hasMore(json) {
  const pc = json?.page_context ?? json;
  return Boolean(pc?.has_more_page ?? pc?.has_more ?? pc?.more_records ?? false);
}

// --- Auto-paginate a list endpoint. Returns the concatenated array. ---
export async function zohoGetAll(path, { listKey, perPage = 200, params = {}, maxPages = 50 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await zohoGet(path, { ...params, page, per_page: perPage });
    const batch = extractList(json, listKey);
    out.push(...batch);
    if (!hasMore(json) || batch.length === 0) break;
  }
  return out;
}

// --- Convenience wrappers for the endpoints the sync uses. ---
// /subscriptions returns a BARE ARRAY of all subscriptions (each with a `status`
// field) — the /status/active filter path 400s, so callers filter client-side.
// /commissions returns the full payout history (one record per transaction).
export const fetchSubscriptions = (opts) => zohoGetAll('/subscriptions', opts);
export const fetchCommissions   = (opts) => zohoGetAll('/commissions', opts);
// Back-compat alias (discovery script).
export const fetchActiveSubscriptions = fetchSubscriptions;

export const config = { REGION, ACCOUNTS_URL, API_BASE };
