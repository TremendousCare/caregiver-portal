// Structural assertions on migration 20260529000000_exec_tasks_generate_cron.
//
// Locks in: cron schedule, edge function url shape, idempotent
// re-run via cron.schedule (overwrites the existing entry by name),
// rollback unschedules cleanly.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260529000000_exec_tasks_generate_cron.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260529000000_exec_tasks_generate_cron_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('exec_tasks_generate_cron migration', () => {
  it("schedules a job named 'exec-tasks-generate'", () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'exec-tasks-generate'/);
  });

  it('runs daily at 10:00 UTC', () => {
    expect(sql).toMatch(/'0 10 \* \* \*'/);
  });

  it('posts to the exec-tasks-generate edge function', () => {
    expect(sql).toMatch(/\/functions\/v1\/exec-tasks-generate/);
  });

  it('reads project_url and publishable_key from the vault', () => {
    expect(sql).toMatch(/vault\.decrypted_secrets WHERE name = 'project_url'/);
    expect(sql).toMatch(/vault\.decrypted_secrets WHERE name = 'publishable_key'/);
  });

  it('sets a 5-minute timeout (300000ms)', () => {
    expect(sql).toMatch(/timeout_milliseconds := 300000/);
  });

  it('includes a sanity check that fails the deploy if the job is missing', () => {
    expect(sql).toMatch(/cron\.job WHERE jobname = 'exec-tasks-generate'/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('rollback unschedules the job', () => {
    expect(rollbackSql).toMatch(/cron\.unschedule\('exec-tasks-generate'\)/);
  });
});
