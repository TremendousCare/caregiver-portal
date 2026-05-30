/**
 * Structural assertions on the care_plan_observations.client_obs_id
 * migration that backs offline care-plan logging idempotency.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260603120000_care_plan_observations_client_obs_id.sql',
);

describe('care_plan_observations client_obs_id migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('adds the column idempotently and nullable', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS client_obs_id uuid/);
    // The column itself must be nullable (additive). The only "NOT NULL"
    // in the file is the partial-index predicate, never on the column.
    expect(sql).not.toMatch(/client_obs_id uuid[^;]*NOT NULL/);
  });

  it('creates a partial unique index on non-null ids', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_care_plan_observations_client_obs_id/);
    expect(sql).toMatch(/WHERE client_obs_id IS NOT NULL/);
  });

  it('does not drop or delete data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
  });
});
