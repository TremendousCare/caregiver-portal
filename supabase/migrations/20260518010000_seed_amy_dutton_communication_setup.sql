-- Seed Amy Dutton's communication setup (email, RC extension, directory).
--
-- Amy Dutton is a new Business Development Representative. Her auth.users
-- account has been provisioned manually (login: amy.dutton@tremendouscareca.com,
-- auth.uid = 9228e867-30ca-4294-985b-871a994cc5fc — same UUID already
-- referenced by 20260513140100_bd_seed_amy_south_oc_territory.sql).
--
-- The new-user trigger installed in 20260501000000_phase_b2a_membership_integrity.sql
-- looked up user_roles by email when her account was created and, finding
-- no row, defaulted her org_memberships.role to 'caregiver'. This seed
-- corrects that to 'member' and connects her to the three things she
-- needs for the BD portal, calling, texting, and email features to
-- behave the same as every other staff user:
--
--   1. user_roles
--      • role = 'member' (gates public.is_staff() — passes for any
--        admin/member, opens BD/staff RLS, and lets the existing
--        outgoing-mailbox resolver pick her own mailbox).
--      • mailbox_email = her own address (Microsoft Graph send/receive
--        runs against this mailbox per 20260420020000_multi_user_outlook.sql).
--
--   2. team_members
--      • Directory entry surfaced in AdminSettings → Team Members. Stores
--        her display name, job title, and personal/work phone for org-wide
--        visibility. No outbound SMS routing happens off this column —
--        SMS still flows through communication_routes — but the row is
--        what surfaces "Amy Dutton" in pickers and the directory list.
--
--   3. org_memberships
--      • ringcentral_extension_id = her RC extension ID. This is the only
--        per-user wire the call-side webhook reads to resolve an inbound
--        RingCentral Telephony Sessions event → user → Realtime screen-pop
--        channel (see supabase/functions/ringcentral-telephony-webhook/
--        index.ts resolveExtensionUser()).
--      • role bumped from the default 'caregiver' to 'member' so the
--        membership row matches her user_roles entry; harmless if it was
--        already 'member' (idempotent UPDATE).
--
-- The org-wide RingCentral JWT lives in communication_routes already, so
-- texting features need nothing per-user beyond the user_roles entry.
--
-- Idempotent everywhere (ON CONFLICT DO UPDATE on the inserts, plain
-- UPDATE on org_memberships), so this seed is safe to re-run.
-- Production safety: no DROP, no DELETE, only INSERT/UPDATE on three
-- rows scoped by primary key. Rollback at
-- _rollback/20260518010000_seed_amy_dutton_communication_setup_down.sql.
--
-- Renamed from 20260518000000 → 20260518010000 to avoid a version
-- collision with the unrelated consolidate_client_phases migration
-- that already claimed the 20260518000000 slot in
-- supabase_migrations.schema_migrations.

-- ── 1. user_roles ────────────────────────────────────────────────
INSERT INTO public.user_roles (email, role, mailbox_email, updated_by)
VALUES (
  'amy.dutton@tremendouscareca.com',
  'member',
  'amy.dutton@tremendouscareca.com',
  'migration:20260518010000_seed_amy_dutton'
)
ON CONFLICT (email) DO UPDATE
   SET role          = COALESCE(public.user_roles.role, EXCLUDED.role),
       mailbox_email = COALESCE(public.user_roles.mailbox_email, EXCLUDED.mailbox_email),
       updated_at    = NOW(),
       updated_by    = EXCLUDED.updated_by;

-- ── 2. team_members ──────────────────────────────────────────────
INSERT INTO public.team_members (
  email,
  display_name,
  job_title,
  personal_phone,
  org_id,
  is_active,
  updated_by
)
VALUES (
  'amy.dutton@tremendouscareca.com',
  'Amy Dutton',
  'Business Development Representative',
  '(949) 867-1046',
  public.default_org_id(),
  true,
  'migration:20260518010000_seed_amy_dutton'
)
ON CONFLICT (email) DO UPDATE
   SET display_name   = COALESCE(public.team_members.display_name, EXCLUDED.display_name),
       job_title      = COALESCE(public.team_members.job_title, EXCLUDED.job_title),
       personal_phone = COALESCE(public.team_members.personal_phone, EXCLUDED.personal_phone),
       org_id         = COALESCE(public.team_members.org_id, EXCLUDED.org_id),
       is_active      = true,
       updated_at     = NOW(),
       updated_by     = EXCLUDED.updated_by;

-- ── 3. org_memberships (extension + role bump) ───────────────────
-- Guarded by an auth.users existence check so fresh dev DBs that have
-- not yet provisioned Amy's auth row don't hard-fail this migration.
DO $$
DECLARE
  v_user_id uuid := '9228e867-30ca-4294-985b-871a994cc5fc';
  v_org_id  uuid;
BEGIN
  v_org_id := public.default_org_id();
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'default_org_id() returned NULL; skipping Amy membership update.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE NOTICE 'auth.users row for Amy (%) not found; skipping membership update.', v_user_id;
    RETURN;
  END IF;

  UPDATE public.org_memberships
     SET ringcentral_extension_id = '62957689016',
         role = 'member'
   WHERE org_id  = v_org_id
     AND user_id = v_user_id;
END $$;
