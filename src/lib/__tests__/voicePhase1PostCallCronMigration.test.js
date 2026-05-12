/**
 * Structural assertions on the post-call processor cron migration.
 *
 * The migration's PL/pgSQL DO block is the runtime safety net (it
 * aborts the deploy if the cron job isn't present after scheduling).
 * This spec catches accidental removal of the schedule call or the
 * sanity block in future PRs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260512000000_post_call_processor_cron.sql',
);

describe('Voice Phase 1 — post-call processor cron migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('schedules a job named post-call-processor', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'post-call-processor'/);
  });

  it('runs the job every minute', () => {
    expect(sql).toMatch(/'post-call-processor',\s*'\* \* \* \* \*'/);
  });

  it('calls the post-call-processor edge function via net.http_post', () => {
    expect(sql).toMatch(/net\.http_post/);
    expect(sql).toMatch(/\/functions\/v1\/post-call-processor/);
  });

  it('reads project_url and publishable_key from vault.decrypted_secrets', () => {
    expect(sql).toMatch(/vault\.decrypted_secrets[\s\S]*?'project_url'/);
    expect(sql).toMatch(/vault\.decrypted_secrets[\s\S]*?'publishable_key'/);
  });

  it('contains a sanity DO block that aborts when the cron job is missing', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/SELECT count\(\*\) INTO v_job_count\s+FROM cron\.job/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/expected 1 row in cron\.job/);
  });

  it('updates the cron-job inventory comment so the README in CLAUDE.md stays accurate', () => {
    expect(sql).toMatch(/post-call-processor\s+\(every minute\)/);
  });
});
