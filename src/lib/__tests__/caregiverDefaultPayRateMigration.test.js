// Structural assertions on migration 20260526000000_caregiver_default_pay_rate.
//
// Locks in: column additions are ADD COLUMN IF NOT EXISTS (idempotent),
// backfill is null-only (never overwrites), trigger is BEFORE on the
// right columns, SECURITY DEFINER + pinned search_path, org_id guard
// is present, rollback drops in FK-safe order.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260526000000_caregiver_default_pay_rate.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260526000000_caregiver_default_pay_rate_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('caregiver default pay rate migration', () => {
  describe('columns', () => {
    it('adds default_pay_rate idempotently', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.caregivers\s*\n\s*ADD COLUMN IF NOT EXISTS default_pay_rate\s+numeric\(10,2\)/,
      );
    });

    it('adds default_pay_ot_rate idempotently', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.caregivers\s*\n\s*ADD COLUMN IF NOT EXISTS default_pay_ot_rate\s+numeric\(10,2\)/,
      );
    });

    it('uses (10,2) precision to match clients.default_billable_rate', () => {
      // Defending against a future hand-edit that changes precision —
      // payroll's per-rate aggregation joins shifts.hourly_rate (10,2)
      // and caregivers.default_pay_rate, so precision must match.
      const matches = sql.match(/numeric\(10,2\)/g);
      expect(matches).not.toBeNull();
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('both columns are nullable (no NOT NULL clause)', () => {
      // CLAUDE.md Prime Directives: nullable → backfill → NOT NULL.
      // v1 stops at nullable + backfill. NOT NULL would break existing
      // code that creates caregivers without a rate.
      expect(sql).not.toMatch(/default_pay_rate\s+numeric\(10,2\)\s+NOT NULL/);
      expect(sql).not.toMatch(/default_pay_ot_rate\s+numeric\(10,2\)\s+NOT NULL/);
    });
  });

  describe('backfill', () => {
    it('UPDATEs only where default_pay_rate IS NULL', () => {
      expect(sql).toMatch(
        /UPDATE public\.caregivers\s*\n\s*SET default_pay_rate = proposed_pay_rate\s*\n\s*WHERE default_pay_rate IS NULL\s*\n\s*AND proposed_pay_rate IS NOT NULL/,
      );
    });

    it('does NOT backfill default_pay_ot_rate (clients.default_billable_ot_rate has no proposed-rate source)', () => {
      // proposed_pay_rate is a single regular rate; no OT proposed
      // rate exists. Backfilling OT would copy regular into OT, which
      // is wrong (OT is typically 1.5× regular). Better empty than
      // wrong.
      expect(sql).not.toMatch(/SET default_pay_ot_rate = /);
    });
  });

  describe('trigger', () => {
    it('function is SECURITY DEFINER with pinned search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.auto_fill_shift_rates_from_defaults\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path TO 'public'/,
      );
    });

    it('fires BEFORE INSERT OR UPDATE on the right columns', () => {
      expect(sql).toMatch(
        /CREATE TRIGGER shifts_auto_fill_rates\s+BEFORE INSERT OR UPDATE OF assigned_caregiver_id, client_id, hourly_rate, billable_rate\s+ON public\.shifts/,
      );
    });

    it('only fills hourly_rate when NULL (never overwrites)', () => {
      expect(sql).toMatch(/IF NEW\.hourly_rate IS NULL AND NEW\.assigned_caregiver_id IS NOT NULL THEN/);
    });

    it('only fills billable_rate when NULL (never overwrites)', () => {
      expect(sql).toMatch(/IF NEW\.billable_rate IS NULL AND NEW\.client_id IS NOT NULL THEN/);
    });

    it('caregiver lookup is org-scoped (defense-in-depth for Phase B)', () => {
      expect(sql).toMatch(/FROM public\.caregivers c\s*\n\s*WHERE c\.id = NEW\.assigned_caregiver_id\s*\n\s*AND \(NEW\.org_id IS NULL OR c\.org_id = NEW\.org_id\)/);
    });

    it('client lookup is org-scoped (defense-in-depth for Phase B)', () => {
      expect(sql).toMatch(/FROM public\.clients cl\s*\n\s*WHERE cl\.id = NEW\.client_id\s*\n\s*AND \(NEW\.org_id IS NULL OR cl\.org_id = NEW\.org_id\)/);
    });

    it('skips IF v_caregiver_rate IS NOT NULL (no NULL-overwrite)', () => {
      expect(sql).toMatch(/IF v_caregiver_rate IS NOT NULL THEN/);
      expect(sql).toMatch(/IF v_client_rate IS NOT NULL THEN/);
    });

    it('REVOKEs PUBLIC + GRANTs only to authenticated + service_role', () => {
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.auto_fill_shift_rates_from_defaults\(\) FROM PUBLIC/);
      expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.auto_fill_shift_rates_from_defaults\(\)\s*\n?\s*TO authenticated, service_role/);
    });

    it('trigger is DROP IF EXISTS before CREATE (idempotent)', () => {
      expect(sql).toMatch(/DROP TRIGGER IF EXISTS shifts_auto_fill_rates ON public\.shifts/);
    });

    it('returns NEW (BEFORE trigger contract)', () => {
      expect(sql).toMatch(/RETURN NEW;\s*\n*END\s*\n\$\$/);
    });
  });

  describe('sanity', () => {
    it('fails the deploy if either column is missing', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'caregiver default pay rate: caregivers\.default_pay_rate missing/);
      expect(sql).toMatch(/RAISE EXCEPTION 'caregiver default pay rate: caregivers\.default_pay_ot_rate missing/);
    });

    it('fails the deploy if the trigger is missing', () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'caregiver default pay rate: shifts_auto_fill_rates trigger missing/);
    });
  });

  describe('rollback', () => {
    it('drops trigger then function then columns (FK-safe order)', () => {
      const triggerIdx = rollbackSql.indexOf('DROP TRIGGER IF EXISTS shifts_auto_fill_rates');
      const funcIdx    = rollbackSql.indexOf('DROP FUNCTION IF EXISTS public.auto_fill_shift_rates_from_defaults');
      const colIdx     = rollbackSql.indexOf('DROP COLUMN IF EXISTS default_pay_rate');
      expect(triggerIdx).toBeGreaterThanOrEqual(0);
      expect(funcIdx).toBeGreaterThan(triggerIdx);
      expect(colIdx).toBeGreaterThan(funcIdx);
    });

    it('drops both columns (regular + OT)', () => {
      expect(rollbackSql).toMatch(/DROP COLUMN IF EXISTS default_pay_rate/);
      expect(rollbackSql).toMatch(/DROP COLUMN IF EXISTS default_pay_ot_rate/);
    });
  });
});
