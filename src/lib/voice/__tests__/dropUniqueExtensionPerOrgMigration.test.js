/**
 * Structural assertions on the drop-unique-extension migration.
 * Enables multiple users to bind to the same RC extension (on-call
 * rotation).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260513020001_voice_phase1_drop_unique_extension_per_org.sql',
);

describe('Voice Phase 1 PR 3.4 — drop unique extension constraint', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('drops the uniq_org_memberships_rc_extension_per_org index idempotently', () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS public\.uniq_org_memberships_rc_extension_per_org/,
    );
  });

  it('aborts the deploy if the index still exists after DROP', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(
      /uniq_org_memberships_rc_extension_per_org index still exists after DROP/,
    );
  });
});
