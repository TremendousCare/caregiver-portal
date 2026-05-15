-- Email attachment library for automation rules.
--
-- Three additive, idempotent changes:
--
-- 1) `public.email_attachment_files` — metadata table for files that
--    can be attached to outbound emails (currently from automation
--    rules; future: ad-hoc composer too). Each row points to a
--    blob in the `email-attachments` Storage bucket.
--
--    Why a metadata table at all? Three reasons:
--      a) Storage objects don't carry friendly names — we want to
--         show "2024 TC Employee Handbook" not "uuid.pdf" in the
--         picker.
--      b) Rules reference files by stable UUID, so re-uploading
--         to fix a typo doesn't break every rule.
--      c) We can pre-compute size_bytes once at upload, so the
--         sendMail path doesn't have to HEAD the object to pick
--         the right Graph upload strategy.
--
-- 2) Private Supabase Storage bucket `email-attachments` for the
--    raw file bytes. Same path convention as `profile-pictures`
--    (migration 20260514150000) — first segment is `<org_id>`,
--    so the existing org-scoped RLS pattern works as-is.
--
-- 3) RLS policies on the table and on `storage.objects` for this
--    bucket. Staff-only read/write, tenant-scoped. Service role
--    bypasses RLS and is what the edge function uses.
--
-- Rollback: `_rollback/20260515000000_email_attachment_files_down.sql`.

-- ── 1. Metadata table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_attachment_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES public.organizations(id),
  file_name       text NOT NULL,
  storage_path    text NOT NULL UNIQUE,
  content_type    text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      bigint NOT NULL,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachment_files_org
  ON public.email_attachment_files (org_id);

-- Backfill org_id to Tremendous Care for any rows added before this
-- migration (none expected, but keeps the column tightenable later).
UPDATE public.email_attachment_files f
SET org_id = o.id
FROM public.organizations o
WHERE f.org_id IS NULL AND o.slug = 'tremendous-care';

ALTER TABLE public.email_attachment_files ENABLE ROW LEVEL SECURITY;

-- All four policies gate on BOTH role (is_staff/is_admin) AND
-- org_id matching the caller's JWT claim. The role gate alone is
-- insufficient for a multi-tenant deployment: staff at org A would
-- otherwise see/select files belonging to org B's automation rules.
-- Canonical predicate per migration 20260513020000.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'email_attachment_files'
      AND policyname = 'email_attachment_files_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachment_files_staff_read"
        ON public.email_attachment_files FOR SELECT
        TO authenticated
        USING (
          public.is_staff()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'email_attachment_files'
      AND policyname = 'email_attachment_files_admin_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachment_files_admin_insert"
        ON public.email_attachment_files FOR INSERT
        TO authenticated
        WITH CHECK (
          public.is_admin()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'email_attachment_files'
      AND policyname = 'email_attachment_files_admin_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachment_files_admin_update"
        ON public.email_attachment_files FOR UPDATE
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
    WHERE schemaname = 'public' AND tablename = 'email_attachment_files'
      AND policyname = 'email_attachment_files_admin_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachment_files_admin_delete"
        ON public.email_attachment_files FOR DELETE
        TO authenticated
        USING (
          public.is_admin()
          AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
        );
    $POL$;
  END IF;
END $$;

-- ── 2. Storage bucket ─────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- ── 3. RLS policies on storage.objects for this bucket ────────────
-- All four authenticated-user policies gate on a path-prefix match
-- between the object's first folder segment and the caller's JWT
-- org_id claim. Same pattern as the `profile-pictures` bucket
-- (migration 20260514150000). Upload convention is
-- `<org_id>/<uuid>.<ext>` — see EmailAttachmentsSettings.jsx.
DO $$
BEGIN
  -- Staff read so the rule editor and library UI can mint signed
  -- URLs for previewing files. Cross-org reads are blocked by the
  -- path-prefix check.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_attachments_staff_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachments_staff_read"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = 'email-attachments'
          AND public.is_staff()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Admin-only INSERT/UPDATE/DELETE. The library is a settings-level
  -- concern, not a daily-use upload, so we gate on admin (same as
  -- the automation_rules table itself). Path-prefix check ensures
  -- admin at org A cannot write into org B's folder by guessing
  -- the bucket layout.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_attachments_admin_insert'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachments_admin_insert"
        ON storage.objects FOR INSERT
        TO authenticated
        WITH CHECK (
          bucket_id = 'email-attachments'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_attachments_admin_update'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachments_admin_update"
        ON storage.objects FOR UPDATE
        TO authenticated
        USING (
          bucket_id = 'email-attachments'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        )
        WITH CHECK (
          bucket_id = 'email-attachments'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_attachments_admin_delete'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachments_admin_delete"
        ON storage.objects FOR DELETE
        TO authenticated
        USING (
          bucket_id = 'email-attachments'
          AND public.is_admin()
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Service role full access — `outlook-integration` runs with the
  -- service-role key and needs to download the blobs to attach them
  -- to outbound Graph messages.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_attachments_service_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "email_attachments_service_role"
        ON storage.objects FOR ALL
        TO service_role
        USING (bucket_id = 'email-attachments')
        WITH CHECK (bucket_id = 'email-attachments');
    $POL$;
  END IF;
END $$;
