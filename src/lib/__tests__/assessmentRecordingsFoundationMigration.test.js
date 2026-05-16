// Structural assertions on the assessment_recordings_foundation
// migration. This is PR 1 of the in-home assessment recording build
// (see docs/ASSESSMENT_RECORDING.md). The migration is schema-only —
// no behavior changes today — so a structural test is the right
// safety net: future hand-edits that drop a tenant predicate, soften
// the consent check constraint, or skip the storage path-prefix gate
// would be silent regressions in production but loud failures here.
//
// Mirrors the shape of emailAttachmentFilesMigration.test.js (the
// most recent storage-bucket-plus-RLS migration in the codebase).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260516000000_assessment_recordings_foundation.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260516000000_assessment_recordings_foundation_down.sql',
);

describe('assessment_recordings_foundation migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  // ── assessment_recordings table ──────────────────────────────
  describe('assessment_recordings table', () => {
    it('creates the table idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.assessment_recordings/);
    });

    it('carries org_id NOT NULL with default_org_id() default + FK to organizations (Prime Directive #2)', () => {
      expect(sql).toMatch(
        /org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s+REFERENCES public\.organizations\(id\)/,
      );
    });

    it('FK to clients cascades on client delete', () => {
      expect(sql).toMatch(/client_id\s+uuid NOT NULL REFERENCES public\.clients\(id\) ON DELETE CASCADE/);
    });

    it('records the recording-role enum and gates it via CHECK', () => {
      expect(sql).toMatch(/recorded_by_role\s+text CHECK[\s\S]*?'bd_rep'[\s\S]*?'care_coordinator'/);
    });

    it('status state machine covers every documented value (no expansion without doc update)', () => {
      const states = ['recording', 'uploaded', 'transcribing', 'extracting', 'awaiting_review', 'published', 'failed'];
      for (const state of states) {
        expect(sql).toMatch(new RegExp(`'${state}'`));
      }
      expect(sql).toMatch(/status\s+text NOT NULL DEFAULT 'recording'/);
    });

    it('phi_status is constrained to {standard, baa_protected} and defaults standard', () => {
      expect(sql).toMatch(/phi_status\s+text NOT NULL DEFAULT 'standard'/);
      expect(sql).toMatch(/phi_status IN \('standard', 'baa_protected'\)/);
    });

    it('consent capture columns exist (California two-party consent posture)', () => {
      expect(sql).toMatch(/consent_verbal_captured\s+boolean NOT NULL DEFAULT false/);
      expect(sql).toMatch(/consent_signed_at\s+timestamptz/);
      expect(sql).toMatch(/consent_signed_by\s+text/);
    });

    it('audio_duration_seconds rejects negatives', () => {
      expect(sql).toMatch(/audio_duration_seconds\s+integer CHECK[\s\S]*?>=\s*0/);
    });

    it('indexes the org+client and org+status lookups + partial index on awaiting_review', () => {
      expect(sql).toMatch(/idx_assessment_recordings_org_client[\s\S]*?\(org_id, client_id\)/);
      expect(sql).toMatch(/idx_assessment_recordings_org_status[\s\S]*?\(org_id, status\)/);
      expect(sql).toMatch(
        /idx_assessment_recordings_org_awaiting_review[\s\S]*?\(org_id, started_at DESC\)[\s\S]*?WHERE status = 'awaiting_review'/,
      );
    });

    it('enables RLS on the table', () => {
      expect(sql).toMatch(/ALTER TABLE public\.assessment_recordings ENABLE ROW LEVEL SECURITY/);
    });

    it('gates SELECT on is_staff() AND tenant org match', () => {
      expect(sql).toMatch(
        /assessment_recordings_staff_read[\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
      );
    });

    it('gates INSERT and UPDATE on is_staff() AND tenant org match (BD reps + Coordinators)', () => {
      expect(sql).toMatch(
        /assessment_recordings_staff_insert[\s\S]*?WITH CHECK\s*\([\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
      );
      expect(sql).toMatch(
        /assessment_recordings_staff_update[\s\S]*?USING\s*\([\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid[\s\S]*?WITH CHECK\s*\([\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
      );
    });

    it('gates DELETE on is_admin() (manual deletion is irreversible — admins only)', () => {
      expect(sql).toMatch(
        /assessment_recordings_admin_delete[\s\S]*?USING\s*\([\s\S]*?public\.is_admin\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
      );
    });

    it('grants service_role full access (edge function pipeline)', () => {
      expect(sql).toMatch(
        /assessment_recordings_service_role[\s\S]*?ON public\.assessment_recordings FOR ALL\s+TO service_role/,
      );
    });
  });

  // ── assessment_transcripts table ─────────────────────────────
  describe('assessment_transcripts table', () => {
    it('creates the table idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.assessment_transcripts/);
    });

    it('carries org_id NOT NULL with default_org_id() default + FK to organizations', () => {
      expect(sql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.assessment_transcripts[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s+REFERENCES public\.organizations\(id\)/,
      );
    });

    it('one-transcript-per-recording uniqueness on recording_id', () => {
      expect(sql).toMatch(
        /recording_id\s+uuid NOT NULL UNIQUE\s+REFERENCES public\.assessment_recordings\(id\) ON DELETE CASCADE/,
      );
    });

    it('stores segments + speakers + raw response for re-extraction without re-billing transcription', () => {
      expect(sql).toMatch(/segments\s+jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
      expect(sql).toMatch(/speakers\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
      expect(sql).toMatch(/provider_response_raw\s+jsonb/);
    });

    it('enables RLS', () => {
      expect(sql).toMatch(/ALTER TABLE public\.assessment_transcripts ENABLE ROW LEVEL SECURITY/);
    });

    it('staff read + admin update + service_role all-access; no authenticated INSERT path (writes only from edge function under service_role)', () => {
      expect(sql).toMatch(
        /assessment_transcripts_staff_read[\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif/,
      );
      expect(sql).toMatch(
        /assessment_transcripts_admin_update[\s\S]*?public\.is_admin\(\)[\s\S]*?WITH CHECK/,
      );
      expect(sql).toMatch(
        /assessment_transcripts_service_role[\s\S]*?TO service_role/,
      );

      // Guard: there is NO assessment_transcripts policy named with
      // an _insert suffix (policy naming convention is
      // <table>_<role>_<verb>, so an INSERT path would be visible
      // here). The only writer is the edge function (service_role).
      expect(sql).not.toMatch(/CREATE POLICY "assessment_transcripts[^"]*_insert"/);
    });
  });

  // ── care_plan_versions additive columns ──────────────────────
  describe('care_plan_versions additive columns', () => {
    it('adds source_recording_id with ON DELETE SET NULL (retention must never cascade-delete published versions)', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.care_plan_versions\s+ADD COLUMN IF NOT EXISTS source_recording_id uuid\s+REFERENCES public\.assessment_recordings\(id\) ON DELETE SET NULL/,
      );
    });

    it('adds field_citations jsonb (per-field transcript citation map)', () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS field_citations jsonb/);
    });

    it('adds narrative_paragraph text (post-approval paragraph version, distinct from generated_summary)', () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS narrative_paragraph text/);
    });

    it('partial index on source_recording_id keeps the audit lookup fast without bloating zero-source rows', () => {
      expect(sql).toMatch(
        /idx_care_plan_versions_source_recording[\s\S]*?\(source_recording_id\)[\s\S]*?WHERE source_recording_id IS NOT NULL/,
      );
    });
  });

  // ── Storage bucket + path-prefix RLS ─────────────────────────
  describe('assessment-recordings storage bucket', () => {
    it('creates the bucket idempotently', () => {
      expect(sql).toMatch(
        /INSERT INTO storage\.buckets[\s\S]*?'assessment-recordings'[\s\S]*?ON CONFLICT \(id\) DO NOTHING/,
      );
    });

    it('bucket is private, not public', () => {
      expect(sql).toMatch(/'assessment-recordings',\s*'assessment-recordings',\s*false/);
    });

    it('every authenticated storage policy enforces the org_id path-prefix check', () => {
      // The cross-tenant fence in Storage. Same predicate as
      // profile-pictures + email-attachments. Locked here so a
      // future tightening that removes it (or, worse, allows '*'
      // matching) fails this spec.
      const pathPrefixCheck = /\(\(\(SELECT auth\.jwt\(\)\) ->> 'org_id'\)::text \|\| '\/'\) = split_part\(name, '\/', 1\) \|\| '\/'/;
      const occurrences = sql.match(new RegExp(pathPrefixCheck.source, 'g')) || [];
      // staff_read (1) + staff_insert (1) + staff_update USING (1) + staff_update WITH CHECK (1) + admin_delete (1) = 5
      expect(occurrences.length).toBeGreaterThanOrEqual(5);
    });

    it('staff read + insert + update; admin-only delete; service_role full access', () => {
      expect(sql).toMatch(
        /CREATE POLICY "assessment_recordings_staff_read"[\s\S]*?ON storage\.objects FOR SELECT[\s\S]*?public\.is_staff\(\)/,
      );
      expect(sql).toMatch(
        /CREATE POLICY "assessment_recordings_staff_insert"[\s\S]*?ON storage\.objects FOR INSERT[\s\S]*?public\.is_staff\(\)/,
      );
      expect(sql).toMatch(
        /CREATE POLICY "assessment_recordings_staff_update"[\s\S]*?ON storage\.objects FOR UPDATE[\s\S]*?public\.is_staff\(\)/,
      );
      expect(sql).toMatch(
        /CREATE POLICY "assessment_recordings_admin_delete"[\s\S]*?ON storage\.objects FOR DELETE[\s\S]*?public\.is_admin\(\)/,
      );
      expect(sql).toMatch(
        /CREATE POLICY "assessment_recordings_service_role"[\s\S]*?ON storage\.objects FOR ALL\s+TO service_role[\s\S]*?bucket_id = 'assessment-recordings'/,
      );
    });
  });

  // ── Feature flag seed for Tremendous Care ────────────────────
  describe('feature flag seed', () => {
    it('writes the assessments subtree onto Tremendous Care via jsonb-merge (no clobber of other settings keys)', () => {
      expect(sql).toMatch(
        /UPDATE public\.organizations\s+SET settings = settings\s+\|\|[\s\S]*?'assessments'[\s\S]*?WHERE slug = 'tremendous-care'/,
      );
    });

    it('seeds recording_enabled = true for Tremendous Care', () => {
      expect(sql).toMatch(/'recording_enabled',\s+true/);
    });

    it('seeds require_baa = false (v1 non-BAA posture, doc-locked)', () => {
      expect(sql).toMatch(/'require_baa',\s+false/);
    });

    it('seeds 90-day audio retention default', () => {
      expect(sql).toMatch(/'retention_audio_days',\s+90/);
    });

    it('seeds the v1 vendor lock: deepgram transcription + anthropic LLM', () => {
      expect(sql).toMatch(/'providers',[\s\S]*?'transcription',\s+'deepgram'[\s\S]*?'llm',\s+'anthropic'/);
    });
  });

  // ── Cross-cutting invariants ─────────────────────────────────
  describe('cross-cutting invariants', () => {
    it('all policy creations are idempotent (guarded by pg_policies lookup)', () => {
      const guards = sql.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_policies/g) || [];
      // 5 table policies on assessment_recordings
      // + 3 table policies on assessment_transcripts
      // + 5 storage.objects policies
      // = 13
      expect(guards.length).toBeGreaterThanOrEqual(13);
    });

    it('uses helper functions instead of inline subqueries (RLS recursion gotcha — see docs/RLS_GOTCHAS.md)', () => {
      // CLAUDE.md mandates is_staff/is_admin helpers over inline
      // EXISTS-against-user_roles patterns. Guard against regression.
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_roles/);
    });

    it('does not name any policy "tenant_isolation_*" (would collide with B2b naming used for permissive-policy bookkeeping in B5)', () => {
      // PR #237 hotfix lesson: B5 cleanup filters by the suffix
      // pattern ^tenant_isolation_.*_(select|insert|update|delete)$.
      // New table policies live in their own namespace
      // (<table>_<role>_<verb>) so the B5 sweep cannot accidentally
      // drop them.
      expect(sql).not.toMatch(/CREATE POLICY\s+"tenant_isolation_/);
    });
  });
});

describe('assessment_recordings_foundation rollback', () => {
  const sql = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('drops every table policy created by the forward migration', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_read"\s+ON public\.assessment_recordings/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_insert"\s+ON public\.assessment_recordings/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_update"\s+ON public\.assessment_recordings/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_admin_delete"\s+ON public\.assessment_recordings/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_service_role"\s+ON public\.assessment_recordings/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_transcripts_staff_read"\s+ON public\.assessment_transcripts/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_transcripts_admin_update"\s+ON public\.assessment_transcripts/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_transcripts_service_role"\s+ON public\.assessment_transcripts/);
  });

  it('drops every storage.objects policy created by the forward migration', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_read"\s+ON storage\.objects/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_insert"\s+ON storage\.objects/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_staff_update"\s+ON storage\.objects/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_admin_delete"\s+ON storage\.objects/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "assessment_recordings_service_role"\s+ON storage\.objects/);
  });

  it('clears bucket objects before dropping the bucket', () => {
    // FK from storage.objects to storage.buckets blocks the bucket
    // drop while objects remain. Order matters.
    const objIdx = sql.indexOf("DELETE FROM storage.objects WHERE bucket_id = 'assessment-recordings'");
    const bucketIdx = sql.indexOf("DELETE FROM storage.buckets WHERE id = 'assessment-recordings'");
    expect(objIdx).toBeGreaterThanOrEqual(0);
    expect(bucketIdx).toBeGreaterThan(objIdx);
  });

  it('drops the additive columns and partial index on care_plan_versions', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS public\.idx_care_plan_versions_source_recording/);
    expect(sql).toMatch(/ALTER TABLE public\.care_plan_versions DROP COLUMN IF EXISTS source_recording_id/);
    expect(sql).toMatch(/ALTER TABLE public\.care_plan_versions DROP COLUMN IF EXISTS field_citations/);
    expect(sql).toMatch(/ALTER TABLE public\.care_plan_versions DROP COLUMN IF EXISTS narrative_paragraph/);
  });

  it('drops both new tables', () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.assessment_transcripts/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.assessment_recordings/);
  });

  it('drops assessment_transcripts before assessment_recordings (FK dependency)', () => {
    const transcriptsIdx = sql.indexOf('DROP TABLE IF EXISTS public.assessment_transcripts');
    const recordingsIdx = sql.indexOf('DROP TABLE IF EXISTS public.assessment_recordings');
    expect(transcriptsIdx).toBeGreaterThanOrEqual(0);
    expect(recordingsIdx).toBeGreaterThan(transcriptsIdx);
  });

  it('strips only the assessments subtree from Tremendous Care settings', () => {
    expect(sql).toMatch(
      /UPDATE public\.organizations\s+SET settings = settings - 'assessments'[\s\S]*?WHERE slug = 'tremendous-care'/,
    );
  });

  it('wraps the rollback in BEGIN/COMMIT (atomic — partial rollback would be worse than no rollback)', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;\s*$/m);
  });
});
