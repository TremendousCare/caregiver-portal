import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the QuickBooks PR #3 cron migration.
// The migration's own DO block raises if cron.schedule didn't take.
// This spec catches accidental regressions of the cron name, the
// cadence, the function URL it POSTs to, or the auth-bearer pattern
// it shares with the other 9 crons.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260603000000_quickbooks_token_refresh_cron.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260603000000_quickbooks_token_refresh_cron_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('QuickBooks integration PR #3 — token refresh cron migration', () => {
  describe('cron schedule', () => {
    it('registers a job named quickbooks-token-refresh', () => {
      expect(sql).toMatch(/SELECT cron\.schedule\(\s*'quickbooks-token-refresh'/);
    });

    it('runs every 30 minutes', () => {
      // Schedule lives on the line right after the job name; bind
      // them together so a future edit can't silently change the
      // cadence to e.g. hourly without us noticing.
      expect(sql).toMatch(
        /SELECT cron\.schedule\(\s*'quickbooks-token-refresh',\s*'\*\/30 \* \* \* \*'/,
      );
    });

    it('POSTs to the quickbooks-token-refresh edge function URL', () => {
      expect(sql).toMatch(
        /\|\| '\/functions\/v1\/quickbooks-token-refresh'/,
      );
    });

    it('reads the project URL and publishable key from vault, like every other cron', () => {
      expect(sql).toMatch(
        /vault\.decrypted_secrets WHERE name = 'project_url'/,
      );
      expect(sql).toMatch(
        /vault\.decrypted_secrets WHERE name = 'publishable_key'/,
      );
      expect(sql).toMatch(/'Authorization', 'Bearer '/);
    });
  });

  describe('runtime sanity check', () => {
    it('raises if cron.job lacks the registered row after schedule()', () => {
      expect(sql).toMatch(
        /quickbooks_token_refresh_cron: job not registered after schedule\(\)/,
      );
    });
  });

  describe('rollback', () => {
    it('unschedules the job and is idempotent', () => {
      // The IF EXISTS guard is what makes it re-runnable; verify it.
      expect(rollback).toMatch(
        /IF EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'quickbooks-token-refresh'\) THEN\s+PERFORM cron\.unschedule\('quickbooks-token-refresh'\)/,
      );
    });

    it('wraps everything in a single transaction', () => {
      expect(rollback).toMatch(/^[\s\S]*BEGIN;[\s\S]*COMMIT;[\s\S]*$/);
    });
  });
});
