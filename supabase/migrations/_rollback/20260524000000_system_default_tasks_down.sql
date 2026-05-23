-- Rollback for system_default_tasks + the
-- care_plan_observations.system_default_task_id column.
--
-- ⚠️  Drops data: every system-default observation history is lost.
--     Only run if you are sure no caregiver has logged a system-default
--     completion through the new flow yet. Per CLAUDE.md Prime
--     Directives, destructive migrations need explicit owner approval.

DROP POLICY IF EXISTS system_default_tasks_authenticated_select ON public.system_default_tasks;
DROP POLICY IF EXISTS system_default_tasks_staff_insert         ON public.system_default_tasks;
DROP POLICY IF EXISTS system_default_tasks_staff_update         ON public.system_default_tasks;
DROP POLICY IF EXISTS system_default_tasks_staff_delete         ON public.system_default_tasks;

DROP TRIGGER IF EXISTS system_default_tasks_touch_updated_at ON public.system_default_tasks;

-- Drop the CHECK constraint before the column so the constraint
-- doesn't dangle.
ALTER TABLE public.care_plan_observations
  DROP CONSTRAINT IF EXISTS care_plan_observations_task_source_xor;

-- The FK column drop will fail if any observation still references a
-- system default and the FK is RESTRICT. ON DELETE SET NULL means
-- dropping the table first nulls every reference, but to be safe we
-- drop the column up front.
ALTER TABLE public.care_plan_observations
  DROP COLUMN IF EXISTS system_default_task_id;

DROP TABLE IF EXISTS public.system_default_tasks;
