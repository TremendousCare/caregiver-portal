-- Rollback for 20260513140000_bd_territories_and_strategic_flag.sql
--
-- Drops the helper function, the two new tables (cascade clears their
-- policies and indexes), and the is_strategic_shared column.
--
-- Safe to run after the seed has been rolled back (or if the seed was
-- never applied). Running this against a database where any frontend
-- code still expects bd_territories will break that code — coordinate
-- the revert with a Vercel deploy that no longer reads these tables.

DROP FUNCTION IF EXISTS public.bd_current_user_territory_cities();

DROP TABLE IF EXISTS bd_territory_members;
DROP TABLE IF EXISTS bd_territories;

ALTER TABLE bd_accounts DROP COLUMN IF EXISTS is_strategic_shared;
