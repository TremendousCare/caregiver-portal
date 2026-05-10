/**
 * Phase 1.2 — autonomy_profile v2 backfill migration.
 *
 * Structural assertions on the migration file. Same approach as the other
 * Agent Platform migration specs: the migration's own DO smoke (`v_missing
 * > 0 → RAISE`) is the runtime safety net; this spec catches accidental
 * deletion or mutation of that guard or the merge logic in future PRs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260510130000_agent_platform_phase_1_2_autonomy_v2_profile.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');

describe('Phase 1.2 — autonomy_profile v2 backfill migration', () => {
  describe('safety posture', () => {
    it('contains no DROP / DELETE / TRUNCATE statements', () => {
      // Production safety: this is a backfill, not a destructive change.
      const banned = ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE'];
      for (const stmt of banned) {
        expect(sql, `migration must not contain "${stmt}"`).not.toMatch(
          new RegExp(stmt, 'i')
        );
      }
    });

    it('does not bump agents.version', () => {
      // Operational backfill ≠ user manifest edit. Per the migration's
      // header comment.
      expect(sql).not.toMatch(/SET\s+version\s*=/i);
    });

    it('uses updated_by = system:phase_1_2_migration as the audit marker', () => {
      expect(sql).toMatch(/'system:phase_1_2_migration'/);
    });
  });

  describe('idempotency', () => {
    it('uses COALESCE-with-default to layer in only missing keys', () => {
      // The merge MUST pull the existing inner value first, then default
      // — re-running the migration should be a no-op if the keys already
      // have v2 values.
      const v2Keys = [
        'max_level',
        'lookback_window',
        'promotion_thresholds',
        'demote_on_harmful',
        'lockout_hours_after_demote',
      ];
      for (const k of v2Keys) {
        expect(sql, `expected COALESCE for ${k}`).toMatch(
          new RegExp(`COALESCE\\([^)]*${k}[^)]*\\)`, 'i')
        );
      }
    });

    it('preserves the original entry value with the || jsonb merge operator', () => {
      // Each merge starts with `kv.value || jsonb_build_object(...)` —
      // so existing keys (including current_level) carry through and
      // any custom admin keys are preserved.
      const matches = sql.match(/kv\.value\s*\|\|\s*jsonb_build_object/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('v2 default values', () => {
    it('seeds L1->L2 thresholds at min_consecutive=5, success>=0.80, sample>=10', () => {
      expect(sql).toMatch(/'L1->L2'/);
      expect(sql).toMatch(/'min_consecutive',\s*5/);
      expect(sql).toMatch(/'min_success_rate',\s*0\.80/);
      expect(sql).toMatch(/'min_sample',\s*10/);
    });

    it('seeds L2->L3 thresholds at min_consecutive=10, success>=0.90, sample>=30', () => {
      expect(sql).toMatch(/'L2->L3'/);
      expect(sql).toMatch(/'min_consecutive',\s*10/);
      expect(sql).toMatch(/'min_success_rate',\s*0\.90/);
      expect(sql).toMatch(/'min_sample',\s*30/);
    });

    it('seeds L3->L4 thresholds at min_consecutive=20, success>=0.95, sample>=100', () => {
      expect(sql).toMatch(/'L3->L4'/);
      expect(sql).toMatch(/'min_consecutive',\s*20/);
      expect(sql).toMatch(/'min_success_rate',\s*0\.95/);
      expect(sql).toMatch(/'min_sample',\s*100/);
    });

    it('seeds max_level at L4 (system-wide ceiling per VISION.md prime directive #5)', () => {
      // Per-agent caps live on the manifest; this is the platform default
      // ceiling that admins can lower but not raise.
      expect(sql).toMatch(/'L4'::text\s+AS\s+max_level/i);
    });

    it('seeds lookback_window at 50', () => {
      expect(sql).toMatch(/50::int\s+AS\s+lookback_window/i);
    });

    it('seeds demote_on_harmful at true', () => {
      expect(sql).toMatch(/true::boolean\s+AS\s+demote_on_harmful/i);
    });

    it('seeds lockout_hours_after_demote at 24', () => {
      expect(sql).toMatch(/24::int\s+AS\s+lockout_hours_after_demote/i);
    });
  });

  describe('runtime smoke', () => {
    it('contains a DO block that aborts when any v2 key is missing', () => {
      expect(sql).toMatch(/DO\s+\$\$/);
      expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*Phase 1\.2 backfill smoke failed/);
    });

    it('checks every required v2 key exists on every action entry', () => {
      const required = [
        'current_level',
        'max_level',
        'lookback_window',
        'promotion_thresholds',
        'demote_on_harmful',
        'lockout_hours_after_demote',
      ];
      for (const key of required) {
        expect(sql, `smoke must check for "${key}"`).toMatch(
          new RegExp(`kv\\.value\\s*\\?\\s*'${key}'`)
        );
      }
    });
  });

  describe('targeting', () => {
    it('only updates rows where autonomy_profile is a JSON object', () => {
      // Defense against agents with a NULL or non-object profile —
      // the migration should skip them rather than crash.
      expect(sql).toMatch(/jsonb_typeof\(a\.autonomy_profile\)\s*=\s*'object'/i);
    });
  });
});
