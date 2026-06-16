// Vercel serverless proxy for the Zoho Partner API. Holds the OAuth secrets
// server-side (they must never reach the browser) and exposes a single GET that
// returns the raw active-subscription + commission arrays. Read-only.
//
// Gated to admins: the browser sends its Supabase access token; we validate it
// and confirm the caller's profiles.role === 'admin' before touching Zoho.
//
// Required Vercel env vars:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   (optional ZOHO_REGION=com)
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const REGION = process.env.ZOHO_REGION || "com";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pkphesuvwzlowbssepxi.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_CF_Xb2Ydv7rY55oRvrwU7w_pFHkBbY5";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const toArr = (x) => (Array.isArray(x) ? x : (x && typeof x === "object" ? (Object.values(x).find(Array.isArray) || []) : []));

async function requireAdmin(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, code: 401, error: "missing bearer token" };
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!ures.ok) return { ok: false, code: 401, error: "invalid session" };
  const user = await ures.json();
  if (!SERVICE) return { ok: false, code: 500, error: "server missing SUPABASE_SERVICE_ROLE_KEY" };
  const pres = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const rows = await pres.json().catch(() => []);
  if (!Array.isArray(rows) || rows[0]?.role !== "admin") return { ok: false, code: 403, error: "admin role required" };
  return { ok: true };
}

async function zohoToken() {
  const body = new URLSearchParams({ refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: "refresh_token" });
  const res = await fetch(`https://accounts.zoho.${REGION}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`zoho oauth failed: ${j.error || res.status}`);
  return j.access_token;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
    const gate = await requireAdmin(req);
    if (!gate.ok) return res.status(gate.code).json({ error: gate.error });

    const token = await zohoToken();
    const zget = async (path) => {
      const r = await fetch(`https://store.zoho.${REGION}/api/v1/partner${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t; }
      if (!r.ok) throw new Error(`zoho ${path} ${r.status}`);
      return j;
    };
    const [subs, comms] = await Promise.all([zget("/subscriptions?per_page=2000"), zget("/commissions?per_page=2000")]);
    return res.status(200).json({ subscriptions: toArr(subs), commissions: toArr(comms), fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
