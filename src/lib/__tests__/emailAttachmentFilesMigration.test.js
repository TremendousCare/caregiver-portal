// Structural assertions on the email_attachment_files migration.
//
// The migration adds:
//   1. public.email_attachment_files table with org_id + storage_path
//   2. email-attachments Storage bucket
//   3. RLS policies on both table and storage.objects gated on
//      is_staff() for reads, is_admin() for writes (plus service_role
//      all-access so the edge function can download blobs).
//
// These structural invariants are easy to drop in a future migration
// (e.g. a refactor that regenerates the policies without re-creating
// the staff/admin gates). This spec locks them in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260515000000_email_attachment_files.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260515000000_email_attachment_files_down.sql',
);

describe('email_attachment_files migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('creates the table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.email_attachment_files/);
  });

  it('every row carries an org_id FK to organizations (multi-tenant prime directive)', () => {
    expect(sql).toMatch(/org_id\s+uuid REFERENCES public\.organizations\(id\)/);
    expect(sql).toMatch(/idx_email_attachment_files_org/);
  });

  it('stores the metadata fields the edge function reads', () => {
    expect(sql).toMatch(/file_name\s+text NOT NULL/);
    expect(sql).toMatch(/storage_path\s+text NOT NULL UNIQUE/);
    expect(sql).toMatch(/content_type\s+text NOT NULL/);
    expect(sql).toMatch(/size_bytes\s+bigint NOT NULL/);
  });

  it('enables RLS on the table', () => {
    expect(sql).toMatch(/ALTER TABLE public\.email_attachment_files ENABLE ROW LEVEL SECURITY/);
  });

  it('gates table read on is_staff() AND tenant org match', () => {
    expect(sql).toMatch(
      /email_attachment_files_staff_read[\s\S]*?public\.is_staff\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
  });

  it('gates table writes on is_admin() AND tenant org match', () => {
    // INSERT — only WITH CHECK
    expect(sql).toMatch(
      /email_attachment_files_admin_insert[\s\S]*?WITH CHECK\s*\(\s*[\s\S]*?public\.is_admin\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
    // UPDATE — both USING and WITH CHECK
    expect(sql).toMatch(
      /email_attachment_files_admin_update[\s\S]*?USING\s*\([\s\S]*?public\.is_admin\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid[\s\S]*?WITH CHECK\s*\([\s\S]*?public\.is_admin\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
    // DELETE — only USING
    expect(sql).toMatch(
      /email_attachment_files_admin_delete[\s\S]*?USING\s*\([\s\S]*?public\.is_admin\(\)[\s\S]*?org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
  });

  it('uses helper functions instead of inline subqueries (RLS recursion gotcha)', () => {
    // CLAUDE.md / docs/RLS_GOTCHAS.md mandates extracting EXISTS
    // subqueries into STABLE SECURITY DEFINER helpers. Make sure no
    // future hand-edit reintroduces an inline pattern.
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_roles/);
  });

  it('creates the email-attachments Storage bucket idempotently', () => {
    expect(sql).toMatch(/INSERT INTO storage\.buckets[\s\S]*?'email-attachments'[\s\S]*?ON CONFLICT \(id\) DO NOTHING/);
  });

  it('bucket is private, not public', () => {
    expect(sql).toMatch(/'email-attachments',\s*'email-attachments',\s*false/);
  });

  it('storage.objects policies gate on bucket_id, role, AND tenant path prefix', () => {
    // The path-prefix check is the cross-tenant fence in Storage —
    // RLS denies any read/write where the object name does not
    // start with the caller's JWT org_id. Same pattern as the
    // profile-pictures bucket (migration 20260514150000).
    const pathPrefixCheck = /\(\(\(SELECT auth\.jwt\(\)\) ->> 'org_id'\)::text \|\| '\/'\) = split_part\(name, '\/', 1\) \|\| '\/'/;

    expect(sql).toMatch(/email_attachments_staff_read[\s\S]*?bucket_id = 'email-attachments'[\s\S]*?public\.is_staff\(\)/);
    expect(sql).toMatch(/email_attachments_admin_insert[\s\S]*?bucket_id = 'email-attachments'[\s\S]*?public\.is_admin\(\)/);
    expect(sql).toMatch(/email_attachments_admin_delete[\s\S]*?bucket_id = 'email-attachments'[\s\S]*?public\.is_admin\(\)/);

    // Every authenticated policy must include the path-prefix check.
    // We assert at least 4 occurrences (one per staff_read + admin_insert + admin_update USING + admin_delete; admin_update also has it in WITH CHECK).
    const occurrences = sql.match(new RegExp(pathPrefixCheck.source, 'g')) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
  });

  it('grants service_role full access to the bucket (needed for edge function download)', () => {
    expect(sql).toMatch(/email_attachments_service_role[\s\S]*?TO service_role[\s\S]*?bucket_id = 'email-attachments'/);
  });

  it('all policy creations are idempotent (guarded by pg_policies lookup)', () => {
    // Counting the explicit guards is a soft assertion; assert at least
    // one per policy we add (9 policies total: 4 table + 5 storage).
    const guards = sql.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_policies/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(9);
  });
});

describe('email_attachment_files rollback', () => {
  const sql = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('drops every table policy created by the forward migration', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachment_files_staff_read"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachment_files_admin_insert"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachment_files_admin_update"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachment_files_admin_delete"/);
  });

  it('drops every storage.objects policy created by the forward migration', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachments_staff_read"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachments_admin_insert"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachments_admin_update"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachments_admin_delete"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "email_attachments_service_role"/);
  });

  it('drops the table and the bucket', () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.email_attachment_files/);
    expect(sql).toMatch(/DELETE FROM storage\.buckets WHERE id = 'email-attachments'/);
  });

  it('clears bucket objects before dropping the bucket', () => {
    // The DELETE on objects must come before the DELETE on buckets,
    // otherwise the FK from storage.objects to storage.buckets blocks
    // the bucket drop on a non-empty bucket.
    const objIdx = sql.indexOf("DELETE FROM storage.objects WHERE bucket_id = 'email-attachments'");
    const bucketIdx = sql.indexOf("DELETE FROM storage.buckets WHERE id = 'email-attachments'");
    expect(objIdx).toBeGreaterThanOrEqual(0);
    expect(bucketIdx).toBeGreaterThan(objIdx);
  });
});
