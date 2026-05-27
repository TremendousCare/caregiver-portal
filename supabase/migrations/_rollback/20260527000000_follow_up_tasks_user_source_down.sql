-- Rollback for follow_up_tasks user_source migration.
--
-- Safe to run iff no user/ai-source rows exist. Any rows with
-- source IN ('user','ai') would have NULLs in template_id /
-- caregiver_id / client_id and would violate the original NOT NULL
-- constraints once we restore them. Bail with a clear message in
-- that case rather than silently corrupting state.
--
-- Per CLAUDE.md Prime Directives, destructive rollbacks need explicit
-- owner approval.

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.follow_up_tasks
   WHERE source IN ('user', 'ai');
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Cannot roll back: % user/ai-source tasks exist. Delete or migrate them first.', v_count;
  END IF;
END $$;

-- Drop indexes (idempotent).
DROP INDEX IF EXISTS public.idx_follow_up_tasks_dispatch;
DROP INDEX IF EXISTS public.idx_follow_up_tasks_assigned;

-- Drop CHECK constraints (idempotent).
ALTER TABLE public.follow_up_tasks
  DROP CONSTRAINT IF EXISTS follow_up_tasks_shape_check,
  DROP CONSTRAINT IF EXISTS follow_up_tasks_source_check;

-- Restore NOT NULL on the three relaxed columns. Safe because we
-- bailed above if any rows would violate them.
ALTER TABLE public.follow_up_tasks
  ALTER COLUMN template_id  SET NOT NULL,
  ALTER COLUMN caregiver_id SET NOT NULL,
  ALTER COLUMN client_id    SET NOT NULL;

-- Drop the new columns (idempotent).
ALTER TABLE public.follow_up_tasks
  DROP COLUMN IF EXISTS notified_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS source;
