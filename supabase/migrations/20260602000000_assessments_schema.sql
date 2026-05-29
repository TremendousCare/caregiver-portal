-- ─────────────────────────────────────────────────────────────────
-- In-Home Assessment capture + transcription — schema foundation (PR 1)
--
-- Adds the data model for recording/uploading an in-home assessment
-- visit, storing the audio as a retained clinical record, and holding
-- the Deepgram diarized transcript. This migration is PURE SCHEMA —
-- no edge functions, no behavior. The transcription engine
-- (assessment-transcribe + deepgram-callback) lands in PR 2, and the
-- AI care-plan extraction in PR 4.
--
-- Tenancy: both tables get `org_id NOT NULL DEFAULT public.default_org_id()`
-- per the SaaS retrofit prime directive (every new table is org-scoped).
-- RLS combines the modern `tenant_isolation_<table>_<command>` org-scoped
-- predicate with `public.is_staff()` gating — an assessment is a shared
-- clinical record any staff member may review, not personal-private data.
--
-- Audio bucket `assessment-audio` mirrors the `email-attachments` bucket:
-- private, org-scoped via the `<org_id>/...` path prefix, signed-URL reads.
-- Upload convention: `<org_id>/<assessment_id>.<ext>`.
--
-- Idempotent + additive: IF NOT EXISTS everywhere, DROP/CREATE for table
-- policies, guarded DO blocks for storage policies. Safe to re-run under
-- the Deploy Database Migrations workflow (`supabase db push --include-all`).
-- No DROPs, no DELETEs. Rollback plan: drop the two tables, the bucket
-- policies, and the bucket (only safe before any audio is uploaded).
-- ─────────────────────────────────────────────────────────────────

-- ── 1. assessments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant.
  org_id            uuid NOT NULL DEFAULT public.default_org_id()
                      REFERENCES organizations(id) ON DELETE RESTRICT,

  -- The client (or new-lead client row) this assessment is for. Nullable
  -- and ON DELETE SET NULL so the assessment survives as a clinical record
  -- even if the client row is later removed. `clients.id` is text.
  client_id         text REFERENCES clients(id) ON DELETE SET NULL,

  -- Lifecycle. recording → uploaded → transcribing → transcribed; failed
  -- is terminal-with-retry (the engine in PR 2 can re-submit).
  status            text NOT NULL DEFAULT 'recording'
                      CHECK (status IN (
                        'recording', 'uploaded', 'transcribing',
                        'transcribed', 'failed'
                      )),

  -- Audio object in the `assessment-audio` bucket: `<org_id>/<id>.<ext>`.
  audio_path        text,
  audio_mime        text,
  duration_seconds  integer,

  -- Populated when status = 'failed' so the UI can show why + offer retry.
  error_message     text,

  -- When the visit audio was actually captured (may differ from created_at
  -- for uploaded-after-the-fact recordings).
  recorded_at       timestamptz,

  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Tenant-isolation index (required for org-scoped RLS) + primary listing.
CREATE INDEX IF NOT EXISTS idx_assessments_org
  ON public.assessments (org_id);
CREATE INDEX IF NOT EXISTS idx_assessments_org_client
  ON public.assessments (org_id, client_id);

-- Reconciliation index for the safety-net cron (PR 2): cheaply find rows
-- stuck mid-flight whose Deepgram callback may have been lost.
CREATE INDEX IF NOT EXISTS idx_assessments_in_flight
  ON public.assessments (org_id, updated_at)
  WHERE status IN ('uploaded', 'transcribing');

-- ── 2. assessment_transcriptions ──────────────────────────────────
-- One transcription per assessment (UNIQUE assessment_id). transcript is
-- the flat readable text; transcript_json holds Deepgram's diarized
-- utterances (speaker turns + word timings) for the turn-by-turn viewer.
CREATE TABLE IF NOT EXISTS public.assessment_transcriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  org_id            uuid NOT NULL DEFAULT public.default_org_id()
                      REFERENCES organizations(id) ON DELETE RESTRICT,

  assessment_id     uuid NOT NULL REFERENCES public.assessments(id)
                      ON DELETE CASCADE,

  transcript        text,
  transcript_json   jsonb,

  provider          text NOT NULL DEFAULT 'deepgram',
  model             text,
  language          text,
  confidence        numeric,
  dg_request_id     text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (assessment_id)
);

CREATE INDEX IF NOT EXISTS idx_assessment_transcriptions_org
  ON public.assessment_transcriptions (org_id);

-- ── 3. updated_at triggers ────────────────────────────────────────
DROP TRIGGER IF EXISTS assessments_touch_updated_at ON public.assessments;
CREATE TRIGGER assessments_touch_updated_at
  BEFORE UPDATE ON public.assessments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS assessment_transcriptions_touch_updated_at
  ON public.assessment_transcriptions;
CREATE TRIGGER assessment_transcriptions_touch_updated_at
  BEFORE UPDATE ON public.assessment_transcriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 4. RLS: assessments ───────────────────────────────────────────
ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_assessments_select" ON public.assessments;
CREATE POLICY "tenant_isolation_assessments_select"
  ON public.assessments FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "tenant_isolation_assessments_insert" ON public.assessments;
CREATE POLICY "tenant_isolation_assessments_insert"
  ON public.assessments FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "tenant_isolation_assessments_update" ON public.assessments;
CREATE POLICY "tenant_isolation_assessments_update"
  ON public.assessments FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  )
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

-- DELETE is admin-only: these are retained clinical records, so removal is
-- a deliberate administrative act, not a daily-use action.
DROP POLICY IF EXISTS "tenant_isolation_assessments_delete" ON public.assessments;
CREATE POLICY "tenant_isolation_assessments_delete"
  ON public.assessments FOR DELETE
  TO authenticated
  USING (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

-- Service-role bypass — the transcription edge functions (PR 2) write
-- status + transcription rows with the service-role key.
DROP POLICY IF EXISTS "service_role_full_access_assessments" ON public.assessments;
CREATE POLICY "service_role_full_access_assessments"
  ON public.assessments FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 5. RLS: assessment_transcriptions ─────────────────────────────
ALTER TABLE public.assessment_transcriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_assessment_transcriptions_select"
  ON public.assessment_transcriptions;
CREATE POLICY "tenant_isolation_assessment_transcriptions_select"
  ON public.assessment_transcriptions FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "tenant_isolation_assessment_transcriptions_insert"
  ON public.assessment_transcriptions;
CREATE POLICY "tenant_isolation_assessment_transcriptions_insert"
  ON public.assessment_transcriptions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "tenant_isolation_assessment_transcriptions_update"
  ON public.assessment_transcriptions;
CREATE POLICY "tenant_isolation_assessment_transcriptions_update"
  ON public.assessment_transcriptions FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  )
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "tenant_isolation_assessment_transcriptions_delete"
  ON public.assessment_transcriptions;
CREATE POLICY "tenant_isolation_assessment_transcriptions_delete"
  ON public.assessment_transcriptions FOR DELETE
  TO authenticated
  USING (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

DROP POLICY IF EXISTS "service_role_full_access_assessment_transcriptions"
  ON public.assessment_transcriptions;
CREATE POLICY "service_role_full_access_assessment_transcriptions"
  ON public.assessment_transcriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 6. Storage bucket: assessment-audio ───────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('assessment-audio', 'assessment-audio', false)
ON CONFLICT (id) DO NOTHING;

-- RLS on storage.objects for this bucket. Path-prefix match between the
-- object's first folder segment and the caller's JWT org_id claim, same
-- mechanism as `email-attachments` (20260515000000). Upload convention:
-- `<org_id>/<assessment_id>.<ext>`.
DO $$
BEGIN
  -- Staff read so the recorder/review UI can mint signed URLs to play back
  -- the audio. Cross-org reads blocked by the path-prefix check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_audio_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_audio_staff_read"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = 'assessment-audio'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Staff INSERT: recording/uploading an assessment is a daily-use action
  -- for care coordinators, so this is staff-level (unlike the admin-only
  -- email-attachments library). Path-prefix check prevents writing into
  -- another org's folder.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_audio_staff_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_audio_staff_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
          bucket_id = 'assessment-audio'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Admin-only UPDATE/DELETE — audio is a retained clinical record.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_audio_admin_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_audio_admin_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
          bucket_id = 'assessment-audio'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        )
        WITH CHECK (
          bucket_id = 'assessment-audio'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_audio_admin_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_audio_admin_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
          bucket_id = 'assessment-audio'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Service role full access — the transcription edge functions download
  -- the audio (signed URL minted with the service-role key) to hand to
  -- Deepgram, and may clean up on hard failure.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'assessment_audio_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "assessment_audio_service_role"
        ON storage.objects FOR ALL
        TO service_role
        USING (bucket_id = 'assessment-audio')
        WITH CHECK (bucket_id = 'assessment-audio');
    $POL$;
  END IF;
END $$;
