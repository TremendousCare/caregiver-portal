-- Rollback for exec_task_notifications schema additions.
--
-- ⚠️  Drops data: every notified_at timestamp is lost, and the
--     send_email_on_notify column (along with any owner-edited
--     values) goes with it. Run only if no in-flight notifications
--     are mid-dispatch.

-- 1. Drop the helper function
DROP FUNCTION IF EXISTS public.get_owner_emails(uuid);

-- 2. Drop the dispatch-path index
DROP INDEX IF EXISTS public.idx_exec_tasks_dispatch_pending;

-- 3. Drop the new columns
ALTER TABLE public.exec_tasks
  DROP COLUMN IF EXISTS notified_at;

ALTER TABLE public.exec_task_templates
  DROP COLUMN IF EXISTS send_email_on_notify;
