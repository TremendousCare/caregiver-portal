-- Rollback for 20260516020000_bd_mileage_entries.sql.
--
-- v1 of the mileage tracker is additive (new table only). Rollback
-- drops policies, indexes, the trigger, and the table itself. No
-- other table is touched.
--
-- Pre-flight check before running this in production:
--   SELECT count(*) FROM bd_mileage_entries;
-- A non-zero count means rolling back will delete real mileage
-- entries — confirm with the owner first.

DROP TRIGGER  IF EXISTS bd_mileage_entries_set_updated_at ON bd_mileage_entries;

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select"     ON bd_mileage_entries;
DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_insert"     ON bd_mileage_entries;
DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_update"     ON bd_mileage_entries;
DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_delete"     ON bd_mileage_entries;
DROP POLICY IF EXISTS "service_role_full_access_bd_mileage_entries"    ON bd_mileage_entries;

DROP INDEX IF EXISTS idx_bd_mileage_entries_org_user_date;
DROP INDEX IF EXISTS idx_bd_mileage_entries_org;
DROP INDEX IF EXISTS idx_bd_mileage_entries_org_status;
DROP INDEX IF EXISTS idx_bd_mileage_entries_activity;
DROP INDEX IF EXISTS idx_bd_mileage_entries_account_date;

DROP TABLE IF EXISTS bd_mileage_entries;
