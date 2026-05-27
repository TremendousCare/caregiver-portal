// Structural assertions on migration
// 20260527000001_task_notifications_dispatch.sql + matching rollback.
//
// Locks in: notification_type CHECK widening, snooze-expiry index,
// pg_cron job registration mirroring the dispatch-lead-notifications
// pattern, and rollback safety.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260527000001_task_notifications_dispatch.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260527000001_task_notifications_dispatch_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('task-notifications dispatch migration', () => {
  describe('notification_type widening', () => {
    it('drops the prior CHECK guarded by pg_constraint existence', () => {
      expect(sql).toMatch(
        /IF EXISTS \(\s*\n?\s*SELECT 1 FROM pg_constraint[\s\S]*?conname = 'notifications_user_notification_type_check'[\s\S]*?ALTER TABLE public\.notifications_user[\s\S]*?DROP CONSTRAINT/,
      );
    });

    it('adds the widened CHECK that includes task_due', () => {
      expect(sql).toMatch(
        /ADD CONSTRAINT notifications_user_notification_type_check[\s\S]*?CHECK \(notification_type IN \('new_lead', 'task_due'\)\)/,
      );
    });
  });

  describe('snooze-expiry index', () => {
    it('creates idx_follow_up_tasks_snooze_expiry as a partial index', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_snooze_expiry[\s\S]*?\(snoozed_until\)[\s\S]*?WHERE status = 'snoozed'/,
      );
    });
  });

  describe('cron registration', () => {
    it('schedules under the canonical name', () => {
      expect(sql).toMatch(/cron\.schedule\(\s*'dispatch-task-notifications'/);
    });

    it('runs every 5 minutes', () => {
      expect(sql).toMatch(/'\*\/5 \* \* \* \*'/);
    });

    it('invokes the edge function via net.http_post', () => {
      expect(sql).toMatch(/net\.http_post/);
      expect(sql).toMatch(/\/functions\/v1\/dispatch-task-notifications/);
    });

    it('uses a 60s HTTP timeout', () => {
      expect(sql).toMatch(/timeout_milliseconds := 60000/);
    });

    it('reads project_url + publishable_key from vault.decrypted_secrets', () => {
      expect(sql).toMatch(/decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'project_url'/);
      expect(sql).toMatch(/decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'publishable_key'/);
    });

    it('is idempotent — unschedules the prior job if present', () => {
      expect(sql).toMatch(/cron\.unschedule\('dispatch-task-notifications'\)/);
      expect(sql).toMatch(/WHERE EXISTS[\s\S]+?jobname = 'dispatch-task-notifications'/);
    });

    it('swallows unschedule errors (idempotent across re-runs)', () => {
      expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]+?NULL;/);
    });

    it('aborts the migration if the job did not register', () => {
      expect(sql).toMatch(
        /RAISE EXCEPTION[\s\S]+?dispatch-task-notifications cron job did not register/,
      );
    });

    it('aborts the migration if the widened CHECK is missing', () => {
      expect(sql).toMatch(
        /RAISE EXCEPTION[\s\S]+?notifications_user_notification_type_check missing/,
      );
    });
  });

  describe('safety posture', () => {
    it('no destructive DROPs of tables, columns, or data', () => {
      expect(sql).not.toMatch(/\bDROP TABLE\b/i);
      expect(sql).not.toMatch(/\bDROP COLUMN\b/i);
      expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
      // The only DROP CONSTRAINT we accept is the notification_type
      // re-widening (DROP-then-ADD same name).
    });
  });

  describe('rollback', () => {
    it('bails if task_due rows exist', () => {
      expect(rollback).toMatch(/notification_type = 'task_due'/);
      expect(rollback).toMatch(/RAISE EXCEPTION[\s\S]+?Cannot roll back/);
    });

    it('unschedules the cron job', () => {
      expect(rollback).toMatch(/cron\.unschedule\('dispatch-task-notifications'\)/);
    });

    it('drops the snooze-expiry index', () => {
      expect(rollback).toMatch(/DROP INDEX IF EXISTS public\.idx_follow_up_tasks_snooze_expiry/);
    });

    it('narrows the notification_type CHECK back to new_lead only', () => {
      expect(rollback).toMatch(/CHECK \(notification_type IN \('new_lead'\)\)/);
    });
  });
});
