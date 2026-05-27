-- Task Notifications Dispatcher — schema + cron (Phase 2 of the
-- user-created follow-ups initiative). See docs/TASKS_AND_FOLLOWUPS.md.
--
-- This migration ships three pieces in one atomic file so a deploy
-- that lands part-way leaves the system in a self-consistent state:
--
--   1. Widen `notifications_user.notification_type` CHECK to include
--      'task_due'. Phase 1's dispatch index already exists; this
--      unlocks the dispatcher to actually insert rows.
--
--   2. Add a partial index on `follow_up_tasks(snoozed_until)` to
--      keep the snooze-expiry sweep cheap as the table grows toward
--      multi-tenant scale.
--
--   3. Register the pg_cron job `dispatch-task-notifications` that
--      invokes the edge function every 5 minutes. Mirrors the
--      `dispatch-lead-notifications` cadence and unschedule-idempotency
--      pattern.
--
-- Production safety:
--   • The widened CHECK accepts both 'new_lead' (existing) and
--     'task_due' (new). Zero impact on lead notifications.
--   • The dispatcher is a no-op until at least one task has
--     assigned_to set AND due_at <= now() AND notified_at IS NULL.
--     Until then the partial dispatch index returns zero rows per
--     tick.
--   • Failures inside the edge function are caught per-row.
--
-- Idempotency: every CREATE / ALTER uses IF NOT EXISTS or
-- DROP-CONSTRAINT-then-ADD-CONSTRAINT wrapped in pg_constraint
-- existence checks.

-- ────────────────────────────────────────────────────────────────────
-- 1. Widen notifications_user.notification_type CHECK
-- ────────────────────────────────────────────────────────────────────
-- DROP-then-ADD pattern keeps the migration idempotent: re-running
-- replaces the constraint with the same definition.

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
    CHECK (notification_type IN ('new_lead', 'task_due'));
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 2. Snooze-expiry index
-- ────────────────────────────────────────────────────────────────────
-- The dispatcher flips status='snoozed' rows back to 'pending' when
-- snoozed_until <= now(). With a partial index this is a constant-
-- time index probe instead of a table scan.

CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_snooze_expiry
  ON public.follow_up_tasks (snoozed_until)
  WHERE status = 'snoozed';

-- ────────────────────────────────────────────────────────────────────
-- 3. Cron job — dispatch-task-notifications
-- ────────────────────────────────────────────────────────────────────
-- Every 5 minutes, mirroring dispatch-lead-notifications. The edge
-- function:
--   • Flips status='snoozed' AND snoozed_until<=now() back to pending
--     (clears notified_at so the next pass re-notifies).
--   • Scans status='pending' AND due_at<=now() AND notified_at IS NULL
--     AND assigned_to IS NOT NULL.
--   • For each matched row: inserts a notifications_user row, sets
--     notified_at, and emits a task_due event.
--
-- Idempotency: unschedule-if-exists guard wrapped in a swallow-
-- exceptions block, matching the lead-notifications pattern.

DO $$
BEGIN
  PERFORM cron.unschedule('dispatch-task-notifications')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-task-notifications'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'dispatch-task-notifications',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/dispatch-task-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

-- ────────────────────────────────────────────────────────────────────
-- 4. Sanity
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-task-notifications'
  ) THEN
    RAISE EXCEPTION
      'dispatch-task-notifications cron job did not register after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_user_notification_type_check'
      AND conrelid = 'public.notifications_user'::regclass
  ) THEN
    RAISE EXCEPTION
      'notifications_user_notification_type_check missing after migration';
  END IF;
END $$;
