import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the QuickBooks integration PR #2
// migration (OAuth handshake). The migration's own DO sanity
// blocks are the runtime safety net; this spec catches accidental
// regression of the security posture in future PRs — in particular
// the service-role-only grants on complete_qb_oauth and
// cleanup_expired_qb_oauth_states.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260529110000_quickbooks_oauth_states.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260529110000_quickbooks_oauth_states_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('QuickBooks integration PR #2 — oauth states migration', () => {
  describe('table structure', () => {
    it('creates the quickbooks_oauth_states table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.quickbooks_oauth_states/);
    });

    it('declares every required column with the right type', () => {
      const requiredFields = [
        ['state_id', 'uuid'],
        ['org_id', 'uuid'],
        ['user_email', 'text'],
        ['environment', 'text'],
        ['created_at', 'timestamptz'],
        ['expires_at', 'timestamptz'],
      ];
      for (const [field, type] of requiredFields) {
        expect(
          sql,
          `missing or mistyped column: ${field} ${type}`
        ).toMatch(new RegExp(`\\b${field}\\b\\s+${type}`));
      }
    });

    it('uses public.default_org_id() for the org_id default', () => {
      expect(sql).toMatch(/org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)/);
    });

    it('defaults expires_at to now + 10 minutes', () => {
      expect(sql).toMatch(
        /expires_at\s+timestamptz NOT NULL DEFAULT \(now\(\) \+ INTERVAL '10 minutes'\)/
      );
    });

    it('enforces the environment CHECK to sandbox|production', () => {
      expect(sql).toMatch(
        /environment\s+text NOT NULL DEFAULT 'sandbox'[\s\S]*?CHECK \(environment IN \('sandbox', 'production'\)\)/
      );
    });

    it('indexes org_id and expires_at (cleanup hot path)', () => {
      expect(sql).toMatch(
        /idx_quickbooks_oauth_states_org\s+ON public\.quickbooks_oauth_states\s*\(org_id\)/
      );
      expect(sql).toMatch(
        /idx_quickbooks_oauth_states_expired\s+ON public\.quickbooks_oauth_states\s*\(expires_at\)/
      );
    });
  });

  describe('RLS', () => {
    it('enables row-level security', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.quickbooks_oauth_states ENABLE ROW LEVEL SECURITY/
      );
    });

    it('creates 4 owner policies (select/insert/update/delete) and NO admin policy', () => {
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(
          sql,
          `missing owner ${cmd} policy`
        ).toMatch(
          new RegExp(
            `CREATE POLICY quickbooks_oauth_states_owner_${cmd} ON public\\.quickbooks_oauth_states`
          )
        );
      }
      // Transient state — admin doesn't get a window into it.
      expect(sql).not.toMatch(/CREATE POLICY quickbooks_oauth_states_admin_/);
    });

    it('uses public.is_owner() + JWT org_id check, no inline EXISTS', () => {
      expect(sql).toMatch(/public\.is_owner\(\)/);
      const inlineExistsOnSelf =
        /USING\s*\([\s\S]*?EXISTS\s*\(\s*SELECT[\s\S]*?FROM\s+public\.quickbooks_oauth_states/i;
      expect(sql).not.toMatch(inlineExistsOnSelf);
    });
  });

  describe('init_qb_oauth_state RPC', () => {
    it('exists with the expected signature and defaults', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.init_qb_oauth_state\(\s*p_environment text DEFAULT 'sandbox'\s*\)/
      );
    });

    it('is SECURITY DEFINER with a pinned search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.init_qb_oauth_state[\s\S]*?SECURITY DEFINER\s+SET search_path = public/
      );
    });

    it('gates on auth + JWT org_id + is_owner', () => {
      // Error strings unique to this function — whole-SQL match is fine.
      expect(sql).toMatch(/Authentication required/);
      expect(sql).toMatch(/JWT is missing org_id claim/);
      expect(sql).toMatch(/Only the org owner can initiate a QuickBooks connection/);
    });

    it('grants EXECUTE to authenticated only (not service_role)', () => {
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.init_qb_oauth_state\(text\) TO authenticated/
      );
      expect(sql).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.init_qb_oauth_state\(text\) TO service_role/
      );
    });
  });

  describe('complete_qb_oauth RPC', () => {
    it('exists with the expected signature', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.complete_qb_oauth\(\s*p_state_id\s+uuid,\s*p_realm_id\s+text,\s*p_refresh_token\s+text,\s*p_access_token\s+text,\s*p_access_token_expires_at\s+timestamptz,\s*p_refresh_token_expires_at\s+timestamptz,\s*p_scopes\s+text\[\]\s*\)/
      );
    });

    it('is SECURITY DEFINER with a pinned search_path including vault', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.complete_qb_oauth[\s\S]*?SECURITY DEFINER\s+SET search_path = public, vault/
      );
    });

    it('does NOT call any user-auth gate (state row is the trust boundary)', () => {
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.complete_qb_oauth[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch, 'complete_qb_oauth body not found').not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).not.toMatch(/auth\.jwt\(\)/);
      expect(fn).not.toMatch(/public\.is_owner\(\)/);
    });

    it('rejects missing or expired state rows', () => {
      expect(sql).toMatch(/OAuth state not found \(already consumed or never existed\)/);
      expect(sql).toMatch(/OAuth state expired at %/);
    });

    it('writes both Vault secrets via update-or-create', () => {
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.complete_qb_oauth[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch).not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).toMatch(/vault\.update_secret\(v_existing_refresh_id, p_refresh_token\)/);
      expect(fn).toMatch(/vault\.create_secret\(\s*p_refresh_token/);
      expect(fn).toMatch(/vault\.update_secret\(v_existing_access_id, p_access_token\)/);
      expect(fn).toMatch(/vault\.create_secret\(\s*p_access_token/);
    });

    it('upserts on the (org_id, environment) conflict target', () => {
      // Same conflict target as set_qb_connection_tokens so the two
      // paths converge on the same row.
      expect(sql).toMatch(/ON CONFLICT \(org_id, environment\) DO UPDATE/);
    });

    it('burns the state row at the end of the flow', () => {
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.complete_qb_oauth[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch).not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).toMatch(
        /DELETE FROM public\.quickbooks_oauth_states WHERE state_id = p_state_id/
      );
    });

    it('is service-role only — REVOKEs from all, GRANTs only to service_role', () => {
      const sig =
        String.raw`public\.complete_qb_oauth\(\s*uuid, text, text, text, timestamptz, timestamptz, text\[\]\s*\)`;
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC`));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM authenticated`));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig} FROM anon`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`));
    });
  });

  describe('cleanup_expired_qb_oauth_states RPC', () => {
    it('exists and is service-role only', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.cleanup_expired_qb_oauth_states\(\)/
      );
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.cleanup_expired_qb_oauth_states\(\) FROM PUBLIC/
      );
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.cleanup_expired_qb_oauth_states\(\) FROM authenticated/
      );
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.cleanup_expired_qb_oauth_states\(\) TO service_role/
      );
    });

    it('deletes rows whose expires_at has passed', () => {
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.cleanup_expired_qb_oauth_states[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch).not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).toMatch(/DELETE FROM public\.quickbooks_oauth_states\s+WHERE expires_at < now\(\)/);
    });
  });

  describe('runtime sanity checks (DO blocks)', () => {
    it('verifies the table exists', () => {
      expect(sql).toMatch(/quickbooks_oauth_states: table missing after migration/);
    });

    it('verifies RLS is enabled', () => {
      expect(sql).toMatch(/quickbooks_oauth_states: RLS not enabled/);
    });

    it('verifies exactly 4 policies', () => {
      expect(sql).toMatch(/quickbooks_oauth_states: expected 4 policies, found %/);
    });

    it('verifies all 3 RPCs exist', () => {
      expect(sql).toMatch(/init_qb_oauth_state: function missing after migration/);
      expect(sql).toMatch(/complete_qb_oauth: function missing after migration/);
      expect(sql).toMatch(/cleanup_expired_qb_oauth_states: function missing after migration/);
    });
  });

  describe('rollback', () => {
    it('drops every owner policy', () => {
      expect(rollback).toMatch(/quickbooks_oauth_states_owner_' \|\| cmd/);
    });

    it('drops all three RPCs by exact signature', () => {
      expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.init_qb_oauth_state\(text\)/);
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.complete_qb_oauth\(\s*uuid, text, text, text, timestamptz, timestamptz, text\[\]\s*\)/
      );
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.cleanup_expired_qb_oauth_states\(\)/
      );
    });

    it('drops the table last', () => {
      expect(rollback).toMatch(
        /DROP FUNCTION[\s\S]*?DROP TABLE IF EXISTS public\.quickbooks_oauth_states/
      );
    });

    it('wraps everything in a single transaction', () => {
      expect(rollback).toMatch(/^[\s\S]*BEGIN;[\s\S]*COMMIT;[\s\S]*$/);
    });
  });
});
