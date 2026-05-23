// Structural assertions on migration 20260523010000.
//
// The migration creates two tables — client_emergency_contacts and
// client_responsible_parties — plus RLS policies that gate on
// is_staff() + JWT org_id. These invariants are easy to drop in a
// future migration by accident (e.g. someone consolidates contact
// tables); this spec locks them in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260523010000_client_emergency_contacts_and_responsible_parties.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260523010000_client_emergency_contacts_and_responsible_parties_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('client contacts migration', () => {
  describe('client_emergency_contacts table', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.client_emergency_contacts/);
    });

    it('carries NOT NULL org_id with FK + default_org_id() default (Prime Directive #2)', () => {
      expect(sql).toMatch(
        /client_emergency_contacts[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s*\n?\s*REFERENCES public\.organizations\(id\)/,
      );
      expect(sql).toMatch(/idx_client_emergency_contacts_org/);
    });

    it('FK-cascades on client delete (no orphan contacts)', () => {
      expect(sql).toMatch(
        /client_id\s+text NOT NULL REFERENCES public\.clients\(id\) ON DELETE CASCADE/,
      );
    });

    it('captures the fields the intake form sends', () => {
      expect(sql).toMatch(/name\s+text NOT NULL/);
      expect(sql).toMatch(/phone\s+text NOT NULL/);
      expect(sql).toMatch(/priority\s+integer NOT NULL DEFAULT 1/);
      expect(sql).toMatch(/CHECK \(priority >= 1\)/);
    });

    it('indexes (client_id, priority) for ordered call-list reads', () => {
      expect(sql).toMatch(
        /idx_client_emergency_contacts_client[\s\S]*?\(client_id, priority\)/,
      );
    });

    it('reuses the public.touch_updated_at() trigger helper', () => {
      expect(sql).toMatch(
        /client_emergency_contacts_touch_updated_at[\s\S]*?EXECUTE FUNCTION public\.touch_updated_at\(\)/,
      );
    });
  });

  describe('client_responsible_parties table', () => {
    it('is created idempotently', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.client_responsible_parties/);
    });

    it('carries NOT NULL org_id with FK + default_org_id() default (Prime Directive #2)', () => {
      expect(sql).toMatch(
        /client_responsible_parties[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s*\n?\s*REFERENCES public\.organizations\(id\)/,
      );
      expect(sql).toMatch(/idx_client_responsible_parties_org/);
    });

    it('enforces one primary + one secondary per client', () => {
      expect(sql).toMatch(/rank\s+text NOT NULL[\s\S]*?CHECK \(rank IN \('primary', 'secondary'\)\)/);
      expect(sql).toMatch(/UNIQUE \(client_id, rank\)/);
    });

    it('enforces at most one main point of contact per client (partial unique index)', () => {
      expect(sql).toMatch(
        /uq_client_main_point_of_contact[\s\S]*?ON public\.client_responsible_parties \(client_id\)[\s\S]*?WHERE is_main_point_of_contact/,
      );
    });

    it('mirrors the existing care-plan RP convention (POA flags, contact_for multiselect)', () => {
      expect(sql).toMatch(/contact_for\s+text\[\] NOT NULL DEFAULT '\{\}'::text\[\]/);
      expect(sql).toMatch(/hipaa_on_file\s+boolean NOT NULL DEFAULT false/);
      expect(sql).toMatch(/financial_poa\s+boolean NOT NULL DEFAULT false/);
      expect(sql).toMatch(/healthcare_poa\s+boolean NOT NULL DEFAULT false/);
      expect(sql).toMatch(/is_main_point_of_contact\s+boolean NOT NULL DEFAULT false/);
    });
  });

  describe('RLS', () => {
    it('enables RLS on both tables', () => {
      expect(sql).toMatch(/ALTER TABLE public\.client_emergency_contacts\s+ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/ALTER TABLE public\.client_responsible_parties\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('every CRUD policy gates on is_staff() + tenant org match — no inline EXISTS subqueries', () => {
      // 4 commands × 2 tables = 8 policies. Each one must reference
      // both is_staff() and the JWT org_id check, never a bare
      // EXISTS (SELECT ... FROM user_roles ...) — docs/RLS_GOTCHAS.md.
      for (const table of ['client_emergency_contacts', 'client_responsible_parties']) {
        for (const cmd of ['select', 'insert', 'update', 'delete']) {
          const policyName = new RegExp(`${table}_staff_${cmd}[\\s\\S]*?public\\.is_staff\\(\\)[\\s\\S]*?org_id = nullif\\(\\(auth\\.jwt\\(\\) ->> 'org_id'\\), ''\\)::uuid`);
          expect(sql).toMatch(policyName);
        }
      }
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+user_roles/);
    });
  });

  describe('realtime + sanity', () => {
    it('publishes both tables to supabase_realtime (idempotent)', () => {
      expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.client_emergency_contacts/);
      expect(sql).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.client_responsible_parties/);
    });

    it('has a sanity-check DO block that fails loudly if a table is missing', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'client contacts migration: one or both target tables missing/);
    });
  });

  describe('rollback', () => {
    it('drops every policy by name (matches forward-policy names exactly)', () => {
      for (const table of ['client_emergency_contacts', 'client_responsible_parties']) {
        for (const cmd of ['select', 'insert', 'update', 'delete']) {
          const name = `${table}_staff_${cmd}`;
          expect(rollbackSql).toContain(name);
        }
      }
    });

    it('drops both tables (in dependency-safe order)', () => {
      expect(rollbackSql).toMatch(/DROP TABLE IF EXISTS public\.client_responsible_parties/);
      expect(rollbackSql).toMatch(/DROP TABLE IF EXISTS public\.client_emergency_contacts/);
    });
  });
});
