// Transaction classification for the Actuals/Reconcile flow.
//
// Each transaction is tagged with a CATEGORY and a FLOW. The flow decides how a
// transaction affects the monthly rollup:
//   revenue   → counts toward "actual revenue in"
//   expense   → counts toward "actual expense out"
//   transfer  → moves cash but is NOT revenue/expense (e.g. Stripe payout landing
//               in checking is the cash arrival of already-counted Stripe charges)
//   financing → debt/loan/owner movements (CC paydown, Stripe Capital, owner funds)
//   ignore    → off-checking informational rows (raw Stripe charges, CC line items)
//
// closingBalance always reflects EVERY checking row regardless of flow — flow only
// governs the revenue/expense split shown against the forecast.
//
// Rules are tried in order; first match wins. User corrections from the review
// screen are persisted as additional rules (see match_rules table) and are merged
// AHEAD of these defaults so they take precedence.

export const CATEGORIES = {
  payroll:           { label: "Payroll (wages)",     flow: "expense" },
  employer_taxes:    { label: "Employer taxes",      flow: "expense" },
  adp_fees:          { label: "ADP fees",            flow: "expense" },
  contractor:        { label: "Contractor payout",   flow: "expense" },
  wise_fees:         { label: "Wise fees",            flow: "expense" },
  subscription:      { label: "Subscription/SaaS",   flow: "expense" },
  bank_fees:         { label: "Bank/wire fees",      flow: "expense" },
  insurance:         { label: "Insurance",           flow: "expense" },
  travel:            { label: "Travel",              flow: "expense" },
  meals:             { label: "Meals & ent.",        flow: "expense" },
  fuel:              { label: "Fuel",                flow: "expense" },
  professional:      { label: "Professional svc",    flow: "expense" },
  uncategorized_expense: { label: "Uncategorized expense", flow: "expense" },

  commission_revenue: { label: "Zoho commission",    flow: "revenue" },
  client_revenue:     { label: "Client revenue",     flow: "revenue" },
  uncategorized_income: { label: "Uncategorized income", flow: "revenue" },

  stripe_payout:     { label: "Stripe payout",       flow: "transfer" },
  internal_transfer: { label: "Internal transfer",   flow: "transfer" },

  cc_payment:        { label: "Credit-card paydown", flow: "financing" },
  loan_paydown:      { label: "Loan paydown",        flow: "financing" },
  owner_contribution:{ label: "Owner contribution",  flow: "financing" },

  stripe_charge:     { label: "Stripe charge",       flow: "ignore" },
  cc_spend:          { label: "Card spend",          flow: "ignore" },
};

export const flowOf = (category) => CATEGORIES[category]?.flow || "expense";

// Default rules. `re` matches the description (case-insensitive); `src` optionally
// restricts to a source; `sign` optionally restricts to credits (+1) or debits (-1).
// `confidence` is a hint for the review UI (1 = certain, lower = please confirm).
const DEFAULT_RULES = [
  // --- Payroll / ADP (checking debits) ---
  { re: /ADP\s+WAGE\s+PAY|WAGE\s+PAY/i, category: "payroll", confidence: 0.97 },
  { re: /ADP\s+TAX/i,                    category: "employer_taxes", confidence: 0.97 },
  { re: /ADP\s+(PAYROLL\s+)?FEES/i,      category: "adp_fees", confidence: 0.97 },

  // --- Contractors / Wise ---
  { re: /Wise\s+Inc/i, category: "contractor", confidence: 0.7 }, // amount/recipient refines

  // --- Stripe cash movements on checking ---
  { re: /STRIPE.*TRANSFER|ORIG CO NAME:STRIPE/i, src: "chase_checking", category: "stripe_payout", confidence: 0.95 },
  { re: /Stripe\s*Cap|financing|ST-C3P0|Mirror Advisors.*Stripe Cap/i, src: "chase_checking", category: "loan_paydown", confidence: 0.85 },

  // --- Incoming commission wires (Zoho) ---
  { re: /ZOHO/i, sign: 1, category: "commission_revenue", confidence: 0.9 },

  // --- Subscriptions / SaaS (mostly on the credit card) ---
  { re: /ANTHROPIC|CLAUDE/i,    category: "subscription", confidence: 0.95 },
  { re: /OPENAI/i,              category: "subscription", confidence: 0.95 },
  { re: /GOOGLE.*Workspace|GOOGLE \*/i, category: "subscription", confidence: 0.9 },
  { re: /MICROSOFT/i,           category: "subscription", confidence: 0.9 },
  { re: /CANVA/i,               category: "subscription", confidence: 0.9 },
  { re: /WEBFLOW|WIX|ZOOM|SUPABASE|PROTON|VERCEL|REGUS/i, category: "subscription", confidence: 0.85 },

  // --- Bank / wire fees ---
  { re: /WIRE\s+FEE|INCOMING\s+WIRE|INTEREST\s+CHARGE|PURCHASE\s+INTEREST/i, category: "bank_fees", confidence: 0.9 },

  // --- Insurance / phone ---
  { re: /ACHMA\s+VISB|BILL\s+PYMNT/i, category: "insurance", confidence: 0.6 },

  // --- Credit-card categories (from the Chase CC "Category" column) ---
  { re: /.*/, src: "chase_cc", category: "cc_spend", confidence: 0.4, ccCategory: true },

  // --- Raw Stripe charges (off-checking; informational) ---
  { re: /.*/, src: "stripe", category: "stripe_charge", confidence: 0.5, stripeClient: true },
];

// Map a Chase CC "Category" string to one of our expense categories.
const CC_CATEGORY_MAP = {
  "travel": "travel",
  "food & drink": "meals",
  "gas": "fuel",
  "office & shipping": "subscription",
  "professional services": "professional",
  "bills & utilities": "subscription",
  "fees & adjustments": "bank_fees",
};

// Try to match a Stripe payment to a known client by metadata.
function matchClient(txn, clients) {
  const m = txn.meta || {};
  const name = (m.clientName || "").toLowerCase().trim();
  const email = (m.email || "").toLowerCase().trim();
  if (!clients?.length) return null;
  for (const c of clients) {
    if (email && c.email && c.email.toLowerCase() === email) return c;
  }
  for (const c of clients) {
    const cn = (c.nm || "").toLowerCase();
    if (name && cn && (cn.includes(name) || name.includes(cn))) return c;
  }
  return null;
}

// Classify a single transaction. `rules` are user/custom rules merged ahead of
// DEFAULT_RULES. Returns { category, flow, confidence, counterparty, clientId, ruleMatched }.
export function classifyTxn(txn, { rules = [], clients = [] } = {}) {
  const all = [...rules, ...DEFAULT_RULES];
  for (const rule of all) {
    if (rule.src && rule.src !== txn.source) continue;
    if (rule.sign && Math.sign(txn.amount) !== rule.sign) continue;
    const re = rule.re instanceof RegExp ? rule.re : new RegExp(rule.re, "i");
    if (!re.test(txn.description)) continue;

    let category = rule.category;
    let confidence = rule.confidence ?? 0.8;
    let counterparty = rule.counterparty || "";
    let clientId = null;

    // CC line: refine via the statement's own category column.
    if (rule.ccCategory) {
      const mapped = CC_CATEGORY_MAP[(txn.meta?.category || "").toLowerCase()];
      if (mapped) { category = mapped; confidence = 0.6; }
    }
    // Stripe charge: attach the matched client.
    if (rule.stripeClient) {
      const c = matchClient(txn, clients);
      if (c) { clientId = c.id; counterparty = c.nm; confidence = 0.85; }
      else { counterparty = txn.meta?.clientName || ""; }
    }
    // Contractor refinement: a Wise payout to a named recipient is a contractor;
    // a small Wise debit with no recipient name is usually a fee.
    if (rule.category === "contractor" && Math.abs(txn.amount) < 50 && /TrnWise|invoice/i.test(txn.description)) {
      category = "wise_fees"; confidence = 0.6;
    }

    return { category, flow: flowOf(category), confidence, counterparty, clientId, ruleMatched: rule.id || rule.re?.toString() };
  }

  // Fallback by sign.
  const category = txn.amount >= 0 ? "uncategorized_income" : "uncategorized_expense";
  return { category, flow: flowOf(category), confidence: 0.2, counterparty: "", clientId: null, ruleMatched: null };
}

// Annotate every transaction across a set of parsed statements (in place-ish,
// returns new objects). `opts` = { rules, clients }.
export function classifyAll(transactions, opts) {
  return transactions.map((t) => ({ ...t, ...classifyTxn(t, opts) }));
}
