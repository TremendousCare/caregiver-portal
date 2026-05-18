import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the client phase consolidation migration.
// The migration itself does the runtime sanity check (the DO block at
// the end raises if any client is still on a legacy phase value).
// This spec guards against accidental mutation of the remap rules,
// rollback safety net (original_phase column), and the action_item_rules
// remap that depends on stable rule IDs.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260518000000_consolidate_client_phases.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260518000000_consolidate_client_phases_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('client phase consolidation — forward migration', () => {
  it('runs inside a single transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/COMMIT;\s*$/);
  });

  it('preserves the pre-migration phase in clients.original_phase', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS original_phase text/);
    // The backfill must only fire for legacy phases (otherwise we'd
    // mark every client's original_phase even if they were never in
    // the consolidated set).
    expect(sql).toMatch(/UPDATE public\.clients\s+SET original_phase = phase/);
    expect(sql).toMatch(/phase IN \('initial_contact', 'consultation', 'assessment'\)/);
  });

  it('remaps initial_contact and consultation to consult', () => {
    expect(sql).toMatch(/SET phase = 'consult'[\s\S]*?WHERE phase IN \('initial_contact', 'consultation'\)/);
  });

  it('remaps assessment to proposal', () => {
    expect(sql).toMatch(/SET phase = 'proposal'[\s\S]*?WHERE phase = 'assessment'/);
  });

  it('preserves audit history by writing new phase_timestamps keys without removing old ones', () => {
    // The forward migration must use `||` (jsonb merge) rather than
    // assigning a fresh object, so initial_contact / consultation /
    // assessment timestamps stay queryable post-migration.
    expect(sql).toMatch(/phase_timestamps = COALESCE\(phase_timestamps, '\{\}'::jsonb\)\s*\|\|/);
    // It must not call jsonb_strip_nulls or delete the legacy keys.
    expect(sql).not.toMatch(/-\s*'initial_contact'/);
    expect(sql).not.toMatch(/jsonb_strip_nulls/);
  });

  it('only touches the seeded action_item_rules entries', () => {
    // The cl_no_contact / cl_assessment_overdue rule ids are stable,
    // and we guard on the exact pre-migration condition_config phase
    // string so any user-edited rule is left alone.
    expect(sql).toMatch(/id = 'cl_no_contact'\s+AND condition_config->>'phase' = 'initial_contact'/);
    expect(sql).toMatch(/id = 'cl_assessment_overdue'\s+AND condition_config->>'phase' = 'assessment'/);
  });

  it('asserts no clients are left on legacy phases', () => {
    expect(sql).toMatch(/Client phase consolidation incomplete/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});

describe('client phase consolidation — rollback migration', () => {
  it('runs inside a single transaction', () => {
    expect(rollback).toMatch(/^\s*BEGIN;/m);
    expect(rollback).toMatch(/COMMIT;\s*$/);
  });

  it('restores phase from clients.original_phase', () => {
    expect(rollback).toMatch(/SET phase = original_phase/);
    // Only restore for the specific legacy values we know we wrote.
    expect(rollback).toMatch(/original_phase IN \('initial_contact', 'consultation', 'assessment'\)/);
  });

  it('reverts the action_item_rules condition_config back to legacy phases', () => {
    expect(rollback).toMatch(/'\{phase\}', '"initial_contact"'::jsonb/);
    expect(rollback).toMatch(/'\{phase\}', '"assessment"'::jsonb/);
  });

  it('does not drop clients.original_phase so a re-roll is safe', () => {
    expect(rollback).not.toMatch(/DROP COLUMN.*original_phase/i);
  });
});
