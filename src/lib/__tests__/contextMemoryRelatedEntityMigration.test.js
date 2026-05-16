/**
 * Phase 1.6.1 — context_memory cross-entity reference columns.
 *
 * Structural assertions on the additive migration. No runtime test —
 * the columns are unused until Phase 1.6.2's call_analyst writes
 * them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516010003_agent_platform_phase_1_6_1_context_memory_related_entity.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516010003_agent_platform_phase_1_6_1_context_memory_related_entity_down.sql',
);

const sql      = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('context_memory related_entity migration — schema additive', () => {
  it('adds related_entity_type as a nullable text column (idempotent)', () => {
    expect(sql).toMatch(/ALTER TABLE public\.context_memory\s+ADD COLUMN IF NOT EXISTS related_entity_type text/);
  });

  it('adds related_entity_id as a nullable text column (idempotent)', () => {
    expect(sql).toMatch(/ALTER TABLE public\.context_memory\s+ADD COLUMN IF NOT EXISTS related_entity_id text/);
  });

  it('adds the related_entity_type CHECK matching the primary entity_type enum', () => {
    expect(sql).toMatch(/CONSTRAINT context_memory_related_entity_type_check/);
    expect(sql).toMatch(/CHECK \(related_entity_type IS NULL\s+OR related_entity_type IN \('caregiver', 'client', 'system'\)\)/);
  });

  it('declares the CHECK idempotently via pg_constraint lookup', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    expect(sql).toMatch(/conname = 'context_memory_related_entity_type_check'/);
  });

  it('creates the related-entity index partial on superseded_by IS NULL', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_context_memory_related_entity[\s\S]*?\(related_entity_type, related_entity_id\)\s+WHERE superseded_by IS NULL AND related_entity_id IS NOT NULL/,
    );
  });

  it('creates the entity-pair compound index partial on superseded_by IS NULL', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_context_memory_entity_pair[\s\S]*?\(entity_type, entity_id, related_entity_type, related_entity_id\)/,
    );
  });

  it('annotates both columns with the Phase 1.6.1 attribution', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN public\.context_memory\.related_entity_type/);
    expect(sql).toMatch(/COMMENT ON COLUMN public\.context_memory\.related_entity_id/);
  });
});

describe('context_memory related_entity rollback', () => {
  it('drops both indexes', () => {
    expect(rollback).toMatch(/DROP INDEX IF EXISTS public\.idx_context_memory_entity_pair/);
    expect(rollback).toMatch(/DROP INDEX IF EXISTS public\.idx_context_memory_related_entity/);
  });

  it('drops the CHECK constraint', () => {
    expect(rollback).toMatch(/DROP CONSTRAINT IF EXISTS context_memory_related_entity_type_check/);
  });

  it('drops both columns', () => {
    expect(rollback).toMatch(/DROP COLUMN IF EXISTS related_entity_id/);
    expect(rollback).toMatch(/DROP COLUMN IF EXISTS related_entity_type/);
  });
});
