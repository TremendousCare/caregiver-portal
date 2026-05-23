-- Rollback for follow_up_tasks v1.
--
-- ⚠️  Drops data: every generated follow-up instance is lost. Only
--     run if you are sure the office hasn't started using the Tasks
--     dashboard. Per CLAUDE.md Prime Directives, destructive
--     migrations need explicit owner approval.

-- Triggers
DROP TRIGGER IF EXISTS shifts_generate_follow_ups ON public.shifts;
DROP TRIGGER IF EXISTS caregiver_assignments_cancel_follow_ups ON public.caregiver_assignments;
DROP FUNCTION IF EXISTS public.generate_follow_ups_on_first_shift();
DROP FUNCTION IF EXISTS public.cancel_follow_ups_on_assignment_end();

-- Policies (templates)
DROP POLICY IF EXISTS follow_up_templates_staff_select ON public.follow_up_templates;
DROP POLICY IF EXISTS follow_up_templates_staff_insert ON public.follow_up_templates;
DROP POLICY IF EXISTS follow_up_templates_staff_update ON public.follow_up_templates;
DROP POLICY IF EXISTS follow_up_templates_staff_delete ON public.follow_up_templates;

-- Policies (tasks)
DROP POLICY IF EXISTS follow_up_tasks_staff_select ON public.follow_up_tasks;
DROP POLICY IF EXISTS follow_up_tasks_staff_insert ON public.follow_up_tasks;
DROP POLICY IF EXISTS follow_up_tasks_staff_update ON public.follow_up_tasks;
DROP POLICY IF EXISTS follow_up_tasks_staff_delete ON public.follow_up_tasks;

-- Triggers on the touch helper
DROP TRIGGER IF EXISTS follow_up_templates_touch_updated_at ON public.follow_up_templates;
DROP TRIGGER IF EXISTS follow_up_tasks_touch_updated_at ON public.follow_up_tasks;

-- Realtime
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'follow_up_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.follow_up_tasks;
  END IF;
END $$;

-- Tasks first (FK depends on templates), then templates.
DROP TABLE IF EXISTS public.follow_up_tasks;
DROP TABLE IF EXISTS public.follow_up_templates;
