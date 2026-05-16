-- Rollback for the assessment_recordings_foundation migration.
--
-- Lives in the underscored _rollback directory so it is NOT
-- auto-applied. Run manually via psql only if the forward migration
-- must be reverted.
--
-- Order matters:
--   1. Drop storage.objects policies (cheap, isolated to one bucket).
--   2. Clear bucket objects → drop the bucket itself (FK from
--      storage.objects to storage.buckets blocks bucket drop while
--      objects remain).
--   3. Drop table policies on both new tables.
--   4. Drop care_plan_versions additive columns. Drops are safe
--      because nothing references them yet (no published version was
--      ever created from a recording before rollback).
--   5. Drop the two new tables. CASCADE on assessment_recordings is
--      unnecessary because we dropped the care_plan_versions
--      reference column already, and assessment_transcripts.recording_id
--      has its own ON DELETE CASCADE.
--   6. Strip the assessments subtree from organizations.settings on
--      Tremendous Care's row. Leaves the rest of settings untouched.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260516000000_assessment_recordings_foundation_down.sql

BEGIN;

-- 1. Drop storage.objects policies for this bucket
DROP POLICY IF EXISTS "assessment_recordings_staff_read"   ON storage.objects;
DROP POLICY IF EXISTS "assessment_recordings_staff_insert" ON storage.objects;
DROP POLICY IF EXISTS "assessment_recordings_staff_update" ON storage.objects;
DROP POLICY IF EXISTS "assessment_recordings_admin_delete" ON storage.objects;
DROP POLICY IF EXISTS "assessment_recordings_service_role" ON storage.objects;

-- 2. Clear bucket objects, then drop the bucket
DELETE FROM storage.objects WHERE bucket_id = 'assessment-recordings';
DELETE FROM storage.buckets WHERE id = 'assessment-recordings';

-- 3. Drop table policies
DROP POLICY IF EXISTS "assessment_recordings_staff_read"   ON public.assessment_recordings;
DROP POLICY IF EXISTS "assessment_recordings_staff_insert" ON public.assessment_recordings;
DROP POLICY IF EXISTS "assessment_recordings_staff_update" ON public.assessment_recordings;
DROP POLICY IF EXISTS "assessment_recordings_admin_delete" ON public.assessment_recordings;
DROP POLICY IF EXISTS "assessment_recordings_service_role" ON public.assessment_recordings;

DROP POLICY IF EXISTS "assessment_transcripts_staff_read"   ON public.assessment_transcripts;
DROP POLICY IF EXISTS "assessment_transcripts_admin_update" ON public.assessment_transcripts;
DROP POLICY IF EXISTS "assessment_transcripts_service_role" ON public.assessment_transcripts;

-- 4. Drop the additive columns on care_plan_versions
DROP INDEX IF EXISTS public.idx_care_plan_versions_source_recording;
ALTER TABLE public.care_plan_versions DROP COLUMN IF EXISTS source_recording_id;
ALTER TABLE public.care_plan_versions DROP COLUMN IF EXISTS field_citations;
ALTER TABLE public.care_plan_versions DROP COLUMN IF EXISTS narrative_paragraph;

-- 5. Drop the two new tables
DROP TABLE IF EXISTS public.assessment_transcripts;
DROP TABLE IF EXISTS public.assessment_recordings;

-- 6. Strip the assessments subtree from Tremendous Care's settings
UPDATE public.organizations
SET settings = settings - 'assessments',
    updated_at = now()
WHERE slug = 'tremendous-care';

COMMIT;
