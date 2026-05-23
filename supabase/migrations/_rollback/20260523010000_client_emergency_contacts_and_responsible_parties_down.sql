-- Rollback for client_emergency_contacts + client_responsible_parties.
--
-- ⚠️  This drops data. Only run if you are sure no one has saved
--     contacts through the new intake UI yet. The CLAUDE.md Prime
--     Directives forbid DELETE/DROP without explicit owner approval —
--     this script exists for migration parity, not as a recommended
--     undo path.

DROP POLICY IF EXISTS client_responsible_parties_staff_select  ON public.client_responsible_parties;
DROP POLICY IF EXISTS client_responsible_parties_staff_insert  ON public.client_responsible_parties;
DROP POLICY IF EXISTS client_responsible_parties_staff_update  ON public.client_responsible_parties;
DROP POLICY IF EXISTS client_responsible_parties_staff_delete  ON public.client_responsible_parties;

DROP POLICY IF EXISTS client_emergency_contacts_staff_select   ON public.client_emergency_contacts;
DROP POLICY IF EXISTS client_emergency_contacts_staff_insert   ON public.client_emergency_contacts;
DROP POLICY IF EXISTS client_emergency_contacts_staff_update   ON public.client_emergency_contacts;
DROP POLICY IF EXISTS client_emergency_contacts_staff_delete   ON public.client_emergency_contacts;

DROP TRIGGER IF EXISTS client_responsible_parties_touch_updated_at
  ON public.client_responsible_parties;
DROP TRIGGER IF EXISTS client_emergency_contacts_touch_updated_at
  ON public.client_emergency_contacts;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'client_responsible_parties'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.client_responsible_parties;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'client_emergency_contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.client_emergency_contacts;
  END IF;
END $$;

DROP TABLE IF EXISTS public.client_responsible_parties;
DROP TABLE IF EXISTS public.client_emergency_contacts;
