-- Rollback for exec_tables.
--
-- ⚠️  Drops data: every exec_task_templates, exec_tasks, exec_goals,
--     exec_key_results, and exec_goal_checkins row is lost. Per
--     CLAUDE.md Prime Directives this requires explicit owner
--     approval. Children cascade from goals → key_results → checkins.

-- Policies first (so the DROP TABLE doesn't have to chase them)
DO $$
DECLARE
  t text;
  cmd text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['exec_task_templates', 'exec_tasks',
                               'exec_goals', 'exec_key_results',
                               'exec_goal_checkins']) LOOP
    FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                     t || '_owner_' || cmd, t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                     t || '_admin_' || cmd, t);
    END LOOP;
  END LOOP;
END
$$;

-- Triggers
DROP TRIGGER IF EXISTS exec_task_templates_touch_updated_at ON public.exec_task_templates;
DROP TRIGGER IF EXISTS exec_tasks_touch_updated_at          ON public.exec_tasks;
DROP TRIGGER IF EXISTS exec_goals_touch_updated_at          ON public.exec_goals;
DROP TRIGGER IF EXISTS exec_key_results_touch_updated_at    ON public.exec_key_results;

-- Tables — children before parents
DROP TABLE IF EXISTS public.exec_goal_checkins;
DROP TABLE IF EXISTS public.exec_key_results;
DROP TABLE IF EXISTS public.exec_goals;
DROP TABLE IF EXISTS public.exec_tasks;
DROP TABLE IF EXISTS public.exec_task_templates;
