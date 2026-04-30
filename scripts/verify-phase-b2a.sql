-- Phase B2a — post-deploy verification.
--
-- Run this in the Supabase Dashboard SQL editor against production after
-- the Deploy Database Migrations workflow completes. Each query should
-- return zero rows (or the literal value documented inline). If anything
-- comes back surprising, do not advance to PR B2b.

-- ── 1. Every active auth.users row has a membership ──────────────────────
-- Expected: zero rows.
SELECT u.id, u.email, u.created_at
FROM auth.users u
WHERE u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.org_memberships m WHERE m.user_id = u.id
  );

-- ── 2. The auto-membership trigger is installed and active ──────────────
-- Expected: exactly one row, tgenabled = 'O' (origin / enabled).
SELECT t.tgname, t.tgenabled, p.proname
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgname = 'on_auth_user_created_membership';

-- ── 3. The trigger function is SECURITY DEFINER with a locked search_path
-- Expected: prosecdef = true; proconfig contains 'search_path=public, pg_temp'.
SELECT proname, prosecdef, proconfig
FROM pg_proc
WHERE proname = 'handle_new_user_membership'
  AND pronamespace = 'public'::regnamespace;

-- ── 4. supabase_auth_admin can EXECUTE the trigger function ──────────────
-- Expected: returns true.
SELECT has_function_privilege(
  'supabase_auth_admin',
  'public.handle_new_user_membership()',
  'EXECUTE'
);

-- ── 5. Membership distribution sanity check ──────────────────────────────
-- Expected: counts per role roughly match user_roles + caregivers totals.
-- If any 'caregiver'-role membership corresponds to an email that *should*
-- be staff (e.g., a tremendouscareca.com domain that didn't make it into
-- user_roles before signup), reclassify it manually:
--   UPDATE public.org_memberships
--      SET role = 'admin'   -- or 'member'
--    WHERE user_id = '<uuid>';
SELECT m.role, count(*) AS member_count
FROM public.org_memberships m
GROUP BY m.role
ORDER BY m.role;

-- ── 6. Smoke test the trigger by walking the four orphans ────────────────
-- Each of these emails was orphaned before B2a; confirm they now have a
-- membership row.
SELECT u.email, m.role, m.created_at
FROM auth.users u
LEFT JOIN public.org_memberships m ON m.user_id = u.id
WHERE u.email IN (
  'tremendouscareca@gmail.com',
  'blertadevole@gmail.com',
  'nashkevi1@yahoo.com',
  'juliana.gurule@tremendouscareca.com'
)
ORDER BY u.email;
