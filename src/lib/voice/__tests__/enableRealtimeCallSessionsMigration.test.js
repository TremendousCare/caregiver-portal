/**
 * Structural assertions on the call_sessions Realtime publication
 * migration. PR #319 frontend subscribes to postgres_changes on this
 * table; without this membership the screen-pop is silent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260513000000_voice_phase1_enable_realtime_call_sessions.sql',
);

describe('Voice Phase 1 PR 3.2 — enable Realtime on call_sessions migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('alters the supabase_realtime publication to include call_sessions', () => {
    expect(sql).toMatch(
      /ALTER PUBLICATION supabase_realtime ADD TABLE public\.call_sessions/,
    );
  });

  it('is idempotent — pre-check against pg_publication_tables before ADD', () => {
    expect(sql).toMatch(/pg_publication_tables/);
    expect(sql).toMatch(/IF NOT EXISTS/);
  });

  it('aborts the deploy if call_sessions is missing from the publication after migration', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/call_sessions is not in supabase_realtime publication/);
  });
});
