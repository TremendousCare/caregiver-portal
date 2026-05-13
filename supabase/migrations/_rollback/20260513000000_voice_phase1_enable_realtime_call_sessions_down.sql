-- Rollback for 20260513000000_voice_phase1_enable_realtime_call_sessions.sql
-- Removes call_sessions from the supabase_realtime publication. Run
-- manually only if Realtime on this table must be disabled — note
-- that doing so silently breaks the screen-pop in the portal.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260513000000_voice_phase1_enable_realtime_call_sessions_down.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'call_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.call_sessions;
  END IF;
END
$$;
