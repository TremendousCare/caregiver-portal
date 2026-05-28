// Structural assertions on migration 20260528000200_exec_tables.
//
// Locks in: five-table shape, anchor/category integrity guards,
// idempotency indexes per category, RLS posture (owner R/W for tasks
// + templates, owner R/W + admin R for goals/KRs/checkins), org_id
// scoping on every policy per RLS_GOTCHAS rule 1.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260528000200_exec_tables.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260528000200_exec_tables_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

const EXEC_TABLES = [
  'exec_task_templates',
  'exec_tasks',
  'exec_goals',
  'exec_key_results',
  'exec_goal_checkins',
];

describe('exec_tables migration', () => {
  describe('all five tables exist', () => {
    EXEC_TABLES.forEach((tbl) => {
      it(`creates ${tbl} idempotently`, () => {
        const re = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}`);
        expect(sql).toMatch(re);
      });
    });
  });

  describe('multi-tenancy discipline', () => {
    EXEC_TABLES.forEach((tbl) => {
      it(`${tbl} carries NOT NULL org_id with FK + default_org_id() default`, () => {
        const tableBlock = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}[\\s\\S]*?\\n\\);`))?.[0] ?? '';
        expect(tableBlock).toMatch(/org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)/);
        expect(tableBlock).toMatch(/REFERENCES public\.organizations\(id\) ON DELETE CASCADE/);
      });
    });
  });

  describe('exec_task_templates', () => {
    it('UNIQUE (org_id, slug) makes seed idempotent', () => {
      const tableBlock = sql.match(/CREATE TABLE IF NOT EXISTS public\.exec_task_templates[\s\S]*?\n\);/)?.[0] ?? '';
      expect(tableBlock).toMatch(/UNIQUE \(org_id, slug\)/);
    });

    it('category enum covers lifecycle, recurring, ad_hoc', () => {
      expect(sql).toMatch(/category[\s\S]*?CHECK \(category IN \('lifecycle', 'recurring', 'ad_hoc'\)\)/);
    });

    it('anchor_type enum covers hire_date, fixed_date, manual', () => {
      expect(sql).toMatch(/anchor_type[\s\S]*?CHECK \(anchor_type IN \('hire_date', 'fixed_date', 'manual'\)\)/);
    });

    it('anchor-type/column consistency CHECK enforces shape', () => {
      const tableBlock = sql.match(/CREATE TABLE IF NOT EXISTS public\.exec_task_templates[\s\S]*?\n\);/)?.[0] ?? '';
      expect(tableBlock).toMatch(/anchor_type = 'hire_date' AND offset_days IS NOT NULL/);
      expect(tableBlock).toMatch(/anchor_type = 'fixed_date' AND recurrence_interval_days IS NOT NULL/);
    });

    it('structured_questions defaults to empty jsonb array', () => {
      expect(sql).toMatch(/structured_questions\s+jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    });

    it('visibility enum covers owner, admin', () => {
      expect(sql).toMatch(/visibility[\s\S]*?CHECK \(visibility IN \('owner', 'admin'\)\)/);
    });

    it('active defaults to false (templates ship inactive)', () => {
      expect(sql).toMatch(/active\s+boolean NOT NULL DEFAULT false/);
    });
  });

  describe('exec_tasks', () => {
    it('category enum matches template categories', () => {
      const taskBlock = sql.match(/CREATE TABLE IF NOT EXISTS public\.exec_tasks[\s\S]*?\n\);/)?.[0] ?? '';
      expect(taskBlock).toMatch(/CHECK \(category IN \('lifecycle', 'recurring', 'ad_hoc'\)\)/);
    });

    it('status enum covers full state machine', () => {
      expect(sql).toMatch(/status[\s\S]*?CHECK \(status IN \('pending', 'in_progress', 'done',\s*'snoozed', 'cancelled'\)\)/);
    });

    it('outcome enum is on_track | needs_support | concern (nullable)', () => {
      expect(sql).toMatch(/outcome IS NULL\s*\n?\s*OR outcome IN \('on_track', 'needs_support', 'concern'\)/);
    });

    it('category/anchor consistency CHECK', () => {
      const taskBlock = sql.match(/CREATE TABLE IF NOT EXISTS public\.exec_tasks[\s\S]*?\n\);/)?.[0] ?? '';
      expect(taskBlock).toMatch(/category = 'lifecycle' AND anchor_staff_email IS NOT NULL AND anchor_date IS NOT NULL/);
      expect(taskBlock).toMatch(/category = 'recurring' AND recurrence_period IS NOT NULL/);
    });

    it('idempotency: partial unique index for lifecycle tasks', () => {
      expect(sql).toMatch(
        /uq_exec_tasks_lifecycle[\s\S]*?ON public\.exec_tasks \(template_id, anchor_staff_email, anchor_date\)[\s\S]*?WHERE category = 'lifecycle' AND template_id IS NOT NULL/,
      );
    });

    it('idempotency: partial unique index for recurring tasks', () => {
      expect(sql).toMatch(
        /uq_exec_tasks_recurring[\s\S]*?ON public\.exec_tasks \(template_id, recurrence_period\)[\s\S]*?WHERE category = 'recurring' AND template_id IS NOT NULL/,
      );
    });

    it('hot-path due_at index is partial on pending|in_progress', () => {
      expect(sql).toMatch(
        /idx_exec_tasks_due_at[\s\S]*?\(org_id, due_at\)[\s\S]*?WHERE status IN \('pending', 'in_progress'\)/,
      );
    });
  });

  describe('exec_goals', () => {
    it('status enum covers OKR lifecycle', () => {
      expect(sql).toMatch(/status[\s\S]*?CHECK \(status IN \('draft', 'active', 'achieved',\s*'missed', 'cancelled'\)\)/);
    });

    it('end_date >= start_date guard', () => {
      const goalsBlock = sql.match(/CREATE TABLE IF NOT EXISTS public\.exec_goals[\s\S]*?\n\);/)?.[0] ?? '';
      expect(goalsBlock).toMatch(/CHECK \(end_date >= start_date\)/);
    });

    it('parent_goal_id allows future cascading goals (self-FK, SET NULL)', () => {
      expect(sql).toMatch(/parent_goal_id\s+uuid REFERENCES public\.exec_goals\(id\) ON DELETE SET NULL/);
    });
  });

  describe('exec_key_results', () => {
    it('CASCADE delete when parent goal is deleted', () => {
      expect(sql).toMatch(/goal_id\s+uuid NOT NULL REFERENCES public\.exec_goals\(id\) ON DELETE CASCADE/);
    });

    it('metric_unit enum is count/percent/dollars/rating/other', () => {
      expect(sql).toMatch(/metric_unit[\s\S]*?CHECK \(metric_unit IN \('count', 'percent', 'dollars',\s*'rating', 'other'\)\)/);
    });

    it('confidence enum is green/yellow/red', () => {
      expect(sql).toMatch(/confidence[\s\S]*?CHECK \(confidence IN \('green', 'yellow', 'red'\)\)/);
    });

    it('direction enum is increase/decrease', () => {
      expect(sql).toMatch(/direction[\s\S]*?CHECK \(direction IN \('increase', 'decrease'\)\)/);
    });

    it('data_source defaults to manual', () => {
      expect(sql).toMatch(/data_source\s+text NOT NULL DEFAULT 'manual'/);
    });
  });

  describe('exec_goal_checkins', () => {
    it('week_of + key_result_id is the natural key (one row per week per KR)', () => {
      expect(sql).toMatch(/UNIQUE \(key_result_id, week_of\)/);
    });

    it('CASCADE delete when parent KR is deleted', () => {
      expect(sql).toMatch(/key_result_id\s+uuid NOT NULL REFERENCES public\.exec_key_results\(id\) ON DELETE CASCADE/);
    });
  });

  describe('RLS posture', () => {
    EXEC_TABLES.forEach((tbl) => {
      it(`${tbl} has RLS enabled`, () => {
        const re = new RegExp(`ALTER TABLE public\\.${tbl}\\s+ENABLE ROW LEVEL SECURITY`);
        expect(sql).toMatch(re);
      });
    });

    describe('owner-only tables', () => {
      ['exec_task_templates', 'exec_tasks'].forEach((tbl) => {
        ['select', 'insert', 'update', 'delete'].forEach((cmd) => {
          it(`${tbl} ${cmd.toUpperCase()} requires is_owner() + org_id`, () => {
            const re = new RegExp(`CREATE POLICY ${tbl}_owner_${cmd}[\\s\\S]*?public\\.is_owner\\(\\) AND org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
            expect(sql).toMatch(re);
          });
        });
      });
    });

    describe('admin-readable tables (goals / KRs / checkins)', () => {
      ['exec_goals', 'exec_key_results', 'exec_goal_checkins'].forEach((tbl) => {
        it(`${tbl} SELECT gates on is_admin() (so admins can read)`, () => {
          const re = new RegExp(`CREATE POLICY ${tbl}_admin_select[\\s\\S]*?public\\.is_admin\\(\\) AND org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
          expect(sql).toMatch(re);
        });

        ['insert', 'update', 'delete'].forEach((cmd) => {
          it(`${tbl} ${cmd.toUpperCase()} requires is_owner()`, () => {
            const re = new RegExp(`CREATE POLICY ${tbl}_owner_${cmd}[\\s\\S]*?public\\.is_owner\\(\\) AND org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
            expect(sql).toMatch(re);
          });
        });
      });
    });

    it('no inline EXISTS subqueries on the exec_* tables themselves (RLS_GOTCHAS rule 1)', () => {
      // The only EXISTS in the file should be the sanity-check DO block at the bottom.
      // Policies must use helper functions, never inline EXISTS into exec_* tables.
      EXEC_TABLES.forEach((tbl) => {
        const policyBlocks = sql.match(new RegExp(`CREATE POLICY ${tbl}_[^\\n]+\\n[\\s\\S]*?(?=CREATE POLICY|DO \\$\\$|-- ──)`, 'g')) ?? [];
        policyBlocks.forEach((block) => {
          // Allow EXISTS only outside policies — none should be in the policy bodies.
          // Looser check: ensure the policy body uses is_owner/is_admin and not "EXISTS (".
          expect(block).not.toMatch(/EXISTS \(\s*SELECT/);
        });
      });
    });
  });

  describe('rollback', () => {
    it('drops every exec_* table', () => {
      EXEC_TABLES.forEach((tbl) => {
        const re = new RegExp(`DROP TABLE IF EXISTS public\\.${tbl}`);
        expect(rollbackSql).toMatch(re);
      });
    });

    it('drops child tables before parents (no FK violation)', () => {
      const checkinIdx = rollbackSql.indexOf('DROP TABLE IF EXISTS public.exec_goal_checkins');
      const krIdx = rollbackSql.indexOf('DROP TABLE IF EXISTS public.exec_key_results');
      const goalIdx = rollbackSql.indexOf('DROP TABLE IF EXISTS public.exec_goals');
      expect(checkinIdx).toBeLessThan(krIdx);
      expect(krIdx).toBeLessThan(goalIdx);
    });
  });
});
