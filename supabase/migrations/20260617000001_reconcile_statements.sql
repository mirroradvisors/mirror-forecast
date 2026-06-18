-- ============================================================================
-- Statement reconcile — raw bank/CC/Stripe transaction store + learned rules.
--
-- These tables are a SEPARATE concern from the forecast `d` blob: they are NOT
-- routed through save_forecast_rows() (which wipes-and-replaces the whole dataset
-- on every forecast save). Transaction history accumulates and would bloat every
-- save. Instead the app reads/writes them directly (src/reconcileStore.js), and the
-- only thing that flows back into `d` is the per-month rollup → actuals table →
-- compute()'s forecast lock.
--
-- ADDITIVE & SAFE: creates new objects + one nullable-with-default column on
-- actuals + CREATE OR REPLACE on save_forecast_rows (to carry that column).
-- Rollback: supabase/rollback/0002_rollback.sql.
-- ============================================================================

-- ---------- UPLOAD AUDIT (one row per imported file) ------------------------
-- coverage_* drive the "replace-by-range" supersede logic for bank statements.
CREATE TABLE IF NOT EXISTS statement_uploads (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source         text NOT NULL,                 -- 'chase_checking'|'chase_cc'|'stripe'|'wise'
  file_name      text NOT NULL,
  accounts       text[] NOT NULL DEFAULT '{}',
  coverage_start date,
  coverage_end   date,
  row_count      int  NOT NULL DEFAULT 0,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  uploaded_by    text
);

-- ---------- RAW TRANSACTIONS (deduped store) --------------------------------
-- ext_id: stable id for Stripe/Wise rows (globally unique → dedup by it).
-- Bank rows have no ext_id; cross-upload dedup is replace-by-range in the app.
-- client_id is a SOFT reference (no FK): save_forecast_rows wipes clients on every
-- forecast save, so a hard FK would break the all-or-nothing write.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ext_id       text,
  source       text NOT NULL,
  account      text NOT NULL,
  txn_date     date NOT NULL,
  month_idx    int  NOT NULL,
  amount       numeric NOT NULL,
  description  text NOT NULL DEFAULT '',
  raw_type     text NOT NULL DEFAULT '',
  balance      numeric,
  category     text,
  flow         text,
  counterparty text,
  client_id    text,
  confidence   numeric,
  reviewed     boolean NOT NULL DEFAULT false,   -- user confirmed/overrode the match
  meta         jsonb NOT NULL DEFAULT '{}',
  upload_id    bigint REFERENCES statement_uploads(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_extid_uq ON bank_transactions(ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_txn_acct_date_idx ON bank_transactions(account, txn_date);
CREATE INDEX IF NOT EXISTS bank_txn_month_idx ON bank_transactions(month_idx);

-- ---------- LEARNED MATCH RULES (review-screen corrections) -----------------
-- Tried AHEAD of the app's DEFAULT_RULES (higher priority first), so a user
-- correction sticks across future uploads. `pattern` is a regex source (the app
-- compiles it case-insensitive). sign: +1 credits only, -1 debits only, null any.
CREATE TABLE IF NOT EXISTS match_rules (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pattern      text NOT NULL,
  source       text,
  sign         smallint CHECK (sign IN (-1, 1)),
  category     text NOT NULL,
  counterparty text,
  client_id    text,
  priority     int  NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);

-- ---------- actuals: lock flag ----------------------------------------------
-- compute()'s forecast lock only anchors a month whose statement covered its full
-- span. Default false keeps every existing actuals row (and the RPC) valid.
ALTER TABLE actuals ADD COLUMN IF NOT EXISTS complete boolean NOT NULL DEFAULT false;

-- ============================================================================
-- RLS — members read, admins write, anon none. service_role bypasses (ops).
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['statement_uploads','bank_transactions','match_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY sel_%1$s ON %1$I FOR SELECT TO authenticated USING (public.is_member())', t);
    EXECUTE format('CREATE POLICY mod_%1$s ON %1$I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Re-create save_forecast_rows so the atomic write carries actuals.complete.
-- Identical to 20260615000001 except the actuals INSERT column list (+complete).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_forecast_rows(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.is_admin() OR coalesce(auth.jwt() ->> 'role', '') = 'service_role') THEN
    RAISE EXCEPTION 'save_forecast_rows: admin role required';
  END IF;

  IF jsonb_array_length(coalesce(p->'clients','[]'::jsonb)) = 0
     OR jsonb_array_length(coalesce(p->'team_members','[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'save_forecast_rows: refusing to wipe — empty clients/team payload';
  END IF;

  DELETE FROM payment_schedule WHERE true;
  DELETE FROM service_contracts WHERE true;
  DELETE FROM zoho_commissions WHERE true;
  DELETE FROM clients WHERE true;
  DELETE FROM scenarios WHERE true;
  DELETE FROM team_members WHERE true;
  DELETE FROM cost_lines WHERE true;
  DELETE FROM subscriptions WHERE true;
  DELETE FROM actuals WHERE true;
  DELETE FROM manual_revenue WHERE true;
  DELETE FROM rv_actuals WHERE true;
  DELETE FROM forecast_vectors WHERE true;
  DELETE FROM forecast_meta WHERE true;

  INSERT INTO forecast_meta (id,open_bal,cash_now,savings,s_loan,cc_owe,horizon)
    SELECT id,open_bal,cash_now,savings,s_loan,cc_owe,horizon
    FROM jsonb_populate_recordset(null::forecast_meta, coalesce(p->'forecast_meta','[]'::jsonb));
  INSERT INTO forecast_vectors (id,et,af,wf)
    SELECT id,et,af,wf
    FROM jsonb_populate_recordset(null::forecast_vectors, coalesce(p->'forecast_vectors','[]'::jsonb));
  INSERT INTO rv_actuals (stream,overrides)
    SELECT stream,overrides
    FROM jsonb_populate_recordset(null::rv_actuals, coalesce(p->'rv_actuals','[]'::jsonb));
  INSERT INTO manual_revenue (stream,v)
    SELECT stream,v
    FROM jsonb_populate_recordset(null::manual_revenue, coalesce(p->'manual_revenue','[]'::jsonb));
  INSERT INTO actuals (month_idx,closing_bal,total_in,total_out,chase_in,chase_out,stripe_in,stripe_payout,stripe_loan,wise_out,wise_fees,cc_spend,cc_fees,recon_date,complete)
    SELECT month_idx,closing_bal,total_in,total_out,chase_in,chase_out,stripe_in,stripe_payout,stripe_loan,wise_out,wise_fees,cc_spend,cc_fees,recon_date,coalesce(complete,false)
    FROM jsonb_populate_recordset(null::actuals, coalesce(p->'actuals','[]'::jsonb));
  INSERT INTO subscriptions (pos,n,a,start_mo,end_mo)
    SELECT pos,n,a,start_mo,end_mo
    FROM jsonb_populate_recordset(null::subscriptions, coalesce(p->'subscriptions','[]'::jsonb));
  INSERT INTO cost_lines (kind,pos,n,v)
    SELECT kind,pos,n,v
    FROM jsonb_populate_recordset(null::cost_lines, coalesce(p->'cost_lines','[]'::jsonb));
  INSERT INTO team_members (id,pos,nm,rl,dp,ct,co,on_flag,start_mo,end_mo,month_overrides)
    SELECT id,pos,nm,rl,dp,ct,co,on_flag,start_mo,end_mo,month_overrides
    FROM jsonb_populate_recordset(null::team_members, coalesce(p->'team_members','[]'::jsonb));
  INSERT INTO scenarios (id,pos,name,type,amount,start_mo,duration,on_flag)
    SELECT id,pos,name,type,amount,start_mo,duration,on_flag
    FROM jsonb_populate_recordset(null::scenarios, coalesce(p->'scenarios','[]'::jsonb));
  INSERT INTO clients (id,pos,nm,email,notes,last_edited_at,last_edited_by)
    SELECT id,pos,nm,email,notes,last_edited_at,last_edited_by
    FROM jsonb_populate_recordset(null::clients, coalesce(p->'clients','[]'::jsonb));
  INSERT INTO service_contracts (client_id,type,segment,monthly_amount,monthly_renewal_day,start_date,end_date,status,in_forecast)
    SELECT client_id,type,segment,monthly_amount,monthly_renewal_day,start_date,end_date,status,in_forecast
    FROM jsonb_populate_recordset(null::service_contracts, coalesce(p->'service_contracts','[]'::jsonb));
  INSERT INTO payment_schedule (client_id,pos,due_date,amount,paid,paid_date,note,status)
    SELECT client_id,pos,due_date,amount,paid,paid_date,note,status
    FROM jsonb_populate_recordset(null::payment_schedule, coalesce(p->'payment_schedule','[]'::jsonb));
  INSERT INTO zoho_commissions (client_id,zoho_product,licenses,frequency,monthly_amount,annual_amount,renewal_date,renewal_day,status,in_forecast,note,zoho_subscription_id,zoho_customer_id,zoho_synced_at)
    SELECT client_id,zoho_product,licenses,frequency,monthly_amount,annual_amount,renewal_date,renewal_day,status,in_forecast,note,zoho_subscription_id,zoho_customer_id,zoho_synced_at
    FROM jsonb_populate_recordset(null::zoho_commissions, coalesce(p->'zoho_commissions','[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.save_forecast_rows(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_forecast_rows(jsonb) TO authenticated, service_role;
