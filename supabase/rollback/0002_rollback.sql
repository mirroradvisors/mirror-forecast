-- Rollback for 20260617000001_reconcile_statements.sql.
-- Drops the statement-reconcile tables and the actuals.complete column.
-- Does NOT restore the prior save_forecast_rows body — re-run 20260615000001
-- afterward if you need the exact pre-this-migration RPC (the current body is a
-- strict superset: it just also carries actuals.complete).

DROP TABLE IF EXISTS bank_transactions;
DROP TABLE IF EXISTS match_rules;
DROP TABLE IF EXISTS statement_uploads;

ALTER TABLE actuals DROP COLUMN IF EXISTS complete;
