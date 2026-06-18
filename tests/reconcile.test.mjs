// Tests for the statement-reconcile core: parsing, classification, dedup/merge,
// running-balance reconstruction, and monthly rollup. Runs in Node (no browser).
//   node tests/reconcile.test.mjs
import { parseStatement, parseDate } from "../src/reconcileParse.js";
import { classifyAll } from "../src/reconcileRules.js";
import {
  mergeTransactions, reconstructBalances, buildMonthlySummaries,
  coverageFromTransactions,
} from "../src/reconcileSummary.js";

let pass = 0, fail = 0;
const approx = (a, b, eps = 0.02) => typeof a === "number" && Math.abs(a - b) < eps;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗ FAIL"} ${name}${cond ? "" : `  ${extra ?? ""}`}`); };

// --- Fixtures (trimmed from the real sample statements) ---------------------

const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,06/16/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE SEC:CCD IND ID:TrnWise ORIG ID:9453233521",-294.53,MISC_DEBIT, ,,
CREDIT,06/16/2026,"ORIG CO NAME:HAMPTON EMPIRE L CO ENTRY DESCR:SENDER SEC:CTX IND ID:868750270 ORIG ID:S941687665",2000.00,ACH_CREDIT, ,,
DEBIT,06/12/2026,"DOMESTIC INCOMING WIRE FEE",-15.00,FEE_TRANSACTION,23185.75,,
DEBIT,06/12/2026,"ORIG CO NAME:ADP Tax ORIG ID:1223006057 CO ENTRY DESCR:ADP Tax",-565.96,ACH_DEBIT,23200.75,,
DEBIT,06/12/2026,"ORIG CO NAME:ADP WAGE PAY ORIG ID:9333006057 CO ENTRY DESCR:WAGE PAY",-2683.95,ACH_DEBIT,23766.71,,
DEBIT,06/12/2026,"ORIG CO NAME:ADP PAYROLL FEES ORIG ID:9659605001 CO ENTRY DESCR:ADP FEES",-88.61,ACH_DEBIT,26450.66,,
CREDIT,06/12/2026,"CHIPS CREDIT VIA: CITIBANK B/O: ZOHO CORPORATION REF: NBNF=MIRROR ADVISORS",1515.95,WIRE_INCOMING,26539.27,,
DEBIT,06/11/2026,"ORIG CO NAME:ACHMA VISB CO ENTRY DESCR:BILL PYMNT IND NAME:PAUL LORENZO",-140.71,ACH_DEBIT,25023.32,,
CREDIT,06/08/2026,"ORIG CO NAME:STRIPE CO ENTRY DESCR:TRANSFER IND NAME:MIRROR ADVISORS LLC",3034.07,ACH_CREDIT,25164.03,,
DEBIT,06/03/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:invoice-1140192",-31.00,MISC_DEBIT,22129.96,,
DEBIT,06/02/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-479.34,MISC_DEBIT,22160.96,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-130.40,MISC_DEBIT,22640.30,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-262.88,MISC_DEBIT,22770.70,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-394.65,MISC_DEBIT,23033.58,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-423.45,MISC_DEBIT,23428.23,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-472.54,MISC_DEBIT,23851.68,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-972.80,MISC_DEBIT,24324.22,,
DEBIT,06/01/2026,"ORIG CO NAME:Wise Inc CO ENTRY DESCR:WISE IND ID:TrnWise",-1105.51,MISC_DEBIT,25297.02,,
DEBIT,06/01/2026,"ORIG CO NAME:Mirror Advisors CO ENTRY DESCR:Stripe Cap ST-C3P0Y0V9G8S3",-459.89,ACH_DEBIT,26402.53,,`;

const CHASE_CC = `Card,Transaction Date,Post Date,Description,Category,Type,Amount,Memo
3209,06/11/2026,06/14/2026,HAMPTON INNS,Travel,Sale,-175.56,
3209,06/11/2026,06/14/2026,HAMPTON INNS,Travel,Sale,-175.56,
3209,06/11/2026,06/12/2026,ANTHROPIC* CLAUDE SUB,Office & Shipping,Sale,-106.20,
3209,06/11/2026,06/12/2026,FOGO DE CHAO - UPTOWN,Food & Drink,Sale,-237.58,
3209,06/01/2026,06/01/2026,PURCHASE INTEREST CHARGE,Fees & Adjustments,Fee,-176.75,`;

const STRIPE = `id,Created date (UTC),Amount,Amount Refunded,Currency,Captured,Fee,Status,Description,Customer Email,Invoice ID,Transfer,Name (metadata),email (metadata),merchant_reference (metadata)
ch_3Tf4ViLQF3ru3dK41qpOrr9c,2026-06-05 20:38:34,3125.00,0.00,usd,true,90.93,Paid,Mirror Advisors LLC - INV-0168,,,po_1TfrEDLQF3ru3dK46gREVJaK,CoverFour,ian.todd@coverfourwins.com,4826813000009697001`;

// --- 1. Date parsing (year-aware) -------------------------------------------
ok("parseDate MM/DD/YYYY → monthIdx", parseDate("06/16/2026").monthIdx === 5);
ok("parseDate YYYY-MM-DD → monthIdx", parseDate("2026-06-05 20:38:34").monthIdx === 5);
ok("parseDate 2027 rolls horizon", parseDate("01/15/2027").monthIdx === 12);
ok("parseDate junk → null", parseDate("not a date") === null);

// --- 2. Format detection -----------------------------------------------------
const checking = parseStatement(CHASE_CHECKING, "Chase6692_Activity_20260616.CSV");
const cc = parseStatement(CHASE_CC, "Chase3209.CSV");
const stripe = parseStatement(STRIPE, "unified_payments.csv");
ok("detect chase_checking", checking.format === "chase_checking");
ok("detect chase_cc", cc.format === "chase_cc");
ok("detect stripe unified", stripe.format === "stripe");
ok("checking account from filename", checking.transactions[0].account === "chase_6692");
ok("cc account from Card column", cc.transactions[0].account === "chase_cc_3209");
ok("stripe carries client metadata", stripe.transactions[0].meta.email === "ian.todd@coverfourwins.com");
ok("stripe net = amount - fee", approx(stripe.transactions[0].meta.net, 3034.07));

// --- 3. Classification -------------------------------------------------------
const clients = [{ id: "cX", nm: "CoverFour", email: "ian.todd@coverfourwins.com" }];
const classified = classifyAll(
  [...checking.transactions, ...cc.transactions, ...stripe.transactions],
  { clients }
);
const find = (re) => classified.find((t) => re.test(t.description));
ok("ADP wage → payroll", find(/WAGE PAY/).category === "payroll");
ok("ADP tax → employer_taxes", find(/ADP Tax/).category === "employer_taxes");
ok("ADP fees → adp_fees", find(/ADP PAYROLL FEES/).category === "adp_fees");
ok("Stripe transfer → stripe_payout (transfer flow)", find(/STRIPE.*TRANSFER/).flow === "transfer");
ok("Zoho wire credit → commission_revenue", find(/ZOHO/).category === "commission_revenue");
ok("Stripe Cap → loan_paydown (financing)", find(/Stripe Cap/).flow === "financing");
ok("Anthropic CC → subscription", classified.find((t) => /ANTHROPIC/.test(t.description)).category === "subscription");
const stripeClassified = classified.find((t) => t.source === "stripe");
ok("Stripe payment matched to client by email", stripeClassified.clientId === "cX");

// --- 4. Running-balance reconstruction (blank balances) ---------------------
const recon = reconstructBalances(checking.transactions);
const lastJune = recon[recon.length - 1]; // chronological → newest
ok("reconstructs closing balance through blank 06/16 rows", approx(lastJune.balance, 24891.22),
  `got ${lastJune.balance}`);

// --- 5. Monthly rollup -------------------------------------------------------
const cov = coverageFromTransactions(checking.transactions);
const summaries = buildMonthlySummaries(classified, cov);
const jun = summaries[5];
ok("June closing balance", approx(jun.closingBal, 24891.22), `got ${jun.closingBal}`);
ok("June cashIn = all checking credits", approx(jun.cashIn, 6550.02), `got ${jun.cashIn}`);
ok("June cashOut = all checking debits", approx(jun.cashOut, -8521.22), `got ${jun.cashOut}`);
// revenueIn excludes the Stripe payout transfer (3034.07) — counts Zoho + Hampton.
ok("June revenueIn excludes Stripe transfer", !approx(jun.revenueIn, 6550.02) && jun.revenueIn < jun.cashIn,
  `revenueIn=${jun.revenueIn} cashIn=${jun.cashIn}`);
ok("June Stripe payout sits in transferNet", approx(jun.transferNet, 3034.07), `got ${jun.transferNet}`);
ok("June not complete (statement ends 06/16)", jun.complete === false);

// --- 6. Dedup / merge --------------------------------------------------------
// Two identical hotel charges must both survive parsing (not collapsed).
const hotels = cc.transactions.filter((t) => /HAMPTON INNS/.test(t.description));
ok("two identical CC charges both kept", hotels.length === 2);

// Re-uploading the same checking statement must NOT double the transactions.
const store0 = checking.transactions.slice();
const merged = mergeTransactions(store0, [parseStatement(CHASE_CHECKING, "Chase6692.CSV")]);
ok("re-upload supersedes same window (no doubling)", merged.transactions.length === store0.length,
  `before=${store0.length} after=${merged.transactions.length}`);

// Stripe re-upload dedups by extId.
const stripeStore = stripe.transactions.slice();
const mergedStripe = mergeTransactions(stripeStore, [parseStatement(STRIPE, "stripe.csv")]);
ok("stripe re-upload dedups by id", mergedStripe.transactions.length === stripeStore.length);

// --- 7. Forecast lock in compute() ------------------------------------------
const { compute } = await import("../src/compute.js");
const { D0 } = await import("../src/data.js");
const base = compute(D0);
// A COMPLETE actual for May (idx 4) should anchor bl[4]; an incomplete one must not.
const locked = compute({ ...D0, actuals: { 4: { closingBal: 99999, complete: true } } });
const notLocked = compute({ ...D0, actuals: { 4: { closingBal: 99999, complete: false } } });
ok("complete actual anchors balance curve", approx(locked.bl[4], 99999));
ok("later months project from the anchor", locked.bl[5] !== base.bl[5]);
ok("incomplete actual does NOT lock (back-compat)", approx(notLocked.bl[4], base.bl[4]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
