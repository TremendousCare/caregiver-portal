// Structural assertions on the exec_task_notifications migration
// pair (schema + cron). Locks in column shape, helper function
// security profile, partial-index predicate, and the cron schedule.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(
  join(here, '../../../supabase/migrations/20260530000000_exec_task_notifications.sql'),
  'utf-8',
);
const SCHEMA_DOWN = readFileSync(
  join(here, '../../../supabase/migrations/_rollback/20260530000000_exec_task_notifications_down.sql'),
  'utf-8',
);
const CRON_SQL = readFileSync(
  join(here, '../../../supabase/migrations/20260530000100_exec_task_notifications_dispatch_cron.sql'),
  'utf-8',
);
const CRON_DOWN = readFileSync(
  join(here, '../../../supabase/migrations/_rollback/20260530000100_exec_task_notifications_dispatch_cron_down.sql'),
  'utf-8',
);

describe('exec_task_notifications schema migration', () => {
  it('adds send_email_on_notify to exec_task_templates (idempotent, default false)', () => {
    expect(SCHEMA_SQL).toMatch(
      /ALTER TABLE public\.exec_task_templates\s*\n\s*ADD COLUMN IF NOT EXISTS send_email_on_notify boolean NOT NULL DEFAULT false/,
    );
  });

  it('adds notified_at to exec_tasks (idempotent, nullable timestamptz)', () => {
    expect(SCHEMA_SQL).toMatch(
      /ALTER TABLE public\.exec_tasks\s*\n\s*ADD COLUMN IF NOT EXISTS notified_at timestamptz/,
    );
  });

  it('creates the dispatch hot-path partial index', () => {
    expect(SCHEMA_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_exec_tasks_dispatch_pending[\s\S]*?ON public\.exec_tasks \(due_at\)[\s\S]*?WHERE notified_at IS NULL AND status IN \('pending', 'in_progress'\)/,
    );
  });

  it('partial index does NOT reference now() (would not be IMMUTABLE)', () => {
    const indexBlock = SCHEMA_SQL.match(/CREATE INDEX IF NOT EXISTS idx_exec_tasks_dispatch_pending[\s\S]*?;/)?.[0] ?? '';
    expect(indexBlock).not.toMatch(/now\(\)/);
  });

  it('defines get_owner_emails(uuid) as STABLE SECURITY DEFINER with pinned search_path', () => {
    const fnBlock = SCHEMA_SQL.match(
      /CREATE OR REPLACE FUNCTION public\.get_owner_emails\(p_org_id uuid\)[\s\S]*?\$\$;/,
    )?.[0] ?? '';
    expect(fnBlock).toMatch(/RETURNS text\[\]/);
    expect(fnBlock).toMatch(/LANGUAGE sql/);
    expect(fnBlock).toMatch(/STABLE/);
    expect(fnBlock).toMatch(/SECURITY DEFINER/);
    expect(fnBlock).toMatch(/SET search_path TO 'public'/);
  });

  it('get_owner_emails returns an array (sorted, deduped, COALESCE for empty)', () => {
    const fnBlock = SCHEMA_SQL.match(
      /CREATE OR REPLACE FUNCTION public\.get_owner_emails\(p_org_id uuid\)[\s\S]*?\$\$;/,
    )?.[0] ?? '';
    expect(fnBlock).toMatch(/array_agg\(DISTINCT lower\(email\) ORDER BY lower\(email\)\)/);
    expect(fnBlock).toMatch(/COALESCE\(/);
    expect(fnBlock).toMatch(/ARRAY\[\]::text\[\]/);
    expect(fnBlock).toMatch(/WHERE role = 'owner'/);
  });

  it('revokes PUBLIC + grants authenticated + service_role on get_owner_emails', () => {
    expect(SCHEMA_SQL).toMatch(/REVOKE ALL ON FUNCTION public\.get_owner_emails\(uuid\) FROM PUBLIC/);
    expect(SCHEMA_SQL).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_owner_emails\(uuid\) TO authenticated, service_role/);
  });

  it('sanity check fails the deploy if columns or function are missing', () => {
    expect(SCHEMA_SQL).toMatch(/column_name = 'send_email_on_notify'/);
    expect(SCHEMA_SQL).toMatch(/column_name = 'notified_at'/);
    expect(SCHEMA_SQL).toMatch(/proname = 'get_owner_emails'[\s\S]*?prosecdef = true/);
  });

  describe('rollback', () => {
    it('drops the helper function', () => {
      expect(SCHEMA_DOWN).toMatch(/DROP FUNCTION IF EXISTS public\.get_owner_emails\(uuid\)/);
    });
    it('drops the partial index', () => {
      expect(SCHEMA_DOWN).toMatch(/DROP INDEX IF EXISTS public\.idx_exec_tasks_dispatch_pending/);
    });
    it('drops both new columns', () => {
      expect(SCHEMA_DOWN).toMatch(/DROP COLUMN IF EXISTS notified_at/);
      expect(SCHEMA_DOWN).toMatch(/DROP COLUMN IF EXISTS send_email_on_notify/);
    });
  });
});

describe('exec_task_notifications dispatch cron migration', () => {
  it("schedules a job named 'dispatch-exec-task-notifications'", () => {
    expect(CRON_SQL).toMatch(/cron\.schedule\(\s*'dispatch-exec-task-notifications'/);
  });

  it('runs every 15 minutes', () => {
    expect(CRON_SQL).toMatch(/'\*\/15 \* \* \* \*'/);
  });

  it('posts to the dispatch-exec-task-notifications edge function', () => {
    expect(CRON_SQL).toMatch(/\/functions\/v1\/dispatch-exec-task-notifications/);
  });

  it('reads project_url + publishable_key from the vault', () => {
    expect(CRON_SQL).toMatch(/vault\.decrypted_secrets WHERE name = 'project_url'/);
    expect(CRON_SQL).toMatch(/vault\.decrypted_secrets WHERE name = 'publishable_key'/);
  });

  it('includes a sanity check that fails the deploy if the job is missing', () => {
    expect(CRON_SQL).toMatch(/cron\.job WHERE jobname = 'dispatch-exec-task-notifications'/);
    expect(CRON_SQL).toMatch(/RAISE EXCEPTION/);
  });

  it('rollback unschedules the job', () => {
    expect(CRON_DOWN).toMatch(/cron\.unschedule\('dispatch-exec-task-notifications'\)/);
  });
});
