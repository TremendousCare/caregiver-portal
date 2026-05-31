import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const foundationSql = readFileSync(
  resolve(MIGRATIONS, '20260603130000_care_coordinator_foundation.sql'),
  'utf8',
);
const seedSql = readFileSync(
  resolve(MIGRATIONS, '20260603130100_care_coordinator_seed_agent.sql'),
  'utf8',
);

describe('care coordinator foundation migration', () => {
  it('creates care_signals and client_health_events tables', () => {
    expect(foundationSql).toContain('CREATE TABLE IF NOT EXISTS public.care_signals');
    expect(foundationSql).toContain('CREATE TABLE IF NOT EXISTS public.client_health_events');
  });

  it('is org-scoped with the default_org_id backfill pattern', () => {
    // org_id must be NOT NULL with the shared default on both tables.
    const orgIdDefaults = foundationSql.match(
      /org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)/g,
    );
    expect(orgIdDefaults).toHaveLength(2);
  });

  it('enables RLS with staff-only policies', () => {
    expect(foundationSql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(foundationSql).toContain('is_staff()');
    expect(foundationSql).toContain('care_signals_staff_all');
    expect(foundationSql).toContain('client_health_events_staff_all');
  });

  it('constrains severity and status to the documented enums', () => {
    expect(foundationSql).toContain("severity IN ('info', 'watch', 'urgent')");
    expect(foundationSql).toContain(
      "status IN ('open', 'acknowledged', 'dismissed', 'actioned')",
    );
  });

  it('captures the outcome event types needed for readmission reporting', () => {
    for (const t of [
      'hospitalization',
      'ed_visit',
      'fall',
      'hospital_discharge',
    ]) {
      expect(foundationSql).toContain(`'${t}'`);
    }
  });

  it('links signals to follow-up tasks and health events to signals', () => {
    expect(foundationSql).toContain(
      'follow_up_task_id uuid REFERENCES public.follow_up_tasks(id)',
    );
    expect(foundationSql).toContain(
      'preceding_signal_id  uuid REFERENCES public.care_signals(id)',
    );
  });

  it('is idempotent (IF NOT EXISTS + DROP POLICY/TRIGGER IF EXISTS)', () => {
    expect(foundationSql).toContain('IF NOT EXISTS');
    expect(foundationSql).toContain('DROP POLICY IF EXISTS');
    expect(foundationSql).toContain('DROP TRIGGER IF EXISTS');
  });
});

describe('care coordinator agent seed migration', () => {
  it('seeds the care-coordinator agent idempotently', () => {
    expect(seedSql).toContain("'care-coordinator'");
    expect(seedSql).toContain('ON CONFLICT (slug) DO NOTHING');
  });

  it('ships disabled by default (feature flag off)', () => {
    expect(seedSql).toContain("'enabled', false");
  });

  it('encodes the two-window analysis config', () => {
    expect(seedSql).toContain("'acute_window_days', 7");
    expect(seedSql).toContain("'baseline_window_days', 30");
  });
});
