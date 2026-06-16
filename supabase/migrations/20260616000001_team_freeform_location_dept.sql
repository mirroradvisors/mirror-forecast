-- ============================================================================
-- Free-form team location + extensible departments.
-- team_members.ct (team_country enum: US/PH/IN) and .dp (team_dept enum: 4 values)
-- become free text so payroll can use any location ("Canada", "Mexico", …) and
-- any department/group ("Sales", "Support", …). compute.js now groups payroll by
-- whatever ct values are present; the "US"/"IN" employer-tax/Wise-fee extras stay
-- keyed to those codes. Round-trips unchanged (forecastTables already treats
-- ct/dp as strings; save_forecast_rows inserts text fine once the columns widen).
--
-- SAFE: widening enum → text preserves all existing values. The now-unused enum
-- types are left in place (harmless) in case of rollback.
-- ============================================================================

ALTER TABLE team_members ALTER COLUMN ct TYPE text USING ct::text;
ALTER TABLE team_members ALTER COLUMN dp TYPE text USING dp::text;
