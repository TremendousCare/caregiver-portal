-- Rollback for the Phase 1.1.A agent_actions table.
-- Drops the table (CASCADE because Phase 1.1.B's verifier function
-- and Phase 1.1.C's call sites reference it). This is a destructive
-- rollback — only use if Phase 1.1 is being abandoned wholesale, not
-- for incremental fixes. Per CLAUDE.md prime directives, audit data
-- is precious; if a real rollback is needed, snapshot the table
-- contents to a backup file first.

DROP TABLE IF EXISTS public.agent_actions CASCADE;
