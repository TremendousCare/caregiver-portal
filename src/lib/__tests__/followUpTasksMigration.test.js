// Structural assertions on migration 20260525000000_follow_up_tasks_v1.
//
// Locks in: schema shape, RLS posture (staff-only org-scoped, no inline
// EXISTS), trigger plumbing, idempotent seed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260525000000_follow_up_tasks_v1.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260525000000_follow_up_tasks_v1_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('follow_up_tasks v1 migration', () => {
  describe('follow_up_templates table', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.follow_up_templates/);
    });

    it('carries NOT NULL org_id with FK + default_org_id() default', () => {
      expect(sql).toMatch(
        /follow_up_templates[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s*\n?\s*REFERENCES public\.organizations\(id\) ON DELETE CASCADE/,
      );
    });

    it('UNIQUE (org_id, slug) makes the seed idempotent', () => {
      expect(sql).toMatch(/UNIQUE \(org_id, slug\)/);
    });

    it('anchor_event CHECK includes both v1 anchors (extensible)', () => {
      expect(sql).toMatch(/anchor_event[\s\S]*?CHECK \(anchor_event IN \(\s*'first_scheduled_shift_day',\s*'assignment_started'\s*\)\)/);
    });

    it('offset_days has CHECK >= 0', () => {
      expect(sql).toMatch(/offset_days\s+integer NOT NULL DEFAULT 0[\s\S]*?CHECK \(offset_days >= 0\)/);
    });

    it('recurring_interval_days is nullable with CHECK > 0', () => {
      expect(sql).toMatch(/recurring_interval_days\s+integer\s*[\s\S]*?CHECK \(recurring_interval_days IS NULL\s*\n?\s*OR recurring_interval_days > 0\)/);
    });
  });

  describe('follow_up_tasks table', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.follow_up_tasks/);
    });

    it('has all the FKs and CASCADE behavior required', () => {
      expect(sql).toMatch(/template_id\s+uuid NOT NULL REFERENCES public\.follow_up_templates\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/caregiver_id\s+text NOT NULL REFERENCES public\.caregivers\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/client_id\s+text NOT NULL REFERENCES public\.clients\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/anchor_shift_id\s+uuid REFERENCES public\.shifts\(id\) ON DELETE SET NULL/);
    });

    it('status enum covers the full state machine', () => {
      expect(sql).toMatch(/status[\s\S]*?CHECK \(status IN \('pending', 'done', 'snoozed', 'cancelled'\)\)/);
    });

    it('idempotency: UNIQUE (template, cg, client, anchor_shift)', () => {
      expect(sql).toMatch(/UNIQUE \(template_id, caregiver_id, client_id, anchor_shift_id\)/);
    });

    it('partial unique index guards against duplicate pending recurring instances', () => {
      expect(sql).toMatch(
        /uq_follow_up_tasks_pending_recurring[\s\S]*?ON public\.follow_up_tasks \(template_id, caregiver_id, client_id\)[\s\S]*?WHERE anchor_shift_id IS NULL AND status = 'pending'/,
      );
    });

    it('hot-path indexes are present (due_at, caregiver, client, org)', () => {
      expect(sql).toMatch(/idx_follow_up_tasks_due_at[\s\S]*?WHERE status = 'pending'/);
      expect(sql).toMatch(/idx_follow_up_tasks_caregiver[\s\S]*?\(caregiver_id, status, due_at\)/);
      expect(sql).toMatch(/idx_follow_up_tasks_client[\s\S]*?\(client_id, status, due_at\)/);
      expect(sql).toMatch(/idx_follow_up_tasks_org/);
    });
  });

  describe('RLS', () => {
    it('enables RLS on both tables', () => {
      expect(sql).toMatch(/ALTER TABLE public\.follow_up_templates ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/ALTER TABLE public\.follow_up_tasks\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('every CRUD policy gates on is_staff() + tenant org match', () => {
      for (const t of ['follow_up_templates', 'follow_up_tasks']) {
        for (const cmd of ['select', 'insert', 'update', 'delete']) {
          const policy = new RegExp(`${t}_staff_${cmd}[\\s\\S]*?public\\.is_staff\\(\\)[\\s\\S]*?org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
          expect(sql).toMatch(policy);
        }
      }
    });

    it('no inline EXISTS subqueries (RLS recursion gotcha)', () => {
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_roles/);
    });
  });

  describe('seeded templates', () => {
    it('seeds the four canonical cadences', () => {
      for (const slug of ['first_day_checkin', 'first_week_followup', 'two_week_followup', 'monthly_checkin']) {
        expect(sql).toContain(`'${slug}'`);
      }
    });

    it('first-day check-in uses offset 0 and critical urgency', () => {
      expect(sql).toMatch(/'first_day_checkin'[\s\S]*?'first_scheduled_shift_day', 0, NULL, 'critical'/);
    });

    it('monthly check-in has recurring_interval_days = 30', () => {
      expect(sql).toMatch(/'monthly_checkin'[\s\S]*?'first_scheduled_shift_day', 30, 30, 'info'/);
    });

    it('every seed uses ON CONFLICT (org_id, slug) DO NOTHING', () => {
      const conflicts = sql.match(/ON CONFLICT \(org_id, slug\) DO NOTHING/g);
      expect(conflicts).toHaveLength(4);
    });

    it('seeds via SELECT FROM organizations so future orgs auto-receive defaults', () => {
      // Each insert ends with a SELECT joining organizations — making
      // it both multi-tenant-correct AND idempotent.
      const selectsFromOrgs = sql.match(/FROM public\.organizations o\s*\nON CONFLICT/g);
      expect(selectsFromOrgs).toHaveLength(4);
    });
  });

  describe('triggers', () => {
    it('generate_follow_ups_on_first_shift is SECURITY DEFINER with pinned search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.generate_follow_ups_on_first_shift\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO 'public'/,
      );
    });

    it('trigger fires AFTER INSERT OR UPDATE OF the right columns', () => {
      expect(sql).toMatch(
        /CREATE TRIGGER shifts_generate_follow_ups\s+AFTER INSERT OR UPDATE OF assigned_caregiver_id, client_id ON public\.shifts/,
      );
    });

    it('trigger function uses NOT EXISTS to detect "first shift" idempotently', () => {
      expect(sql).toMatch(
        /SELECT NOT EXISTS \(\s*SELECT 1 FROM shifts s[\s\S]*?WHERE s\.id <> NEW\.id[\s\S]*?AND s\.assigned_caregiver_id = NEW\.assigned_caregiver_id[\s\S]*?AND s\.client_id = NEW\.client_id/,
      );
    });

    it('trigger function uses ON CONFLICT DO NOTHING for the insert (idempotent)', () => {
      expect(sql).toMatch(/ON CONFLICT \(template_id, caregiver_id, client_id, anchor_shift_id\) DO NOTHING/);
    });

    it('cancel_follow_ups_on_assignment_end trigger flips pending → cancelled', () => {
      expect(sql).toMatch(/cancel_follow_ups_on_assignment_end[\s\S]*?SET status = 'cancelled'[\s\S]*?cancellation_reason = 'assignment_ended'/);
    });

    it('grants EXECUTE only to authenticated + service_role (no PUBLIC)', () => {
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.generate_follow_ups_on_first_shift\(\) FROM PUBLIC/);
      expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.generate_follow_ups_on_first_shift\(\) TO authenticated, service_role/);
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.cancel_follow_ups_on_assignment_end\(\) FROM PUBLIC/);
    });
  });

  describe('realtime + sanity', () => {
    it('publishes follow_up_tasks to supabase_realtime (idempotent)', () => {
      expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.follow_up_tasks/);
    });

    it('sanity DO block fails the deploy if triggers are missing', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'follow-up tasks: shifts_generate_follow_ups trigger missing/);
      expect(sql).toMatch(/RAISE EXCEPTION 'follow-up tasks: caregiver_assignments_cancel_follow_ups trigger missing/);
    });

    it('sanity DO block fails the deploy if the seed count is wrong', () => {
      expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?expected 4 seeded templates/);
    });
  });

  describe('rollback', () => {
    it('drops triggers and functions', () => {
      expect(rollbackSql).toMatch(/DROP TRIGGER IF EXISTS shifts_generate_follow_ups/);
      expect(rollbackSql).toMatch(/DROP TRIGGER IF EXISTS caregiver_assignments_cancel_follow_ups/);
      expect(rollbackSql).toMatch(/DROP FUNCTION IF EXISTS public\.generate_follow_ups_on_first_shift/);
      expect(rollbackSql).toMatch(/DROP FUNCTION IF EXISTS public\.cancel_follow_ups_on_assignment_end/);
    });

    it('drops every policy by name', () => {
      for (const t of ['follow_up_templates', 'follow_up_tasks']) {
        for (const cmd of ['select', 'insert', 'update', 'delete']) {
          expect(rollbackSql).toContain(`${t}_staff_${cmd}`);
        }
      }
    });

    it('drops tasks before templates (FK order)', () => {
      const tasksIdx = rollbackSql.indexOf('DROP TABLE IF EXISTS public.follow_up_tasks');
      const tmplIdx = rollbackSql.indexOf('DROP TABLE IF EXISTS public.follow_up_templates');
      expect(tasksIdx).toBeGreaterThanOrEqual(0);
      expect(tmplIdx).toBeGreaterThan(tasksIdx);
    });
  });
});
