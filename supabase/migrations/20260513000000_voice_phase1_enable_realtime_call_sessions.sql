-- Voice / CTI Phase 1 PR 3.2 — enable Realtime on call_sessions.
--
-- The frontend VoiceProvider (shipped in PR #319) subscribes to
-- postgres_changes on public.call_sessions, filtered to the current
-- user's matched_user_id, to render the screen-pop. That subscription
-- needs the table to be a member of the `supabase_realtime`
-- publication — otherwise the channel is silently empty even though
-- the rows are landing correctly.
--
-- Root cause of the silent-screen-pop bug: PR #310 added call_sessions
-- but did not enable Realtime on it. Confirmed via pg_publication_tables
-- (only caregivers + caregiver_documents were members). Backend was
-- writing the row with the right matched_user_id; the frontend just
-- never saw it.
--
-- This migration ALTERS the existing publication. Idempotent via the
-- pre-check DO block so a re-apply is a no-op.
--
-- Rollback: see _rollback/20260513000000_*.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'call_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.call_sessions;
  END IF;
END
$$;

-- Sanity check.
DO $$
DECLARE
  v_present boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'call_sessions'
  ) INTO v_present;

  IF NOT v_present THEN
    RAISE EXCEPTION
      'call_sessions is not in supabase_realtime publication after migration';
  END IF;
END
$$;
