/**
 * Structural assertions on the push notification migrations.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/migrations');
const subsSql = readFileSync(join(MIG_DIR, '20260603130000_push_subscriptions.sql'), 'utf-8');
const cronSql = readFileSync(join(MIG_DIR, '20260603140000_shift_reminders_cron.sql'), 'utf-8');

describe('push_subscriptions migration', () => {
  it('creates the table idempotently with org_id (multi-tenancy)', () => {
    expect(subsSql).toMatch(/CREATE TABLE IF NOT EXISTS push_subscriptions/);
    expect(subsSql).toMatch(/org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)/);
    expect(subsSql).toMatch(/REFERENCES public\.organizations\(id\)/);
  });

  it('enables RLS and scopes caregivers to their own rows', () => {
    expect(subsSql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(subsSql).toMatch(/caregiver_id = public\.current_user_caregiver_id\(\)/);
    expect(subsSql).toMatch(/public\.is_staff\(\)/);
  });

  it('does not drop or delete data', () => {
    expect(subsSql).not.toMatch(/DROP TABLE/i);
    expect(subsSql).not.toMatch(/DELETE FROM/i);
  });
});

describe('shift_reminders cron migration', () => {
  it('adds reminder_sent_at additively', () => {
    expect(cronSql).toMatch(/ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz/);
  });

  it('schedules the cron idempotently via the vault pattern', () => {
    expect(cronSql).toMatch(/cron\.unschedule/);
    expect(cronSql).toMatch(/cron\.schedule\(\s*'shift-reminders'/);
    expect(cronSql).toMatch(/\/functions\/v1\/shift-reminders/);
    expect(cronSql).toMatch(/vault\.decrypted_secrets/);
  });
});
