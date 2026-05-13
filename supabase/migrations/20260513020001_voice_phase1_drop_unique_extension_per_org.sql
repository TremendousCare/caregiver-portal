-- Voice / CTI Phase 1 PR 3.4 — allow multiple users to bind to the
-- same RingCentral extension (on-call rotation).
--
-- PR 1 (20260511000001) added a unique partial index
-- `uniq_org_memberships_rc_extension_per_org` to prevent accidental
-- double-binding. The user's real workflow is the opposite: one
-- "main line" extension is shared by multiple staff who rotate
-- coverage (weekends, nights, on-call). Binding the same extension
-- to multiple users is the correct model and the unique index
-- blocks it.
--
-- Dropping the index is the right call. The per-membership index
-- `idx_org_memberships_rc_extension` (also from PR 1) is preserved
-- because the webhook handler's resolveExtensionUser lookup still
-- benefits from it.
--
-- Pairs with the frontend change in PR #319's VoiceContext: the
-- Realtime channel filter switches from
--   matched_user_id=eq.<self>   (one user, one extension)
-- to
--   extension_id=in.(<my_exts>) (any bound user sees the pop)
-- so that every staff member bound to the shared extension gets the
-- screen-pop concurrently. call_sessions.matched_user_id is still
-- written (used for "my recent calls" dashboards) but no longer
-- drives screen-pop visibility.
--
-- Rollback: see _rollback/20260513020001_*. Re-adding the unique
-- index after multiple bindings exist will fail; if that ever
-- happens, deduplicate first.

DROP INDEX IF EXISTS public.uniq_org_memberships_rc_extension_per_org;

-- Sanity check.
DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'org_memberships'
      AND indexname  = 'uniq_org_memberships_rc_extension_per_org'
  ) INTO v_exists;

  IF v_exists THEN
    RAISE EXCEPTION
      'uniq_org_memberships_rc_extension_per_org index still exists after DROP';
  END IF;
END
$$;
