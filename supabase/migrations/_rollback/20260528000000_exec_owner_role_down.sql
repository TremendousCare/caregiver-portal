-- Rollback for exec_owner_role.
--
-- Reverts the role tier expansion. Owners are downgraded back to
-- 'admin' so they keep portal access — they just lose the exec
-- module. The is_owner() function is dropped.
--
-- ⚠️  Do NOT run while the exec_* tables still exist with policies
--     that reference public.is_owner(). Drop the exec tables first
--     (run their rollbacks in reverse order) or those policies will
--     start erroring on every authenticated query.

-- 1. Demote owners back to admin (before tightening the CHECK)
UPDATE public.user_roles
   SET role = 'admin',
       updated_at = now(),
       updated_by = 'migration:exec_owner_role:rollback'
 WHERE role = 'owner';

UPDATE public.org_memberships
   SET role = 'admin'
 WHERE role = 'owner';

-- 2. Drop the helper
DROP FUNCTION IF EXISTS public.is_owner();

-- 3. Restore the original is_admin() (admin only, no owner)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role = 'admin'
  );
$$;

-- 4. Restore the original is_staff() (admin/member, no owner)
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role IN ('admin', 'member')
  );
$$;

-- 5. Tighten the CHECK constraints back to the original enum
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('admin', 'member'));

ALTER TABLE public.org_memberships
  DROP CONSTRAINT IF EXISTS org_memberships_role_check;
ALTER TABLE public.org_memberships
  ADD CONSTRAINT org_memberships_role_check
  CHECK (role IN ('admin', 'member', 'caregiver'));
