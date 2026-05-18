-- Rollback for 20260518010000_seed_amy_dutton_communication_setup.sql
--
-- Reverses the three writes from the seed:
--   1. Clears Amy's user_roles row.
--   2. Soft-archives her team_members row (is_active = false) — we do
--      not DELETE per the production-safety policy (no DELETE on rows
--      in dev work).
--   3. Clears her org_memberships.ringcentral_extension_id and resets
--      her role to the trigger's default of 'caregiver' so the state
--      matches a pre-seed environment.

DELETE FROM public.user_roles
 WHERE email = 'amy.dutton@tremendouscareca.com'
   AND updated_by = 'migration:20260518010000_seed_amy_dutton';

UPDATE public.team_members
   SET is_active = false,
       updated_at = NOW(),
       updated_by = 'rollback:20260518010000_seed_amy_dutton'
 WHERE email = 'amy.dutton@tremendouscareca.com';

DO $$
DECLARE
  v_user_id uuid := '9228e867-30ca-4294-985b-871a994cc5fc';
  v_org_id  uuid;
BEGIN
  v_org_id := public.default_org_id();
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.org_memberships
     SET ringcentral_extension_id = NULL,
         role = 'caregiver'
   WHERE org_id  = v_org_id
     AND user_id = v_user_id;
END $$;
