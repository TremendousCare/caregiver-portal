-- Rollback for the task-notifications dispatcher migration.
--
-- Reverses the cron registration, the snooze index, and the
-- notification_type widening. Safe to run iff no task_due rows exist
-- in notifications_user (otherwise the narrowed CHECK would fail).
-- Bail with a clear message in that case.

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.notifications_user
   WHERE notification_type = 'task_due';
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Cannot roll back: % task_due notifications exist. Delete them first.', v_count;
  END IF;
END $$;

-- Unschedule the cron job (swallow errors so a rollback after a
-- partial install still succeeds).
DO $$
BEGIN
  PERFORM cron.unschedule('dispatch-task-notifications')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-task-notifications'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Drop the snooze index.
DROP INDEX IF EXISTS public.idx_follow_up_tasks_snooze_expiry;

-- Narrow notification_type back to lead-only.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_user_notification_type_check'
      AND conrelid = 'public.notifications_user'::regclass
  ) THEN
    ALTER TABLE public.notifications_user
      DROP CONSTRAINT notifications_user_notification_type_check;
  END IF;

  ALTER TABLE public.notifications_user
    ADD CONSTRAINT notifications_user_notification_type_check
    CHECK (notification_type IN ('new_lead'));
END $$;
