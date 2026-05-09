import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Phase 0.5 PR A migration. Runtime
// behaviour (admin gate, org isolation, audit row) is verified by the
// migration's own sanity DO block and by manual smoke testing pre-merge.
// These specs catch accidental drift in future PRs that touch this RPC.
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260510010000_agent_platform_phase_0_5_pr_a_toggle_agent_flag_rpc.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260510010000_agent_platform_phase_0_5_pr_a_toggle_agent_flag_rpc_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('Phase 0.5 PR A — toggle_agent_flag_v1 RPC migration', () => {
  describe('function definition', () => {
    it('creates toggle_agent_flag_v1 with the locked signature', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.toggle_agent_flag_v1\(\s*p_agent_id uuid,\s*p_flag\s+text,\s*p_value\s+boolean\s*\)/
      );
    });

    it('returns boolean (the new value, for optimistic UI reconciliation)', () => {
      expect(sql).toMatch(/RETURNS boolean/);
    });

    it('is SECURITY DEFINER with explicit search_path', () => {
      expect(sql).toMatch(/SECURITY DEFINER/);
      expect(sql).toMatch(/SET search_path = public/);
    });

    it('is plpgsql (needs control flow + RAISE)', () => {
      expect(sql).toMatch(/LANGUAGE plpgsql/);
    });
  });

  describe('admin gate (locked D11 — RPC enforces admin role)', () => {
    it('calls public.is_admin() and raises 42501 on failure', () => {
      expect(sql).toMatch(/IF NOT public\.is_admin\(\) THEN/);
      expect(sql).toMatch(/permission denied: not an admin/);
      expect(sql).toMatch(/USING ERRCODE = '42501'/);
    });
  });

  describe('flag-name validation', () => {
    it('rejects flag names other than kill_switch and shadow_mode', () => {
      expect(sql).toMatch(/p_flag NOT IN \('kill_switch', 'shadow_mode'\)/);
      expect(sql).toMatch(/invalid flag/);
    });
  });

  describe('tenant isolation', () => {
    it('reads org_id from the JWT claim', () => {
      expect(sql).toMatch(/auth\.jwt\(\) ->> 'org_id'/);
    });

    it('rejects calls when JWT is missing org_id', () => {
      expect(sql).toMatch(/JWT missing org_id claim/);
    });

    it('rejects cross-org calls (locked: per-org agents only)', () => {
      expect(sql).toMatch(/agent org mismatch/);
    });
  });

  describe('agent lookup', () => {
    it('raises P0002 when agent not found', () => {
      expect(sql).toMatch(/agent not found/);
      expect(sql).toMatch(/USING ERRCODE = 'P0002'/);
    });
  });

  describe('update behaviour (locked D4 — no version increment on toggle)', () => {
    it('does not touch agents.version', () => {
      // Crude check: no UPDATE statement should set version. Our two
      // UPDATEs target kill_switch / shadow_mode + updated_by only.
      expect(sql).not.toMatch(/SET\s+version\s*=/);
    });

    it('updates kill_switch when p_flag = kill_switch', () => {
      expect(sql).toMatch(/SET kill_switch = p_value/);
    });

    it('updates shadow_mode when p_flag = shadow_mode', () => {
      expect(sql).toMatch(/SET shadow_mode = p_value/);
    });

    it('sets updated_by from the JWT email', () => {
      expect(sql).toMatch(/updated_by\s*=\s*v_actor/);
      expect(sql).toMatch(/auth\.jwt\(\) ->> 'email'/);
    });
  });

  describe('audit (locked D5 — events row on toggle)', () => {
    it('writes one events row with event_type=agent_flag_toggled', () => {
      expect(sql).toMatch(/INSERT INTO public\.events/);
      expect(sql).toMatch(/'agent_flag_toggled'/);
    });

    it('stamps agent_id on the events row (Phase 0.4 contract)', () => {
      expect(sql).toMatch(/agent_id,\s*event_type/);
    });

    it('skips the audit row on no-op transitions (idempotent toggle)', () => {
      expect(sql).toMatch(/v_prior_value IS DISTINCT FROM p_value/);
    });

    it('records flag, prior_value, and new_value in payload', () => {
      expect(sql).toMatch(/'flag',\s*p_flag/);
      expect(sql).toMatch(/'prior_value',\s*v_prior_value/);
      expect(sql).toMatch(/'new_value',\s*p_value/);
    });
  });

  describe('grants', () => {
    it('revokes EXECUTE from PUBLIC and grants to authenticated', () => {
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.toggle_agent_flag_v1\(uuid, text, boolean\) FROM PUBLIC/
      );
      expect(sql).toMatch(
        /GRANT\s+EXECUTE ON FUNCTION public\.toggle_agent_flag_v1\(uuid, text, boolean\) TO authenticated/
      );
    });
  });

  describe('sanity check (deploy guard)', () => {
    it('aborts deploy if function landed without SECURITY DEFINER', () => {
      expect(sql).toMatch(/proname = 'toggle_agent_flag_v1'/);
      expect(sql).toMatch(/prosecdef = true/);
      expect(sql).toMatch(/RAISE EXCEPTION/);
    });
  });

  describe('rollback', () => {
    it('drops the function', () => {
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.toggle_agent_flag_v1\(uuid, text, boolean\)/
      );
    });
  });

  describe('recursion safety (per user_roles incident)', () => {
    it('uses public.is_admin() helper (not inline EXISTS over user_roles)', () => {
      // The inline-EXISTS-on-user_roles pattern from hotfixes #289/#290
      // would look like this — assert it's NOT present.
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT.*FROM\s+user_roles/i);
    });
  });
});
