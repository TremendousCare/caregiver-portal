-- Rollback for 20260516000000_bd_account_stars.sql
--
-- Drops the bd_account_stars table and its policies. CASCADE handles
-- the dependent indexes and policy rows. Star data is intentionally
-- discarded — these are personal favorites, not business records, and
-- if rolled back the operator presumably wants the feature gone.

DROP TABLE IF EXISTS bd_account_stars CASCADE;
