// Phase 1.1.A — structural tests for the agent_actions migrations.
// Runtime behaviour is verified by the migrations' own DO blocks +
// manual smoke + the helper unit tests. These specs catch accidental
// drift in future PRs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../../supabase/migrations');
const rollbackDir   = join(migrationsDir, '_rollback');

const tableSql      = readFileSync(join(migrationsDir, '20260510050000_agent_platform_phase_1_1_a_agent_actions_table.sql'), 'utf-8');
const tableDownSql  = readFileSync(join(rollbackDir,   '20260510050000_agent_platform_phase_1_1_a_agent_actions_table_down.sql'), 'utf-8');
const rpcSql        = readFileSync(join(migrationsDir, '20260510060000_agent_platform_phase_1_1_a_record_agent_action_rpc.sql'), 'utf-8');
const rpcDownSql    = readFileSync(join(rollbackDir,   '20260510060000_agent_platform_phase_1_1_a_record_agent_action_rpc_down.sql'), 'utf-8');

describe('Phase 1.1.A — agent_actions table migration', () => {
  describe('structure', () => {
    it('creates the table', () => {
      expect(tableSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.agent_actions/);
    });

    it('has every locked-spec column', () => {
      const requiredFields = [
        'id', 'org_id', 'agent_id', 'agent_version',
        'action_type', 'phase', 'entity_type', 'entity_id',
        'actor', 'payload', 'outcome_id', 'created_at',
        'prev_hash', 'row_hash', 'signature',
      ];
      for (const f of requiredFields) {
        expect(tableSql, `missing column ${f}`).toMatch(
          new RegExp(`\\b${f}\\b\\s+(uuid|text|integer|jsonb|timestamptz)`)
        );
      }
    });

    it('FKs to organizations, agents, action_outcomes', () => {
      expect(tableSql).toMatch(/REFERENCES public\.organizations\(id\)/);
      expect(tableSql).toMatch(/REFERENCES public\.agents\(id\)/);
      expect(tableSql).toMatch(/REFERENCES public\.action_outcomes\(id\)/);
    });

    it('row_hash is UNIQUE (catches accidental duplicate writes)', () => {
      expect(tableSql).toMatch(/row_hash\s+text\s+NOT NULL\s+UNIQUE/);
    });

    it('phase is constrained to the locked lifecycle values', () => {
      expect(tableSql).toMatch(/phase\s+IN\s*\(\s*'suggested',\s*'confirmed',\s*'executed',\s*'auto_executed',\s*'rejected',\s*'expired',\s*'shadow'\s*\)/);
    });

    it('entity_type matches the events table check (caregiver|client|null)', () => {
      expect(tableSql).toMatch(/entity_type IS NULL OR entity_type IN \('caregiver',\s*'client'\)/);
    });

    it('agent_version has a positive-integer CHECK', () => {
      expect(tableSql).toMatch(/agent_version[\s\S]*?CHECK\s*\(\s*agent_version\s*>=\s*1\s*\)/);
    });
  });

  describe('indexes', () => {
    it('chain walk index by org × created_at DESC', () => {
      expect(tableSql).toMatch(/idx_agent_actions_org_chain[\s\S]*?\(org_id,\s*created_at DESC\)/);
    });
    it('per-agent forensics index', () => {
      expect(tableSql).toMatch(/idx_agent_actions_agent_chain[\s\S]*?\(agent_id,\s*created_at DESC\)/);
    });
    it('outcome partial index', () => {
      expect(tableSql).toMatch(/idx_agent_actions_outcome[\s\S]*?WHERE outcome_id IS NOT NULL/);
    });
  });

  describe('RLS + lockdown', () => {
    it('enables RLS', () => {
      expect(tableSql).toMatch(/ALTER TABLE public\.agent_actions\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('creates a tenant-isolation SELECT policy', () => {
      expect(tableSql).toMatch(/tenant_isolation_agent_actions_select/);
      expect(tableSql).toMatch(/FOR SELECT TO authenticated/);
    });

    it('does NOT create INSERT/UPDATE/DELETE policies (writes go through RPC only)', () => {
      expect(tableSql).not.toMatch(/tenant_isolation_agent_actions_insert/);
      expect(tableSql).not.toMatch(/tenant_isolation_agent_actions_update/);
      expect(tableSql).not.toMatch(/tenant_isolation_agent_actions_delete/);
    });

    it('REVOKEs INSERT/UPDATE/DELETE from authenticated (lockdown)', () => {
      // Same security regression assertion as PR B's lockdown spec.
      const privs = ['INSERT', 'UPDATE', 'DELETE'];
      for (const p of privs) {
        expect(tableSql, `must revoke ${p}`).toMatch(
          new RegExp(`REVOKE[^;]*\\b${p}\\b[^;]*ON public\\.agent_actions[^;]*FROM authenticated`, 'i')
        );
      }
    });

    it('does NOT revoke SELECT (admins still need to read)', () => {
      expect(tableSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agent_actions/i);
    });

    it('has a sanity DO block guarding the lockdown', () => {
      expect(tableSql).toMatch(/information_schema\.table_privileges/);
      expect(tableSql).toMatch(/RAISE EXCEPTION/);
    });
  });

  describe('rollback', () => {
    it('drops the table CASCADE', () => {
      expect(tableDownSql).toMatch(/DROP TABLE IF EXISTS public\.agent_actions CASCADE/);
    });
  });
});

describe('Phase 1.1.A — record_agent_action_v1 RPC migration', () => {
  describe('signature', () => {
    it('has 14 parameters in the locked order (including p_created_at)', () => {
      // p_created_at was added to fix Codex P1 #1: the hash includes
      // created_at_ns, so the timestamp the caller signs must equal
      // what the row stores. Pre-fix the RPC let DEFAULT now() fill
      // created_at, drifting from the signed value.
      expect(rpcSql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.record_agent_action_v1\([\s\S]*?p_org_id\s+uuid,[\s\S]*?p_agent_id\s+uuid,[\s\S]*?p_agent_version\s+integer,[\s\S]*?p_action_type\s+text,[\s\S]*?p_phase\s+text,[\s\S]*?p_entity_type\s+text,[\s\S]*?p_entity_id\s+uuid,[\s\S]*?p_actor\s+text,[\s\S]*?p_payload\s+jsonb,[\s\S]*?p_outcome_id\s+uuid,[\s\S]*?p_created_at\s+timestamptz,[\s\S]*?p_claimed_prev_hash\s+text,[\s\S]*?p_row_hash\s+text,[\s\S]*?p_signature\s+text/
      );
    });

    it('INSERTs p_created_at explicitly (no DEFAULT now() drift)', () => {
      // The INSERT must include the created_at column so the
      // caller-supplied (and signed) timestamp lands on the row.
      expect(rpcSql).toMatch(/INSERT INTO public\.agent_actions[\s\S]*?created_at,[\s\S]*?\)\s*VALUES[\s\S]*?p_created_at/);
    });

    it('rejects NULL p_created_at', () => {
      expect(rpcSql).toMatch(/p_created_at IS NULL/);
      expect(rpcSql).toMatch(/p_created_at is required/);
    });

    it('bounds p_created_at to ±5 minutes from server now() (anti-backdate)', () => {
      expect(rpcSql).toMatch(/abs\(extract\(epoch from \(now\(\) - p_created_at\)\)\) > 300/);
      expect(rpcSql).toMatch(/p_created_at out of range/);
    });

    it('returns uuid (the new row id)', () => {
      expect(rpcSql).toMatch(/RETURNS uuid/);
    });

    it('is SECURITY DEFINER with explicit search_path', () => {
      expect(rpcSql).toMatch(/SECURITY DEFINER/);
      expect(rpcSql).toMatch(/SET search_path = public/);
    });
  });

  describe('chain integrity', () => {
    it('takes a per-org advisory lock to serialize writes', () => {
      expect(rpcSql).toMatch(/pg_advisory_xact_lock/);
      expect(rpcSql).toMatch(/hashtext\(p_org_id::text\)/);
    });

    it('reads the actual prev_hash under the lock', () => {
      expect(rpcSql).toMatch(/SELECT row_hash[\s\S]*?FROM public\.agent_actions/);
      expect(rpcSql).toMatch(/ORDER BY created_at DESC/);
    });

    it('treats empty chain (no rows) as genesis (prev_hash = "")', () => {
      expect(rpcSql).toMatch(/v_actual_prev := ''/);
    });

    it('raises agent_actions_chain_conflict (P0001) on prev_hash mismatch', () => {
      expect(rpcSql).toMatch(/agent_actions_chain_conflict/);
      expect(rpcSql).toMatch(/USING ERRCODE = 'P0001'/);
    });
  });

  describe('input validation', () => {
    it('rejects invalid phase', () => {
      expect(rpcSql).toMatch(/p_phase NOT IN \('suggested',\s*'confirmed',\s*'executed',\s*'auto_executed',\s*'rejected',\s*'expired',\s*'shadow'\)/);
    });
    it('requires org_id and agent_id', () => {
      expect(rpcSql).toMatch(/p_org_id IS NULL OR p_agent_id IS NULL/);
    });
    it('requires non-empty action_type, row_hash, signature', () => {
      expect(rpcSql).toMatch(/length\(p_action_type\)\s*=\s*0/);
      expect(rpcSql).toMatch(/length\(p_row_hash\)\s*=\s*0/);
      expect(rpcSql).toMatch(/length\(p_signature\)\s*=\s*0/);
    });
    it('rejects NULL claimed_prev_hash but accepts empty string (genesis)', () => {
      // The check is `p_claimed_prev_hash IS NULL` (rejects null);
      // there's no length() check on it (allows '').
      expect(rpcSql).toMatch(/p_claimed_prev_hash IS NULL/);
      expect(rpcSql).not.toMatch(/length\(p_claimed_prev_hash\)\s*=\s*0/);
    });
  });

  describe('tenant isolation', () => {
    it('verifies JWT org_id matches p_org_id when JWT present', () => {
      expect(rpcSql).toMatch(/auth\.jwt\(\) ->> 'org_id'/);
      expect(rpcSql).toMatch(/JWT org_id does not match p_org_id/);
      expect(rpcSql).toMatch(/USING ERRCODE = '42501'/);
    });
  });

  describe('grants (Codex P1 #2: service_role only — authenticated cannot poison the chain directly)', () => {
    it('revokes from PUBLIC', () => {
      expect(rpcSql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.record_agent_action_v1[\s\S]*?FROM PUBLIC/);
    });

    it('explicitly revokes from authenticated', () => {
      // SECURITY DEFINER chains called from inside other SECURITY
      // DEFINER functions still work because the caller runs as
      // postgres (the function owner), which has implicit EXECUTE.
      // This REVOKE blocks direct supabase.rpc() calls under an
      // authenticated client — which is what would let a non-admin
      // forge audit rows.
      expect(rpcSql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.record_agent_action_v1[\s\S]*?FROM authenticated/);
    });

    it('grants ONLY to service_role', () => {
      expect(rpcSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_agent_action_v1[\s\S]*?TO service_role/);
      // Negative: must not grant back to authenticated.
      expect(rpcSql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.record_agent_action_v1[\s\S]*?TO authenticated\b/);
    });
  });

  describe('sanity check', () => {
    it('aborts deploy if function landed without SECURITY DEFINER', () => {
      expect(rpcSql).toMatch(/proname = 'record_agent_action_v1'/);
      expect(rpcSql).toMatch(/prosecdef = true/);
    });
  });

  describe('rollback', () => {
    it('drops the function with the full signature (14 params including timestamptz)', () => {
      expect(rpcDownSql).toMatch(/DROP FUNCTION IF EXISTS public\.record_agent_action_v1\(\s*uuid,\s*uuid,\s*integer,\s*text,\s*text,\s*text,\s*uuid,\s*text,\s*jsonb,\s*uuid,\s*timestamptz,\s*text,\s*text,\s*text\s*\)/);
    });
  });
});
