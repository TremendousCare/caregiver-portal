-- Rollback for 20260508120000_bd_module_phase_0_foundation.sql
--
-- Drops the BD module Phase 0 tables in dependency order. Safe because
-- Phase 0 is schema-only (no application code reads or writes these
-- tables yet) — but irreversible once Phase 1 ships and data lands.
-- Use only during the Phase 0 deploy window if the migration needs to
-- be reverted, before any rep activity is logged.
--
-- Order: child tables first (have FKs to bd_accounts /
-- bd_account_contacts), then parents.

DROP TABLE IF EXISTS public.bd_trello_import_staging CASCADE;
DROP TABLE IF EXISTS public.bd_goals                 CASCADE;
DROP TABLE IF EXISTS public.bd_referrals             CASCADE;
DROP TABLE IF EXISTS public.bd_activities            CASCADE;
DROP TABLE IF EXISTS public.bd_account_contacts      CASCADE;
DROP TABLE IF EXISTS public.bd_accounts              CASCADE;
