-- Atomic per-row JSONB merge into caregivers.tasks.
--
-- Why this exists
-- ───────────────
-- Routine frontend writes (saveCaregiver) and the execute-automation
-- complete_task action both used a read-modify-write pattern: fetch the
-- whole tasks JSONB, mutate in app memory, then write the whole object
-- back. When two writers race (two tabs, two users, automation + user),
-- the loser silently wipes the winner's task entries.
--
-- The user-visible symptom: an applicant Daniela had moved into the
-- "Pending Interview" filter (which requires the "Send Interview Link"
-- task to be checked) would later appear back in plain Intake — because
-- a stale-state write had replaced the tasks object with one that no
-- longer contained that task's completion.
--
-- This RPC moves the merge into Postgres, where row-level locking makes
-- it atomic. Each call re-reads tasks at the moment of the UPDATE, so
-- concurrent calls serialize and every key is preserved.
--
-- Type and security notes
-- ───────────────────────
-- • caregivers.id is `text` in this schema (UUID-formatted strings, but
--   the column type is text). The RPC parameter must match — using uuid
--   would cause a runtime "operator does not exist: text = uuid" error.
-- • SECURITY INVOKER (the default, made explicit here) ensures the
--   UPDATE is subject to the existing RLS policies on caregivers:
--   `caregivers_staff_all` (gated on is_staff()) and
--   `tenant_isolation_caregivers_update` (gated on auth.jwt() org_id).
--   This matches the security posture of the existing setCaregiverPhaseOverride
--   path (a direct .update() from the JS client). SECURITY DEFINER
--   would bypass those checks and let any authenticated user update
--   any caregiver's tasks across orgs.
--
-- Contract
-- ────────
--   p_patch keys:
--     • truthy value (e.g. {completed:true, completedAt, completedBy})
--       → merged into tasks at that key (overwrites prior value at same key)
--     • literal `false`
--       → merged in as-is (matches the in-memory shape used to record
--         "task uncompleted")
--   Keys NOT present in p_patch are LEFT UNTOUCHED. That is the whole point.
--
-- Idempotent and safe to re-run via the Deploy Database Migrations workflow
-- (CREATE OR REPLACE FUNCTION).

CREATE OR REPLACE FUNCTION public.merge_caregiver_tasks(
  p_caregiver_id text,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE caregivers
     SET tasks = COALESCE(tasks, '{}'::jsonb) || COALESCE(p_patch, '{}'::jsonb)
   WHERE id = p_caregiver_id
  RETURNING tasks;
$$;

REVOKE ALL ON FUNCTION public.merge_caregiver_tasks(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_caregiver_tasks(text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.merge_caregiver_tasks(text, jsonb) IS
  'Atomically merge a JSONB patch into caregivers.tasks for a single caregiver. '
  'Use instead of read-modify-write to avoid lost-update races. Runs with '
  'caller permissions (SECURITY INVOKER) so RLS on caregivers governs access. '
  'Frontend: src/lib/storage.js mergeCaregiverTasks. '
  'Edge function: supabase/functions/execute-automation complete_task action.';
