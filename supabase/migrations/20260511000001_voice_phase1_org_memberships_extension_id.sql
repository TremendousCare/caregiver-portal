-- Voice / CTI Phase 1 — per-user RingCentral extension mapping.
--
-- Adds a single nullable column on org_memberships so an admin can
-- bind a portal user to their RingCentral extension. When the
-- Telephony Sessions webhook fires for an inbound call, the
-- handler looks up extension_id -> user_id here and broadcasts the
-- screen-pop event to that user's Realtime channel.
--
-- WHY ON org_memberships AND NOT auth.users:
--   This is a per-(org, user) attribute. The same auth.users.id
--   could be a member of two orgs (post-Phase E) with different
--   RC extensions in each org's RC account. Mapping lives on the
--   membership row, not the user.
--
-- WHY NULLABLE:
--   Caregiver memberships (role = 'caregiver') don't have RC
--   extensions — they aren't using the back-office portal to take
--   calls. Staff (admin/member) get extensions populated by an
--   admin via the UI we'll build in PR 3. NULL until set.
--
-- ROLLBACK: supabase/migrations/_rollback/20260511000001_*_down.sql

ALTER TABLE public.org_memberships
  ADD COLUMN IF NOT EXISTS ringcentral_extension_id text;

-- Used by the telephony webhook handler to resolve extension -> user.
-- Partial index keeps it small (caregivers have NULL extensions).
CREATE INDEX IF NOT EXISTS idx_org_memberships_rc_extension
  ON public.org_memberships (ringcentral_extension_id)
  WHERE ringcentral_extension_id IS NOT NULL;

-- An extension belongs to at most one (org, user) pair. Without this
-- constraint, an admin could accidentally double-bind an extension
-- and the screen-pop would fire for the wrong user.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_memberships_rc_extension_per_org
  ON public.org_memberships (org_id, ringcentral_extension_id)
  WHERE ringcentral_extension_id IS NOT NULL;

-- Sanity check.
DO $$
DECLARE
  v_column_exists boolean;
  v_index_exists  boolean;
  v_unique_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'org_memberships'
      AND column_name  = 'ringcentral_extension_id'
  ) INTO v_column_exists;

  IF NOT v_column_exists THEN
    RAISE EXCEPTION 'org_memberships.ringcentral_extension_id missing after migration';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'org_memberships'
      AND indexname  = 'idx_org_memberships_rc_extension'
  ) INTO v_index_exists;

  IF NOT v_index_exists THEN
    RAISE EXCEPTION 'idx_org_memberships_rc_extension missing after migration';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'org_memberships'
      AND indexname  = 'uniq_org_memberships_rc_extension_per_org'
  ) INTO v_unique_exists;

  IF NOT v_unique_exists THEN
    RAISE EXCEPTION
      'uniq_org_memberships_rc_extension_per_org missing after migration';
  END IF;
END
$$;
