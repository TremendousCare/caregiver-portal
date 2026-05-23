// Structural assertions on the dispatch-lead-notifications cron
// migration (PR 3 of the lead-notif feature).
//
// The migration registers a pg_cron job that calls the edge function
// every 5 minutes. These checks lock in the cadence, job name, and
// idempotent install pattern.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260523000200_dispatch_lead_notifications_cron.sql',
);

describe('dispatch-lead-notifications cron migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('schedules the job under the canonical name', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'dispatch-lead-notifications'/);
  });

  it('runs every 5 minutes', () => {
    expect(sql).toMatch(/'\*\/5 \* \* \* \*'/);
  });

  it('invokes the edge function via net.http_post', () => {
    expect(sql).toMatch(/net\.http_post/);
    expect(sql).toMatch(/\/functions\/v1\/dispatch-lead-notifications/);
  });

  it('reads project_url + publishable_key from vault.decrypted_secrets', () => {
    expect(sql).toMatch(
      /SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'project_url'/,
    );
    expect(sql).toMatch(
      /SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'publishable_key'/,
    );
  });

  it('uses a 60s HTTP timeout — long enough for a 50-row batch', () => {
    expect(sql).toMatch(/timeout_milliseconds := 60000/);
  });

  it('is idempotent — unschedules the prior job if it exists', () => {
    expect(sql).toMatch(/cron\.unschedule\('dispatch-lead-notifications'\)/);
    expect(sql).toMatch(/WHERE EXISTS[\s\S]+?jobname = 'dispatch-lead-notifications'/);
  });

  it('swallows unschedule errors so re-runs cannot abort the deploy', () => {
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]+?NULL;/);
  });

  it('aborts the migration if the job did not register', () => {
    expect(sql).toMatch(
      /RAISE EXCEPTION[\s\S]+?dispatch-lead-notifications cron job did not register/,
    );
  });
});
