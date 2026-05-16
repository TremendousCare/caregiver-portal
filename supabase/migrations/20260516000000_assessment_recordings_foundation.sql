-- Assessment recording workflow — foundational schema.
--
-- See docs/ASSESSMENT_RECORDING.md for the full design contract this
-- implements. This migration is PR 1 of v1: schema only. No edge
-- functions, no UI, no behavior change for anyone today (the feature
-- flag is OFF by default and the UI to consume these tables ships in
-- later PRs).
--
-- Five additive, idempotent changes:
--
-- 1) public.assessment_recordings — one row per recording session.
--    Owns the audio file's storage path, consent metadata, and the
--    pipeline status state machine
--    (recording → uploaded → transcribing → extracting →
--    awaiting_review → published | failed).
--
-- 2) public.assessment_transcripts — one row per recording, holds the
--    diarized + timestamped transcript plus the raw provider response
--    (so we can re-extract against a new prompt or new schema later
--    without re-billing for transcription).
--
-- 3) Three additive columns on public.care_plan_versions:
--      source_recording_id    FK to assessment_recordings (ON DELETE
--                             SET NULL — audio retention rules must
--                             never cascade-delete a published care
--                             plan version).
--      field_citations        jsonb: per-field {startMs,endMs,quote,
--                             speaker,confidence} for every field
--                             the AI proposed. Preserves the audit
--                             trail past initial review.
--      narrative_paragraph    text: the post-approval paragraph
--                             version. Distinct from
--                             generated_summary (which is the
--                             caregiver-facing snapshot from
--                             care-plan-snapshot).
--
-- 4) Private Supabase Storage bucket `assessment-recordings`. Path
--    convention:
--        <org_id>/<client_id>/<recording_id>/audio.<ext>
--    First path segment = org_id, which is what the RLS policies on
--    storage.objects key off. Same precedent as profile-pictures
--    (20260514150000) and email-attachments (20260515000000).
--
-- 5) Feature flag in organizations.settings:
--      assessments.recording_enabled: bool (default false)
--      assessments.require_baa:       bool (default false)
--      assessments.providers:         {transcription: 'deepgram',
--                                      llm: 'anthropic'}
--      assessments.retention_audio_days: int (default 90)
--    Tremendous Care row gets recording_enabled=true at the end so
--    the dogfooders can use the feature once UI ships.
--
-- Tenancy: every new table carries org_id NOT NULL DEFAULT
-- public.default_org_id() per Phase B Prime Directive #2
-- (CLAUDE.md / docs/SAAS_RETROFIT.md). RLS policy naming follows the
-- email_attachment_files convention: <table>_<role>_<verb>, single
-- predicate combining role gate (is_staff/is_admin) with org match.
-- Caregiver-PWA sessions are denied because is_staff() returns false
-- for them.
--
-- Rollback: _rollback/20260516000000_assessment_recordings_foundation_down.sql

-- ── 1. assessment_recordings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_recordings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL DEFAULT public.default_org_id()
                             REFERENCES public.organizations(id),
  client_id                uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- Free-text user identifier, matches events.actor convention
  -- (e.g. 'user:Jessica'). Not an FK because user identity lives
  -- across auth.users + user_roles + caregivers.user_id and we want
  -- a single stable string here.
  recorded_by              text NOT NULL,
  recorded_by_role         text CHECK (recorded_by_role IS NULL
                                       OR recorded_by_role IN ('bd_rep', 'care_coordinator')),
  started_at               timestamptz NOT NULL DEFAULT now(),
  ended_at                 timestamptz,
  -- Storage key relative to the assessment-recordings bucket. NULL
  -- while the upload is still streaming from the iPad.
  audio_path               text,
  audio_duration_seconds   integer CHECK (audio_duration_seconds IS NULL OR audio_duration_seconds >= 0),
  -- Verbal consent capture is verified by the transcription step
  -- inspecting the first ~15s of audio. True once the consent
  -- segment is confirmed; false until then. The signed_* fields
  -- are populated by the in-app checkbox the BD rep checks before
  -- recording starts (California two-party consent posture).
  consent_verbal_captured  boolean NOT NULL DEFAULT false,
  consent_signed_at        timestamptz,
  consent_signed_by        text,
  status                   text NOT NULL DEFAULT 'recording'
                             CHECK (status IN (
                               'recording', 'uploaded', 'transcribing',
                               'extracting', 'awaiting_review', 'published',
                               'failed'
                             )),
  failure_reason           text,
  -- 'standard' (current default, non-BAA vendor routing OK) or
  -- 'baa_protected' (post-BAA, edge functions refuse to route to a
  -- non-BAA-eligible provider). See docs/ASSESSMENT_RECORDING.md
  -- → "BAA swap procedure" for how this flag is flipped per org.
  phi_status               text NOT NULL DEFAULT 'standard'
                             CHECK (phi_status IN ('standard', 'baa_protected')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_recordings_org_client
  ON public.assessment_recordings (org_id, client_id);

CREATE INDEX IF NOT EXISTS idx_assessment_recordings_org_status
  ON public.assessment_recordings (org_id, status);

-- "What needs review right now?" — the Care Coordinator's home-screen
-- query. Partial index keeps it tiny (most recordings spend <30 mins
-- in awaiting_review before they're reviewed and published).
CREATE INDEX IF NOT EXISTS idx_assessment_recordings_org_awaiting_review
  ON public.assessment_recordings (org_id, started_at DESC)
  WHERE status = 'awaiting_review';

ALTER TABLE public.assessment_recordings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_recordings'
      AND policyname = 'assessment_recordings_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_read"
        ON public.assessment_recordings FOR SELECT
        TO authenticated
        USING (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_recordings'
      AND policyname = 'assessment_recordings_staff_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_insert"
        ON public.assessment_recordings FOR INSERT
        TO authenticated
        WITH CHECK (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_recordings'
      AND policyname = 'assessment_recordings_staff_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_update"
        ON public.assessment_recordings FOR UPDATE
        TO authenticated
        USING (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        )
        WITH CHECK (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  -- DELETE is admin-only because manual deletion of a recording is
  -- unusual and irreversible (the audio object is also removed by the
  -- retention pipeline). Routine 90-day retention runs as service_role.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_recordings'
      AND policyname = 'assessment_recordings_admin_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_admin_delete"
        ON public.assessment_recordings FOR DELETE
        TO authenticated
        USING (
          public.is_admin()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_recordings'
      AND policyname = 'assessment_recordings_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_service_role"
        ON public.assessment_recordings FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    $POL$;
  END IF;
END $$;


-- ── 2. assessment_transcripts ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_transcripts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL DEFAULT public.default_org_id()
                            REFERENCES public.organizations(id),
  recording_id            uuid NOT NULL UNIQUE
                            REFERENCES public.assessment_recordings(id) ON DELETE CASCADE,
  -- Which provider produced this transcript. Lets us A/B providers
  -- without losing attribution and lets the analyzer compute per-
  -- provider accuracy from Care Coordinator edits later.
  provider                text NOT NULL,
  provider_model          text,
  -- Plain-text concatenation for full-text search and prompt
  -- assembly. The structured truth is in `segments`.
  transcript_text         text,
  -- Array of {startMs, endMs, speaker, text, confidence}.
  segments                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Diarization label map, e.g. {"0":"BD rep","1":"Client","2":"Daughter"}.
  -- Care Coordinator can re-label in the review UI; updates propagate
  -- to any field citations referencing the changed speaker code.
  speakers                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Full provider response for debugging and re-extraction against a
  -- newer prompt without re-paying for transcription. Indexed at
  -- query time, not on disk.
  provider_response_raw   jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_transcripts_org_recording
  ON public.assessment_transcripts (org_id, recording_id);

ALTER TABLE public.assessment_transcripts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Staff read only. Writes happen exclusively from the
  -- assessment-transcribe edge function under service_role, so we
  -- don't need an INSERT/UPDATE policy for `authenticated`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_transcripts'
      AND policyname = 'assessment_transcripts_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_transcripts_staff_read"
        ON public.assessment_transcripts FOR SELECT
        TO authenticated
        USING (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  -- Admin-only UPDATE for the rare manual fix-up case (e.g. correct
  -- a speaker label set wrong by the AI). Routine speaker re-labels
  -- from the review UI go through service_role via an RPC, not a
  -- direct UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_transcripts'
      AND policyname = 'assessment_transcripts_admin_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_transcripts_admin_update"
        ON public.assessment_transcripts FOR UPDATE
        TO authenticated
        USING (
          public.is_admin()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        )
        WITH CHECK (
          public.is_admin()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'assessment_transcripts'
      AND policyname = 'assessment_transcripts_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_transcripts_service_role"
        ON public.assessment_transcripts FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    $POL$;
  END IF;
END $$;


-- ── 3. care_plan_versions — additive columns ─────────────────────
-- All three are nullable. Existing rows and existing code paths are
-- unaffected. ON DELETE SET NULL on source_recording_id means audio
-- retention can wipe the recording row without taking a published
-- care plan version down with it.

ALTER TABLE public.care_plan_versions
  ADD COLUMN IF NOT EXISTS source_recording_id uuid
    REFERENCES public.assessment_recordings(id) ON DELETE SET NULL;

ALTER TABLE public.care_plan_versions
  ADD COLUMN IF NOT EXISTS field_citations jsonb;

ALTER TABLE public.care_plan_versions
  ADD COLUMN IF NOT EXISTS narrative_paragraph text;

-- Lookup: "show me every care plan version that originated from
-- this recording" — used by the audit/replay view and by the rare
-- re-extraction flow.
CREATE INDEX IF NOT EXISTS idx_care_plan_versions_source_recording
  ON public.care_plan_versions (source_recording_id)
  WHERE source_recording_id IS NOT NULL;


-- ── 4. Storage bucket + RLS ──────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('assessment-recordings', 'assessment-recordings', false)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  -- Staff read (for the signed-URL playback on the review screen).
  -- Caregivers using the PWA cannot read because is_staff() = false.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_recordings_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_read"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = 'assessment-recordings'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff insert — the iPad recorder uploads chunks during the
  -- visit. BD rep + Care Coordinator are both staff.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_recordings_staff_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
          bucket_id = 'assessment-recordings'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff update — resumable-upload chunks update the object as
  -- they arrive. Same gates as insert.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_recordings_staff_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_staff_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
          bucket_id = 'assessment-recordings'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        )
        WITH CHECK (
          bucket_id = 'assessment-recordings'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Admin-only delete on the storage object. Routine retention
  -- deletions go through service_role (the cron job).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_recordings_admin_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_admin_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
          bucket_id = 'assessment-recordings'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Service role full access (edge functions: transcribe, extract,
  -- narrate, retention cron).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_recordings_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_recordings_service_role"
        ON storage.objects FOR ALL
        TO service_role
        USING (bucket_id = 'assessment-recordings')
        WITH CHECK (bucket_id = 'assessment-recordings');
    $POL$;
  END IF;
END $$;


-- ── 5. Feature flag seed ─────────────────────────────────────────
-- Tremendous Care gets recording_enabled=true so the dogfooders can
-- light up the workflow the moment the UI ships. Every other org
-- (none today, plural in the future) defaults to false and must opt
-- in via Settings — there is no path by which a new org accidentally
-- enables recording.
--
-- Provider defaults match docs/ASSESSMENT_RECORDING.md v1 lock:
-- Deepgram pay-as-you-go + direct Anthropic API.
--
-- Retention default of 90 days for audio matches the doc; transcripts
-- are retained indefinitely so we don't need a key for that.
--
-- Idempotent: jsonb-merge overwrites the assessments subtree with the
-- canonical values without disturbing any other settings keys.

UPDATE public.organizations
SET settings = settings
  || jsonb_build_object(
       'assessments',
       COALESCE(settings -> 'assessments', '{}'::jsonb)
         || jsonb_build_object(
              'recording_enabled',     true,
              'require_baa',           false,
              'retention_audio_days',  90,
              'providers',             jsonb_build_object(
                                         'transcription', 'deepgram',
                                         'llm',           'anthropic'
                                       )
            )
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';
