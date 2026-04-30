-- Phase B2b — post-deploy verification.
--
-- Run this in the Supabase Dashboard SQL editor against production after
-- the Deploy Database Migrations workflow completes. Each query has its
-- expected output documented inline. If anything is unexpected, do not
-- advance to PR B3.
--
-- IMPORTANT: every WHERE clause that targets B2b policies uses the regex
--   polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
-- not a broader LIKE 'tenant_isolation\_%'. The narrower filter excludes
-- four pre-existing tenant_isolation_* policies that ship from the Paychex
-- payroll work (tenant_isolation_payroll_runs, tenant_isolation_timesheets,
-- tenant_isolation_timesheet_shifts, tenant_isolation_payroll_exports_read
-- on storage.objects). They are NOT B2b policies.

-- ── 1. Exactly 160 B2b policies exist ────────────────────────────────────
-- Expected: count = 160 (40 tables × 4 commands).
SELECT count(*) AS b2b_policy_count
FROM pg_policy
WHERE polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$';

-- ── 2. Every targeted table has all four policies ────────────────────────
-- Expected: zero rows. Any row returned means a table is missing one or more
-- of its four policies.
WITH targets AS (
  SELECT unnest(ARRAY[
    'caregivers','clients','caregiver_assignments','caregiver_documents',
    'document_upload_tokens','team_members','boards','board_cards',
    'shifts','shift_offers','caregiver_availability','clock_events',
    'care_plans','care_plan_versions','care_plan_tasks','care_plan_observations',
    'care_plan_digests','events','context_memory','context_snapshots',
    'action_outcomes','ai_suggestions','automation_rules','automation_log',
    'action_item_rules','client_sequences','client_sequence_enrollments',
    'client_sequence_log','inbound_sms_log','call_transcriptions',
    'message_templates','message_routing_queue','docusign_envelopes',
    'esign_envelopes','esign_templates','communication_routes',
    'survey_templates','survey_responses','system_metrics','autonomy_config'
  ]) AS table_name
)
SELECT
  t.table_name,
  count(p.polname) AS cmd_count,
  array_agg(p.polname ORDER BY p.polname) AS policy_names
FROM targets t
LEFT JOIN pg_policy p
  ON p.polrelid = ('public.'||t.table_name)::regclass
 AND p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
GROUP BY t.table_name
HAVING count(p.polname) <> 4
ORDER BY t.table_name;

-- ── 3. email_accounts and email_routing have NO B2b policies ─────────────
-- Expected: zero rows. Both intentionally skipped (service-role-only).
SELECT c.relname, p.polname
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relname IN ('email_accounts','email_routing')
  AND p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$';

-- ── 4. The strict predicate is in place ──────────────────────────────────
-- Expected: every using_clause matches the predicate text. Spot-check a few
-- tables. If you see a different predicate, do not advance.
SELECT
  c.relname AS table_name,
  p.polname,
  pg_get_expr(p.polqual,     p.polrelid) AS using_clause,
  pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_clause
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
  AND c.relname IN ('caregivers','shifts','events','communication_routes')
ORDER BY c.relname, p.polname;

-- ── 5. Pre-existing policies are still in place (B2b must not have
-- touched them) ──────────────────────────────────────────────────────────
-- Expected: caregivers still has caregivers_staff_all, caregivers_read_own,
-- service_role_full_access_caregivers. shifts still has shifts_staff_all
-- and shifts_read_own. If any of these are missing, ROLL BACK B2b.
SELECT c.relname, p.polname
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE c.relname IN ('caregivers','shifts','clients','events')
  AND p.polname !~ '^tenant_isolation_.*_(select|insert|update|delete)$'
ORDER BY c.relname, p.polname;

-- ── 6. The new policies are permissive (not restrictive) ────────────────
-- Expected: restrictive_count = 0. A restrictive policy would AND with
-- existing policies and lock users out.
SELECT count(*) FILTER (WHERE polpermissive = false) AS restrictive_count
FROM pg_policy
WHERE polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$';

-- ── 7. The Paychex tenant_isolation_* policies are still present ─────────
-- Expected: 4 rows — the broader LIKE filter (which would have dropped these)
-- has been correctly excluded by the suffix-anchored regex.
SELECT c.relname, p.polname
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
WHERE p.polname LIKE 'tenant_isolation\_%' ESCAPE '\'
  AND p.polname !~ '^tenant_isolation_.*_(select|insert|update|delete)$'
ORDER BY c.relname, p.polname;

-- ── 8. Browser-side smoke test ──────────────────────────────────────────
-- The SQL editor runs as service_role which bypasses RLS, so it cannot
-- exercise the new policy paths. Run the following from the application
-- (browser console while logged in as a staff user):
--
--   const { data, error } = await supabase.from('caregivers').select('id').limit(1);
--   console.log({ data, error });
--
-- Expected: data has 1 row, no error.
