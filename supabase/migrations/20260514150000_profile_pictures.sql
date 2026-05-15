-- Profile pictures for caregivers and clients.
--
-- Three additive, idempotent changes:
--
-- 1) `caregivers.avatar_path` (text, nullable) and `clients.avatar_path`
--    (text, nullable). Holds the object key (relative to the
--    `profile-pictures` bucket) of the most-recent uploaded avatar
--    for that entity. NULL = no photo (UI falls back to initials).
--
-- 2) Private Supabase Storage bucket `profile-pictures` for the raw
--    image files. Bucket is NOT public; the frontend always reads
--    via short-lived signed URLs minted from `createSignedUrl`. Path
--    convention inside the bucket is:
--
--        <org_id>/caregivers/<caregiver_id>/<uuid>.<ext>
--        <org_id>/clients/<client_id>/<uuid>.<ext>
--
--    The first path segment being `org_id` is what the RLS policies
--    below key off — same pattern as the `payroll-exports` bucket
--    (migration 20260428200000_payroll_phase_4_pr2.sql).
--
-- 3) Tenant-scoped RLS policies on `storage.objects` for this bucket.
--    Reads gated on authenticated AND JWT org_id matching the path
--    prefix. Writes additionally gated on `public.is_staff()` so
--    caregivers using the caregiver-PWA cannot mutate avatars.
--
-- Rollback: `_rollback/20260514150000_profile_pictures_down.sql`.

-- ── 1. Avatar path columns ────────────────────────────────────────
ALTER TABLE public.caregivers
  ADD COLUMN IF NOT EXISTS avatar_path text;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS avatar_path text;

-- ── 2. Storage bucket ─────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('profile-pictures', 'profile-pictures', false)
ON CONFLICT (id) DO NOTHING;

-- ── 3. RLS policies on storage.objects for this bucket ────────────
DO $$
BEGIN
  -- Authenticated read: any signed-in user whose JWT `org_id` matches
  -- the first folder segment of the object name can SELECT (and thus
  -- mint a signed URL for) the object. This is what gates avatar
  -- visibility across orgs once Phase B2 RLS is fully tightened.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_pictures_tenant_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "profile_pictures_tenant_read"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = 'profile-pictures'
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff-only write (INSERT). Caregivers reaching this bucket via
  -- the caregiver-PWA session cannot upload — `public.is_staff()`
  -- returns false for them. Org check is the same prefix match as
  -- the read policy.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_pictures_staff_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "profile_pictures_staff_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
          bucket_id = 'profile-pictures'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff-only UPDATE (rename / move / metadata change). Same gates.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_pictures_staff_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "profile_pictures_staff_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
          bucket_id = 'profile-pictures'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        )
        WITH CHECK (
          bucket_id = 'profile-pictures'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff-only DELETE so the "Remove photo" action and the
  -- replace-old-on-new flow can clean up orphan objects.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_pictures_staff_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "profile_pictures_staff_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
          bucket_id = 'profile-pictures'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Service role full access (edge functions, future bulk import, etc.)
  -- service_role bypasses RLS in Postgres but having the policy
  -- declared keeps intent visible.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'profile_pictures_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "profile_pictures_service_role"
        ON storage.objects FOR ALL
        TO service_role
        USING (bucket_id = 'profile-pictures')
        WITH CHECK (bucket_id = 'profile-pictures');
    $POL$;
  END IF;
END $$;
