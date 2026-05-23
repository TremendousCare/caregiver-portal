// Structural assertions on the lead-notification v1 schema migration.
//
// This is PR 1 of the lead notification feature. The migration creates
// two tables (lead_notification_queue, notifications_user) and an
// AFTER INSERT trigger on `clients` that enqueues a notification row
// whenever a new lead enters the pipeline. PR 3 will drain the queue
// and actually send SMS / Teams / toast.
//
// These structural checks lock in the multi-tenancy + RLS invariants
// that are easy to break in a future PR — e.g. accidentally dropping
// the org_id FK, regressing the SECURITY DEFINER on the helper, or
// putting an inline subquery into a policy on the same table (which
// trips Postgres' policy-recursion detector per docs/RLS_GOTCHAS.md).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260523000000_lead_notification_v1_schema.sql',
);

describe('lead notification v1 schema migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  describe('lead_notification_queue table', () => {
    it('creates the table idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.lead_notification_queue/);
    });

    it('has NOT NULL org_id with default_org_id() default and FK to organizations', () => {
      expect(sql).toMatch(
        /org_id\s+uuid\s+NOT NULL\s+DEFAULT public\.default_org_id\(\)\s+REFERENCES public\.organizations\(id\) ON DELETE CASCADE/,
      );
    });

    it('lead_id is text (matching clients.id type) and FKs to clients with CASCADE', () => {
      expect(sql).toMatch(
        /lead_id\s+text\s+NOT NULL\s+REFERENCES public\.clients\(id\) ON DELETE CASCADE/,
      );
    });

    it('constrains status to the documented state machine', () => {
      expect(sql).toMatch(/status\s+text\s+NOT NULL\s+DEFAULT 'pending'/);
      expect(sql).toMatch(
        /CHECK \(status IN \('pending', 'sent', 'skipped_disabled', 'failed'\)\)/,
      );
    });

    it('has a partial index on (scheduled_for) WHERE status = pending', () => {
      expect(sql).toMatch(/idx_lead_notification_queue_pending/);
      expect(sql).toMatch(/WHERE status = 'pending'/);
    });
  });

  describe('notifications_user table', () => {
    it('creates the table idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.notifications_user/);
    });

    it('has NOT NULL org_id with default_org_id() default and FK to organizations', () => {
      expect(sql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.notifications_user[\s\S]+?org_id\s+uuid\s+NOT NULL\s+DEFAULT public\.default_org_id\(\)\s+REFERENCES public\.organizations\(id\) ON DELETE CASCADE/,
      );
    });

    it('keys recipients by email (not auth.uid) so team_members are addressable', () => {
      expect(sql).toMatch(/user_email\s+text\s+NOT NULL/);
    });

    it('enables realtime via the supabase_realtime publication', () => {
      expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.notifications_user/);
    });

    it('has an unread inbox index used by the bell badge', () => {
      expect(sql).toMatch(/idx_notifications_user_unread/);
      expect(sql).toMatch(/WHERE read_at IS NULL/);
    });
  });

  describe('SECURITY DEFINER trigger plumbing', () => {
    it('defines enqueue_lead_notification as SECURITY DEFINER with locked search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.enqueue_lead_notification\(p_client_id text\)/,
      );
      // Both helper and trigger fn must be SECURITY DEFINER with locked search_path.
      const securityDefinerCount = (sql.match(/SECURITY DEFINER/g) ?? []).length;
      expect(securityDefinerCount).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/SET search_path = public, pg_temp/);
    });

    it('installs an AFTER INSERT trigger on clients, idempotently', () => {
      expect(sql).toMatch(/DROP TRIGGER IF EXISTS clients_after_insert_lead_notify ON public\.clients/);
      expect(sql).toMatch(/CREATE TRIGGER clients_after_insert_lead_notify/);
      expect(sql).toMatch(/AFTER INSERT ON public\.clients/);
      expect(sql).toMatch(/EXECUTE FUNCTION public\.clients_after_insert_lead_notify\(\)/);
    });

    it('only enqueues when phase is new_lead or NULL (defensive against staff creating later-phase clients)', () => {
      expect(sql).toMatch(/NEW\.phase IS NULL OR NEW\.phase = 'new_lead'/);
    });

    it('aborts the migration if the trigger did not land', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'lead-notif v1 schema: trigger .* is missing/);
    });
  });

  describe('RLS — recursion-safe per docs/RLS_GOTCHAS.md', () => {
    it('enables RLS on both new tables', () => {
      expect(sql).toMatch(/ALTER TABLE public\.lead_notification_queue ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/ALTER TABLE public\.notifications_user\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('queue read policy uses is_staff() helper, not inline EXISTS', () => {
      expect(sql).toMatch(/CREATE POLICY lead_notification_queue_read_staff[\s\S]+?USING \(public\.is_staff\(\)\)/);
    });

    it('notifications_user read policy keys on auth.jwt() email, not a subquery', () => {
      // Inline EXISTS (SELECT ... FROM notifications_user) inside the
      // same table's policy would trip the recursion detector — make
      // sure we never go there.
      expect(sql).not.toMatch(/USING \([\s\S]*EXISTS[\s\S]*FROM\s+(public\.)?notifications_user/);
      expect(sql).toMatch(
        /CREATE POLICY notifications_user_read_own[\s\S]+?lower\(user_email\) = lower\(\(auth\.jwt\(\) ->> 'email'\)\)/,
      );
    });

    it('only authenticated users can update their own notifications (mark as read)', () => {
      expect(sql).toMatch(/CREATE POLICY notifications_user_update_own[\s\S]+?FOR UPDATE/);
      expect(sql).toMatch(/WITH CHECK \(lower\(user_email\) = lower\(\(auth\.jwt\(\) ->> 'email'\)\)\)/);
    });

    it('does not write inline EXISTS clauses against either new table inside their own policies', () => {
      expect(sql).not.toMatch(/USING \([\s\S]*EXISTS[\s\S]*FROM\s+(public\.)?lead_notification_queue/);
    });
  });

  describe('multi-tenancy compliance (CLAUDE.md Prime Directives)', () => {
    it('uses default_org_id() everywhere — never hardcodes the Tremendous Care UUID', () => {
      // No raw UUIDs anywhere in the migration.
      expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      // default_org_id() is used at least twice (once per table default).
      const defaultOrgIdCount = (sql.match(/public\.default_org_id\(\)/g) ?? []).length;
      expect(defaultOrgIdCount).toBeGreaterThanOrEqual(2);
    });

    it('every new table FKs org_id to public.organizations with CASCADE', () => {
      const orgFkCount = (
        sql.match(/REFERENCES public\.organizations\(id\) ON DELETE CASCADE/g) ?? []
      ).length;
      expect(orgFkCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('idempotency', () => {
    it('all CREATE TABLEs are guarded by IF NOT EXISTS', () => {
      const createTableMatches = sql.match(/CREATE TABLE/g) ?? [];
      const ifNotExistsMatches = sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
      expect(ifNotExistsMatches.length).toBe(createTableMatches.length);
    });

    it('all CREATE INDEXes are guarded by IF NOT EXISTS', () => {
      const createIndexMatches = sql.match(/CREATE INDEX/g) ?? [];
      const ifNotExistsMatches = sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? [];
      expect(ifNotExistsMatches.length).toBe(createIndexMatches.length);
    });

    it('drops the trigger before recreating to keep idempotent', () => {
      expect(sql).toMatch(/DROP TRIGGER IF EXISTS clients_after_insert_lead_notify/);
    });

    it('publication-add guards against duplicate registration', () => {
      expect(sql).toMatch(
        /IF NOT EXISTS \([\s\S]*pg_publication_tables[\s\S]*ADD TABLE public\.notifications_user/,
      );
    });
  });
});
