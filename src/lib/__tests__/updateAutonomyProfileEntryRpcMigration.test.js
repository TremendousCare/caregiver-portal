/**
 * Phase 1.2 (Codex P2 fix) — `update_autonomy_profile_entry_v1` RPC.
 *
 * Structural assertions on the migration that adds the atomic single-key
 * `autonomy_profile` update RPC. The RPC's own `RAISE EXCEPTION` paths
 * are the runtime safety net; this spec catches accidental deletion or
 * mutation of the security posture (SECURITY DEFINER, REVOKE/GRANT,
 * jsonb_set semantics) in future PRs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260510140000_agent_platform_phase_1_2_update_autonomy_profile_entry_rpc.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');

describe('Phase 1.2 — update_autonomy_profile_entry_v1 RPC migration', () => {
  describe('safety posture', () => {
    it('declares the function SECURITY DEFINER', () => {
      // Same posture as record_agent_action_v1, toggle_agent_flag_v1.
      expect(sql).toMatch(/SECURITY DEFINER/);
    });

    it('pins search_path to public to prevent search-path hijacking', () => {
      expect(sql).toMatch(/SET search_path = public/);
    });

    it('REVOKEs from PUBLIC and authenticated', () => {
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.update_autonomy_profile_entry_v1[^\n]*FROM PUBLIC/);
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.update_autonomy_profile_entry_v1[^\n]*FROM authenticated/);
    });

    it('GRANTs EXECUTE only to service_role', () => {
      expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.update_autonomy_profile_entry_v1[^\n]*TO service_role/);
      // Defense: no grant to authenticated/anon by accident.
      expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO authenticated/i);
      expect(sql).not.toMatch(/GRANT EXECUTE[^\n]*TO anon/i);
    });

    it('contains no DROP / DELETE / TRUNCATE', () => {
      const banned = ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE'];
      for (const stmt of banned) {
        expect(sql, `must not contain "${stmt}"`).not.toMatch(
          new RegExp(stmt, 'i')
        );
      }
    });
  });

  describe('input validation', () => {
    it('validates p_agent_id is non-null', () => {
      expect(sql).toMatch(/p_agent_id IS NULL/);
    });

    it('validates p_action_type is non-empty', () => {
      expect(sql).toMatch(/p_action_type IS NULL OR length\(p_action_type\) = 0/);
    });

    it('validates p_entry is a JSON object', () => {
      expect(sql).toMatch(/jsonb_typeof\(p_entry\)\s*<>\s*'object'/);
    });
  });

  describe('atomic merge semantics', () => {
    it('uses jsonb_set with the action_type as the path key', () => {
      // ARRAY[p_action_type] is the path argument to jsonb_set.
      expect(sql).toMatch(/jsonb_set\([\s\S]*ARRAY\[p_action_type\][\s\S]*\)/);
    });

    it('COALESCEs autonomy_profile to {} so a NULL column does not silently wipe', () => {
      expect(sql).toMatch(/COALESCE\(autonomy_profile,\s*'{}'::jsonb\)/);
    });

    it('passes create_missing=true to jsonb_set so new keys are added, not skipped', () => {
      // jsonb_set's 4th argument; defaults to true but explicit is safer.
      expect(sql).toMatch(/jsonb_set\([\s\S]*true[\s\S]*\)\s*,/);
    });

    it('does NOT bump agents.version (operational change, not manifest edit)', () => {
      expect(sql).not.toMatch(/SET\s+(autonomy_profile[^,]*,\s*)?version\s*=/i);
    });

    it('raises P0002 (no_data_found) when the agent_id is unknown', () => {
      expect(sql).toMatch(/agent not found/);
      expect(sql).toMatch(/'P0002'/);
    });
  });
});
