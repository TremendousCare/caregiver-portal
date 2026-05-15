-- Rollback for 20260515220000_bd_accounts_source_column.sql
--
-- Drops the partial index, the CHECK constraint, then the column itself.
-- The dependent seed migration (20260515220100) rollback must be run
-- first so that no row references this column at the point of DROP.

DROP INDEX IF EXISTS idx_bd_accounts_source_non_manual;

ALTER TABLE bd_accounts
  DROP CONSTRAINT IF EXISTS bd_accounts_source_check;

ALTER TABLE bd_accounts
  DROP COLUMN IF EXISTS source;
