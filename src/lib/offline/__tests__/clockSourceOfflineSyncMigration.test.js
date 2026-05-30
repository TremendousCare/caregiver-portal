/**
 * Structural assertions on the clock_events.source migration that adds
 * the 'offline_sync' value used by the caregiver PWA offline outbox.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260603110000_clock_events_source_offline_sync.sql',
);

describe('clock_events source offline_sync migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('drops the existing source check before recreating (idempotent)', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS clock_events_source_check/);
  });

  it('allows offline_sync alongside the existing source values', () => {
    expect(sql).toMatch(
      /CHECK \(source IN \('caregiver_app', 'offline_sync', 'manual_entry'\)\)/,
    );
  });

  it('does not drop or delete data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
  });
});
