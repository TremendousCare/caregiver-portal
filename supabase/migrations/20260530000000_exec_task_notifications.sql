-- ═══════════════════════════════════════════════════════════════
-- Executive Task Notifications — schema additions
--
-- Wires exec_tasks into the existing notifications_user pipeline so
-- owners see in-app notifications when tasks come due, with an
-- optional per-template email channel.
--
-- Three changes:
--
--   1. exec_task_templates.send_email_on_notify boolean DEFAULT false
--      Per-template opt-in for the email channel. Bell notifications
--      are always on (free + non-noisy). Email is opt-in because
--      it adds inbox noise and not every recurring task needs it
--      (e.g. weekly owner 1:1 = bell is enough; annual HIPAA risk
--      assessment = email is worth it for the paper trail).
--
--   2. exec_tasks.notified_at timestamptz NULL
--      Idempotency marker. The dispatcher writes this in the same
--      pass as the notifications_user insert; a second cron tick
--      skips already-notified rows. Rescheduling a task (changing
--      due_at) does NOT clear this — owners can reset by reopening
--      or by directly editing through the API. Matches the
--      follow_up_tasks idempotency contract.
--
--   3. public.get_owner_emails(p_org_id uuid) → text[]
--      Returns the set of owner emails for the org. Used by the
--      dispatcher's fan-out logic: when a task has assigned_to=NULL
--      (the new default for unassigned exec work), the bell
--      notification + optional email goes to every owner.
--
--      SECURITY DEFINER + STABLE so it can read user_roles even
--      when the calling context is restricted. Matches the pattern
--      of is_admin() / is_staff() / is_owner().
--
--      Why user_roles vs org_memberships: user_roles is the
--      canonical role source the rest of the codebase reads
--      (matches is_admin/is_staff/is_owner). For multi-tenant rollout
--      this will need to switch to org_memberships scoped by p_org_id;
--      for the single-org install today the result is the same set.
--
-- Multi-tenancy: every new column carries org_id either directly
-- (notified_at sits on a row that already has org_id) or via the
-- parent row's org scope.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. exec_task_templates.send_email_on_notify
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.exec_task_templates
  ADD COLUMN IF NOT EXISTS send_email_on_notify boolean NOT NULL DEFAULT false;

-- ────────────────────────────────────────────────────────────────────
-- 2. exec_tasks.notified_at + dispatch hot-path index
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.exec_tasks
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- Partial index for the dispatcher's hot path: "what's due that hasn't
-- been notified yet?" Excludes done/cancelled because they never need
-- notifications. now() can't appear in a partial index predicate (not
-- IMMUTABLE), so we filter at query time.
CREATE INDEX IF NOT EXISTS idx_exec_tasks_dispatch_pending
  ON public.exec_tasks (due_at)
  WHERE notified_at IS NULL AND status IN ('pending', 'in_progress');

-- ────────────────────────────────────────────────────────────────────
-- 3. public.get_owner_emails(p_org_id)
-- ────────────────────────────────────────────────────────────────────
-- Returns text[] of owner emails. p_org_id is accepted for forward-
-- compatibility with the multi-tenant rollout — today it's unused
-- because user_roles is not org-scoped, but every caller passes it so
-- the function's signature won't need to change when org_memberships
-- becomes the source.

CREATE OR REPLACE FUNCTION public.get_owner_emails(p_org_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(DISTINCT lower(email) ORDER BY lower(email)), ARRAY[]::text[])
  FROM user_roles
  WHERE role = 'owner'
    AND email IS NOT NULL
    AND email <> '';
$$;

REVOKE ALL ON FUNCTION public.get_owner_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_owner_emails(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 4. Sanity checks
-- ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'exec_task_templates'
      AND column_name = 'send_email_on_notify'
  ) THEN
    RAISE EXCEPTION 'exec_task_notifications: send_email_on_notify column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'exec_tasks'
      AND column_name = 'notified_at'
  ) THEN
    RAISE EXCEPTION 'exec_task_notifications: notified_at column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_owner_emails'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION 'exec_task_notifications: get_owner_emails() missing or not SECURITY DEFINER';
  END IF;

  -- Soft assertion: in production we expect Kevin + Blerta to be
  -- present. Note the function ignores org scope today so it returns
  -- every owner across the install — fine for single-org.
  SELECT array_length(public.get_owner_emails(public.default_org_id()), 1) INTO v_owner_count;
  IF v_owner_count IS NULL OR v_owner_count < 1 THEN
    RAISE NOTICE
      'exec_task_notifications: get_owner_emails() returned 0 owners — dispatcher fan-out will be a no-op until at least one user_roles row has role=owner';
  END IF;
END
$$;
