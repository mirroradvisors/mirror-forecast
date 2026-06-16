-- ============================================================================
-- Zoho Partner API sync — persistent client<->Zoho link.
-- ADDITIVE: three nullable columns on zoho_commissions so the sync script can
-- record which Zoho subscription/customer a commission row came from (after the
-- first email match) and when it was last reconciled against Zoho.
--   zoho_subscription_id  exact link; future syncs match on this, not email
--   zoho_customer_id      secondary link (a customer may hold >1 subscription)
--   zoho_synced_at        last time this row was reconciled from the Partner API
-- These round-trip through d.cl[].zohoCommission as zohoSubscriptionId /
-- zohoCustomerId / zohoSyncedAt (see src/forecastTables.js). Nullable so every
-- existing row stays valid and untouched until the sync first writes it.
--
-- SAFE TO RUN: adds columns + CREATE OR REPLACE on the write RPC only.
-- ============================================================================

ALTER TABLE zoho_commissions
  ADD COLUMN IF NOT EXISTS zoho_subscription_id text,
  ADD COLUMN IF NOT EXISTS zoho_customer_id     text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at       timestamptz;

-- Fast lookup when matching an incoming Zoho subscription back to its row.
CREATE INDEX IF NOT EXISTS zoho_commissions_subscription_idx
  ON zoho_commissions (zoho_subscription_id);

-- ---------------------------------------------------------------------------
-- Re-create save_forecast_rows so the atomic write carries the new columns.
-- Identical to 20260610000002 except the zoho_commissions INSERT column list.
-- jsonb_populate_recordset already maps the new keys; we just have to include
-- them in the explicit INSERT/SELECT lists.
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
  INSERT INTO actuals (month_idx,closing_bal,total_in,total_out,chase_in,chase_out,stripe_in,stripe_payout,stripe_loan,wise_out,wise_fees,cc_spend,cc_fees,recon_date)
    SELECT month_idx,closing_bal,total_in,total_out,chase_in,chase_out,stripe_in,stripe_payout,stripe_loan,wise_out,wise_fees,cc_spend,cc_fees,recon_date
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
