-- Rollback for the profile-pictures migration.
--
-- This file lives outside the main migrations folder (underscored
-- directory) so it is NOT auto-applied. Run manually via psql only
-- if the forward migration must be reverted.
--
-- Order: policies → bucket → columns. Objects in the bucket are
-- deleted first because storage.objects has FK to storage.buckets.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260514150000_profile_pictures_down.sql

BEGIN;

-- Drop RLS policies on storage.objects scoped to this bucket
DROP POLICY IF EXISTS "profile_pictures_tenant_read"   ON storage.objects;
DROP POLICY IF EXISTS "profile_pictures_staff_insert"  ON storage.objects;
DROP POLICY IF EXISTS "profile_pictures_staff_update"  ON storage.objects;
DROP POLICY IF EXISTS "profile_pictures_staff_delete"  ON storage.objects;
DROP POLICY IF EXISTS "profile_pictures_service_role"  ON storage.objects;

-- Delete any objects in the bucket, then drop the bucket itself
DELETE FROM storage.objects WHERE bucket_id = 'profile-pictures';
DELETE FROM storage.buckets WHERE id = 'profile-pictures';

-- Drop the columns last
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS avatar_path;
ALTER TABLE public.clients    DROP COLUMN IF EXISTS avatar_path;

COMMIT;
