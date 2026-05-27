// Structural assertions on migration 20260527000000_follow_up_tasks_user_source.
//
// Locks in: additive schema (new columns, no DROPs), CHECK constraints
// gating the source enum + the shape (template vs user/ai), nullable
// flips on template_id/caregiver_id/client_id, dispatch hot-path
// index, and idempotency. Also pins the rollback script.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260527000000_follow_up_tasks_user_source.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260527000000_follow_up_tasks_user_source_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('follow_up_tasks user_source migration', () => {
  describe('column additions', () => {
    it('adds source (text NOT NULL DEFAULT template) idempotently', () => {
      expect(sql).toMatch(
        /ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'template'/,
      );
    });

    it('adds title, description, created_by, notified_at as nullable', () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS title text/);
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS description text/);
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS created_by text/);
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS notified_at timestamptz/);
    });
  });

  describe('CHECK constraints', () => {
    it('adds source CHECK gating the three valid sources', () => {
      expect(sql).toMatch(
        /CONSTRAINT follow_up_tasks_source_check\s*\n?\s*CHECK \(source IN \('template', 'user', 'ai'\)\)/,
      );
    });

    it('adds shape CHECK with both arms (template AND user|ai)', () => {
      // The body of the CHECK is a multi-line OR. Search for the
      // constraint name and key phrases on each arm.
      expect(sql).toContain('follow_up_tasks_shape_check');
      // Template arm
      expect(sql).toMatch(/source = 'template'/);
      expect(sql).toMatch(/template_id\s+IS NOT NULL/);
      expect(sql).toMatch(/caregiver_id IS NOT NULL/);
      expect(sql).toMatch(/client_id\s+IS NOT NULL/);
      expect(sql).toMatch(/title\s+IS NULL/);
      // User/AI arm
      expect(sql).toMatch(/source IN \('user', 'ai'\)/);
      expect(sql).toMatch(/title IS NOT NULL/);
      expect(sql).toMatch(/length\(btrim\(title\)\) > 0/);
      // Single-entity rule
      expect(sql).toMatch(/NOT \(caregiver_id IS NOT NULL AND client_id IS NOT NULL\)/);
    });

    it('both CHECK adds are guarded with pg_constraint existence check (idempotent)', () => {
      const guards = sql.match(/IF NOT EXISTS \(\s*\n?\s*SELECT 1 FROM pg_constraint/g);
      expect(guards?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('relaxed NOT NULLs', () => {
    it('drops NOT NULL on template_id, caregiver_id, client_id', () => {
      expect(sql).toMatch(/ALTER COLUMN template_id\s+DROP NOT NULL/);
      expect(sql).toMatch(/ALTER COLUMN caregiver_id DROP NOT NULL/);
      expect(sql).toMatch(/ALTER COLUMN client_id\s+DROP NOT NULL/);
    });
  });

  describe('indexes', () => {
    it('creates the dispatch partial index for the Phase 2 cron', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_dispatch[\s\S]*?\(due_at\)[\s\S]*?WHERE status = 'pending' AND notified_at IS NULL/,
      );
    });

    it('creates the assigned-to inbox index', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_assigned[\s\S]*?\(assigned_to, status, due_at\)/,
      );
    });
  });

  describe('safety posture', () => {
    it('contains no destructive DROP COLUMN / DROP TABLE / DELETE statements', () => {
      expect(sql).not.toMatch(/\bDROP COLUMN\b/i);
      expect(sql).not.toMatch(/\bDROP TABLE\b/i);
      expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
    });

    it('every ALTER / CREATE is idempotent (IF NOT EXISTS or pg_constraint guard)', () => {
      // ADD COLUMN clauses all use IF NOT EXISTS
      const addCols = sql.match(/ADD COLUMN /g) || [];
      const idempotentAddCols = sql.match(/ADD COLUMN IF NOT EXISTS /g) || [];
      expect(addCols.length).toBe(idempotentAddCols.length);
      // CREATE INDEX uses IF NOT EXISTS
      const createIdx = sql.match(/CREATE INDEX /g) || [];
      const idempotentCreateIdx = sql.match(/CREATE INDEX IF NOT EXISTS /g) || [];
      expect(createIdx.length).toBe(idempotentCreateIdx.length);
    });

    it('sanity DO block fails the deploy if columns or constraints are missing', () => {
      expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?expected 5 new columns/);
      expect(sql).toMatch(/RAISE EXCEPTION 'follow_up_tasks user_source migration: shape CHECK missing'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'follow_up_tasks user_source migration: source CHECK missing'/);
    });
  });

  describe('rollback', () => {
    it('bails if user/ai-source rows exist (safety net)', () => {
      expect(rollback).toMatch(/source IN \('user', 'ai'\)/);
      expect(rollback).toMatch(/RAISE EXCEPTION[\s\S]*?Cannot roll back/);
    });

    it('drops both CHECK constraints and the new indexes', () => {
      expect(rollback).toMatch(/DROP CONSTRAINT IF EXISTS follow_up_tasks_shape_check/);
      expect(rollback).toMatch(/DROP CONSTRAINT IF EXISTS follow_up_tasks_source_check/);
      expect(rollback).toMatch(/DROP INDEX IF EXISTS public\.idx_follow_up_tasks_dispatch/);
      expect(rollback).toMatch(/DROP INDEX IF EXISTS public\.idx_follow_up_tasks_assigned/);
    });

    it('restores NOT NULL on the three relaxed columns', () => {
      expect(rollback).toMatch(/ALTER COLUMN template_id\s+SET NOT NULL/);
      expect(rollback).toMatch(/ALTER COLUMN caregiver_id SET NOT NULL/);
      expect(rollback).toMatch(/ALTER COLUMN client_id\s+SET NOT NULL/);
    });

    it('drops the five new columns idempotently', () => {
      for (const col of ['source', 'title', 'description', 'created_by', 'notified_at']) {
        expect(rollback).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${col}`));
      }
    });
  });
});
