// Structural assertions on the interview_reminder trigger_type +
// pg_cron migration.
//
// The migration does three things:
//   1. Extends automation_rules.trigger_type CHECK to include
//      'interview_reminder'.
//   2. Adds a partial index on automation_log for dedup keyed on
//      (rule_id, interview_id, minutes_before).
//   3. Schedules an interview-reminders pg_cron job at every-5-min
//      cadence.
//
// These invariants are easy to break in a future PR (e.g. a regen of
// the CHECK constraint that drops the new value) and are not caught
// by the JS test suite. This spec locks them in as a structural
// grep — same pattern as the voice phase 1 cron migration test.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260514010000_interview_reminder_trigger_and_cron.sql',
);

describe('interview_reminder trigger_type + cron migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('drops the existing trigger_type CHECK before adding the new one', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check/);
  });

  it('adds interview_reminder to the trigger_type CHECK constraint', () => {
    expect(sql).toMatch(/ADD CONSTRAINT automation_rules_trigger_type_check/);
    expect(sql).toMatch(/'interview_reminder'/);
  });

  it('preserves every previously-allowed trigger type', () => {
    const previouslyAllowed = [
      'new_caregiver',
      'days_inactive',
      'interview_scheduled',
      'phase_change',
      'task_completed',
      'document_uploaded',
      'document_signed',
      'inbound_sms',
      'new_client',
      'client_phase_change',
      'client_task_completed',
      'survey_completed',
      'survey_pending',
      'recurring_availability_check',
      'shift_assigned',
      'shift_reminder_24h',
      'shift_changed',
      'shift_canceled',
      'interview_not_scheduled',
    ];
    for (const t of previouslyAllowed) {
      expect(sql).toContain(`'${t}'`);
    }
  });

  it('adds an idempotent partial dedup index keyed on rule/interview/minutes_before', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_automation_log_interview_reminder/);
    expect(sql).toMatch(/trigger_context ->> 'interview_id'/);
    expect(sql).toMatch(/trigger_context ->> 'minutes_before'/);
    expect(sql).toMatch(/WHERE status = 'success'/);
  });

  it('schedules an interview-reminders job at */5 cadence', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'interview-reminders'/);
    expect(sql).toMatch(/'interview-reminders',\s*'\*\/5 \* \* \* \*'/);
  });

  it('calls the interview-reminders edge function via net.http_post', () => {
    expect(sql).toMatch(/net\.http_post/);
    expect(sql).toMatch(/\/functions\/v1\/interview-reminders/);
  });

  it('reads project_url and publishable_key from vault.decrypted_secrets', () => {
    expect(sql).toMatch(/vault\.decrypted_secrets[\s\S]*?'project_url'/);
    expect(sql).toMatch(/vault\.decrypted_secrets[\s\S]*?'publishable_key'/);
  });

  it('unschedules any prior interview-reminders job (idempotent re-run)', () => {
    expect(sql).toMatch(/cron\.unschedule\('interview-reminders'\)/);
  });
});
