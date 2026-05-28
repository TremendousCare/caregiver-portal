-- Rollback for exec_staff_members.
--
-- ⚠️  Drops data: every staff_members row is lost. Only run if you
--     are certain no exec_tasks instances reference these emails as
--     anchor_staff_email (drop the exec_tables migration first).

DROP POLICY IF EXISTS staff_members_staff_select ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_insert ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_update ON public.staff_members;
DROP POLICY IF EXISTS staff_members_owner_delete ON public.staff_members;

DROP TRIGGER IF EXISTS staff_members_touch_updated_at ON public.staff_members;

DROP TABLE IF EXISTS public.staff_members;
