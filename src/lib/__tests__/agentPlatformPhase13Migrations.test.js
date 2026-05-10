/**
 * Phase 1.3 — structural assertions on the two migrations.
 *
 *   1. `20260510150000_…_read_only_mode_column.sql`
 *      Adds `agents.read_only_mode boolean NOT NULL DEFAULT false`.
 *
 *   2. `20260510160000_…_toggle_agent_flag_extend.sql`
 *      Extends `toggle_agent_flag_v1` to accept the new flag value.
 *
 * Same approach as the other Agent Platform migration specs: the
 * migration's own DO smoke is the runtime safety net; this spec catches
 * accidental deletion or mutation of that guard or the merge logic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COLUMN_SQL = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260510150000_agent_platform_phase_1_3_read_only_mode_column.sql'),
  'utf-8',
);
const RPC_SQL = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260510160000_agent_platform_phase_1_3_toggle_agent_flag_extend.sql'),
  'utf-8',
);

describe('Phase 1.3 — read_only_mode column migration', () => {
  describe('safety posture', () => {
    it('contains no DROP / DELETE / TRUNCATE statements', () => {
      const banned = ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE'];
      for (const stmt of banned) {
        expect(COLUMN_SQL, `must not contain "${stmt}"`).not.toMatch(
          new RegExp(stmt, 'i')
        );
      }
    });

    it('uses ADD COLUMN IF NOT EXISTS for idempotency', () => {
      expect(COLUMN_SQL).toMatch(/ADD COLUMN IF NOT EXISTS read_only_mode/);
    });
  });

  describe('column shape', () => {
    it('declares boolean NOT NULL DEFAULT false', () => {
      expect(COLUMN_SQL).toMatch(
        /read_only_mode boolean NOT NULL DEFAULT false/
      );
    });

    it('attaches a COMMENT explaining the semantics', () => {
      expect(COLUMN_SQL).toMatch(/COMMENT ON COLUMN public\.agents\.read_only_mode/);
    });
  });

  describe('runtime smoke', () => {
    it('contains a DO block that aborts if the column is missing or wrong shape', () => {
      expect(COLUMN_SQL).toMatch(/DO\s+\$\$/);
      expect(COLUMN_SQL).toMatch(/RAISE EXCEPTION[\s\S]*read_only_mode missing/);
      expect(COLUMN_SQL).toMatch(/RAISE EXCEPTION[\s\S]*wrong type/);
      expect(COLUMN_SQL).toMatch(/RAISE EXCEPTION[\s\S]*must be NOT NULL/);
      expect(COLUMN_SQL).toMatch(/RAISE EXCEPTION[\s\S]*default must be false/);
    });
  });
});

describe('Phase 1.3 — toggle_agent_flag_v1 extend migration', () => {
  describe('safety posture', () => {
    it('uses CREATE OR REPLACE (preserves the function signature)', () => {
      expect(RPC_SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.toggle_agent_flag_v1/);
    });

    it('keeps SECURITY DEFINER + pinned search_path', () => {
      expect(RPC_SQL).toMatch(/SECURITY DEFINER/);
      expect(RPC_SQL).toMatch(/SET search_path = public/);
    });

    it('contains no DROP / DELETE / TRUNCATE statements', () => {
      const banned = ['DROP FUNCTION', 'DROP TABLE', 'DELETE FROM', 'TRUNCATE'];
      for (const stmt of banned) {
        expect(RPC_SQL, `must not contain "${stmt}"`).not.toMatch(
          new RegExp(stmt, 'i')
        );
      }
    });

    it('preserves admin-only gate via is_admin()', () => {
      expect(RPC_SQL).toMatch(/IF NOT public\.is_admin\(\)/);
    });

    it('preserves JWT org_id check', () => {
      expect(RPC_SQL).toMatch(/JWT missing org_id claim/);
      expect(RPC_SQL).toMatch(/agent org mismatch/);
    });

    it('preserves the FOR UPDATE row lock', () => {
      expect(RPC_SQL).toMatch(/FOR UPDATE/);
    });
  });

  describe('flag validation', () => {
    it('accepts kill_switch, shadow_mode, AND read_only_mode (Phase 1.3)', () => {
      expect(RPC_SQL).toMatch(
        /p_flag NOT IN \('kill_switch',\s*'shadow_mode',\s*'read_only_mode'\)/
      );
    });

    it('has a dedicated UPDATE branch for read_only_mode', () => {
      expect(RPC_SQL).toMatch(/'read_only_mode'/);
      expect(RPC_SQL).toMatch(/SET read_only_mode = p_value/);
    });

    it('SELECT pulls read_only_mode alongside kill_switch and shadow_mode', () => {
      expect(RPC_SQL).toMatch(
        /SELECT a\.id,\s*a\.org_id,\s*a\.kill_switch,\s*a\.shadow_mode,\s*a\.read_only_mode/
      );
    });
  });

  describe('audit trail', () => {
    it('writes agent_flag_toggled events with the new flag in payload', () => {
      // The function builds a single events INSERT using p_flag verbatim,
      // so read_only_mode toggles are audited identically.
      expect(RPC_SQL).toMatch(/'agent_flag_toggled'/);
      expect(RPC_SQL).toMatch(/'flag',\s*p_flag/);
    });

    it('skips audit row on no-op transitions', () => {
      expect(RPC_SQL).toMatch(/IF v_prior_value IS DISTINCT FROM p_value/);
    });
  });

  describe('grants', () => {
    it('REVOKEs from PUBLIC and GRANTs to authenticated', () => {
      expect(RPC_SQL).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.toggle_agent_flag_v1[^\n]*FROM PUBLIC/
      );
      expect(RPC_SQL).toMatch(
        /GRANT\s+EXECUTE ON FUNCTION public\.toggle_agent_flag_v1[^\n]*TO authenticated/
      );
    });
  });

  describe('runtime smoke', () => {
    it('contains a DO block that aborts if the function is missing or not SECURITY DEFINER', () => {
      expect(RPC_SQL).toMatch(/RAISE EXCEPTION[\s\S]*toggle_agent_flag_v1 missing or not SECURITY DEFINER/);
    });
  });
});
