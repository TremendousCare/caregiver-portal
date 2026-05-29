import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the QuickBooks integration PR #1 migration.
// The migration's own DO sanity blocks are the runtime safety net
// (table present, RLS on, policy count, RPCs present). This spec
// catches accidental deletion or mutation of the shape and the
// security posture in future PRs — particularly that we never
// regress the service-role-only grant on get_qb_connection or the
// owner gate inside set_qb_connection_tokens / clear_qb_connection.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260529100000_quickbooks_connections.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260529100000_quickbooks_connections_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('QuickBooks integration PR #1 — quickbooks_connections migration', () => {
  describe('table structure', () => {
    it('creates the quickbooks_connections table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.quickbooks_connections/);
    });

    it('declares every required column with the right type family', () => {
      const requiredFields = [
        ['id', 'uuid'],
        ['org_id', 'uuid'],
        ['realm_id', 'text'],
        ['environment', 'text'],
        ['scopes', 'text\\[\\]'],
        ['refresh_token_vault_secret_name', 'text'],
        ['access_token_vault_secret_name', 'text'],
        ['access_token_expires_at', 'timestamptz'],
        ['refresh_token_expires_at', 'timestamptz'],
        ['last_refreshed_at', 'timestamptz'],
        ['last_sync_at', 'timestamptz'],
        ['status', 'text'],
        ['status_message', 'text'],
        ['connected_by', 'text'],
        ['connected_at', 'timestamptz'],
        ['created_at', 'timestamptz'],
        ['updated_at', 'timestamptz'],
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

    it('references public.organizations(id) ON DELETE CASCADE', () => {
      expect(sql).toMatch(/REFERENCES public\.organizations\(id\) ON DELETE CASCADE/);
    });

    it('enforces the environment CHECK to sandbox|production', () => {
      expect(sql).toMatch(
        /environment\s+text NOT NULL DEFAULT 'sandbox'[\s\S]*?CHECK \(environment IN \('sandbox', 'production'\)\)/
      );
    });

    it('enforces the status CHECK to active|error|reauth_required|disconnected', () => {
      expect(sql).toMatch(
        /CHECK \(status IN \('active', 'error',\s*'reauth_required',\s*'disconnected'\)\)/
      );
    });

    it('enforces a non-empty scopes array', () => {
      expect(sql).toMatch(/scopes\s+text\[\] NOT NULL DEFAULT ARRAY\[\]::text\[\][\s\S]*?CHECK \(cardinality\(scopes\) > 0\)/);
    });

    it('enforces unique (org_id, environment)', () => {
      expect(sql).toMatch(
        /CONSTRAINT quickbooks_connections_one_per_env UNIQUE \(org_id, environment\)/
      );
    });

    it('marks both vault secret name columns NOT NULL', () => {
      expect(sql).toMatch(/refresh_token_vault_secret_name\s+text NOT NULL/);
      expect(sql).toMatch(/access_token_vault_secret_name\s+text NOT NULL/);
    });

    it('indexes org_id and both expiry hot paths', () => {
      expect(sql).toMatch(
        /idx_quickbooks_connections_org\s+ON public\.quickbooks_connections\s*\(org_id\)/
      );
      expect(sql).toMatch(
        /idx_quickbooks_connections_refresh_due\s+ON public\.quickbooks_connections\s*\(access_token_expires_at\)\s+WHERE status = 'active'/
      );
      expect(sql).toMatch(
        /idx_quickbooks_connections_reauth_due\s+ON public\.quickbooks_connections\s*\(refresh_token_expires_at\)\s+WHERE status = 'active'/
      );
    });

    it('wires touch_updated_at via BEFORE UPDATE trigger', () => {
      expect(sql).toMatch(
        /CREATE TRIGGER quickbooks_connections_touch_updated_at\s+BEFORE UPDATE ON public\.quickbooks_connections[\s\S]*?EXECUTE FUNCTION public\.touch_updated_at\(\)/
      );
    });
  });

  describe('RLS', () => {
    it('enables row-level security', () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.quickbooks_connections ENABLE ROW LEVEL SECURITY/
      );
    });

    it('creates 4 owner policies (select/insert/update/delete)', () => {
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(
          sql,
          `missing owner ${cmd} policy`
        ).toMatch(
          new RegExp(
            `CREATE POLICY quickbooks_connections_owner_${cmd} ON public\\.quickbooks_connections`
          )
        );
      }
    });

    it('creates exactly 1 admin policy and it is SELECT only', () => {
      expect(sql).toMatch(
        /CREATE POLICY quickbooks_connections_admin_select ON public\.quickbooks_connections\s+FOR SELECT TO authenticated/
      );
      expect(sql).not.toMatch(/CREATE POLICY quickbooks_connections_admin_(insert|update|delete)/);
    });

    it('uses public.is_owner() / public.is_admin() — never inline EXISTS', () => {
      // Per docs/RLS_GOTCHAS.md, any policy on this table that wraps a
      // SELECT on the same table inline is a recursion bomb. The
      // STABLE SECURITY DEFINER helpers are mandatory.
      expect(sql).toMatch(/public\.is_owner\(\)/);
      expect(sql).toMatch(/public\.is_admin\(\)/);
      // No inline EXISTS subqueries targeting our own table in any
      // policy body.
      const inlineExistsOnSelf =
        /USING\s*\([\s\S]*?EXISTS\s*\(\s*SELECT[\s\S]*?FROM\s+public\.quickbooks_connections/i;
      expect(sql).not.toMatch(inlineExistsOnSelf);
    });

    it('includes the JWT org_id check in every policy', () => {
      // Every USING / WITH CHECK should pair the helper with the
      // strict org-id predicate.
      const orgIdCheck = /org_id = nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/g;
      // 4 owner policies (S,I,U,D) where U has both USING and WITH
      // CHECK → 5 owner occurrences. Plus 1 admin SELECT → 6 total.
      // INSERT has WITH CHECK only → still counts as 1.
      // Tally: owner_select 1 + owner_insert 1 + owner_update 2 +
      // owner_delete 1 + admin_select 1 = 6.
      const matches = sql.match(orgIdCheck) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('set_qb_connection_tokens RPC', () => {
    it('exists with the expected signature', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.set_qb_connection_tokens\(\s*p_org_id\s+uuid,\s*p_environment\s+text,\s*p_realm_id\s+text,\s*p_refresh_token\s+text,\s*p_access_token\s+text,\s*p_access_token_expires_at\s+timestamptz,\s*p_refresh_token_expires_at\s+timestamptz,\s*p_scopes\s+text\[\]\s*\)/
      );
    });

    it('is SECURITY DEFINER with a pinned search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.set_qb_connection_tokens[\s\S]*?SECURITY DEFINER\s+SET search_path = public, vault/
      );
    });

    it('gates on auth + JWT org match + is_owner', () => {
      // The error strings are unique to this function — asserting on
      // the whole SQL is enough; no need to slice.
      expect(sql).toMatch(/Authentication required/);
      expect(sql).toMatch(/Cannot set QuickBooks tokens for another org/);
      expect(sql).toMatch(/Only the org owner can connect QuickBooks/);
      expect(sql).toMatch(/public\.is_owner\(\)/);
    });

    it('writes both tokens to Vault via update-or-create', () => {
      expect(sql).toMatch(/vault\.update_secret\(v_existing_refresh_id, p_refresh_token\)/);
      expect(sql).toMatch(/vault\.create_secret\(\s*p_refresh_token/);
      expect(sql).toMatch(/vault\.update_secret\(v_existing_access_id, p_access_token\)/);
      expect(sql).toMatch(/vault\.create_secret\(\s*p_access_token/);
    });

    it('upserts the connection row on the (org_id, environment) conflict target', () => {
      expect(sql).toMatch(/ON CONFLICT \(org_id, environment\) DO UPDATE/);
    });

    it('grants EXECUTE to authenticated but NOT to service_role', () => {
      // The refresh cron uses refresh_qb_connection_tokens (a
      // dedicated service-role-only function) instead, because the
      // body of set_qb_connection_tokens gates on a user JWT and
      // would raise 'Authentication required' on a service-role
      // call. Codex caught this in review of d0efe1e — see PR #428.
      //
      // Regexes are anchored on the exact 8-arg signature so they
      // cannot accidentally span across to refresh_'s GRANT block.
      const setSig =
        String.raw`public\.set_qb_connection_tokens\(\s*uuid, text, text, text, text, timestamptz, timestamptz, text\[\]\s*\)`;
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${setSig} TO authenticated`));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${setSig} TO service_role`));
    });
  });

  describe('refresh_qb_connection_tokens RPC (cron rotation path)', () => {
    it('exists with the expected (narrower) signature', () => {
      // No realm_id and no scopes — neither can change during a
      // refresh, so the cron isn't allowed to supply them.
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens\(\s*p_org_id\s+uuid,\s*p_environment\s+text,\s*p_refresh_token\s+text,\s*p_access_token\s+text,\s*p_access_token_expires_at\s+timestamptz,\s*p_refresh_token_expires_at\s+timestamptz\s*\)/
      );
    });

    it('is SECURITY DEFINER with a pinned search_path', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?SECURITY DEFINER\s+SET search_path = public, vault/
      );
    });

    it('does NOT call any user-auth gate (no jwt email, org match, or is_owner)', () => {
      // Pluck just the refresh function body so we don't pick up
      // gate strings from neighbouring functions.
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?\$\$\s*LANGUAGE plpgsql/
      ) ?? sql.match(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch, 'refresh_qb_connection_tokens body not found').not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).not.toMatch(/auth\.jwt\(\)/);
      expect(fn).not.toMatch(/Authentication required/);
      expect(fn).not.toMatch(/public\.is_owner\(\)/);
      expect(fn).not.toMatch(/Cannot set QuickBooks tokens/);
    });

    it('does NOT touch the connected_by / connected_at audit columns', () => {
      // The UPDATE in this function is the authoritative audit-safety
      // boundary: those two columns record the human authorization
      // and must outlive cron rotations.
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch).not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).not.toMatch(/connected_by\s*=/);
      expect(fn).not.toMatch(/connected_at\s*=/);
    });

    it('returns false when no matching connection exists (cron self-heals)', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?IF NOT FOUND THEN\s+RETURN false;/
      );
    });

    it('rotates BOTH Vault secrets', () => {
      const fnMatch = sql.match(
        /CREATE OR REPLACE FUNCTION public\.refresh_qb_connection_tokens[\s\S]*?END;\s*\$\$/
      );
      expect(fnMatch).not.toBeNull();
      const fn = fnMatch[0];
      expect(fn).toMatch(/vault\.update_secret\(v_existing_refresh_id, p_refresh_token\)/);
      expect(fn).toMatch(/vault\.update_secret\(v_existing_access_id, p_access_token\)/);
    });

    it('is service-role only — REVOKEs broad grants, GRANTs only service_role', () => {
      // Mirrors the get_qb_connection security posture: this RPC
      // can rotate Vault entries and update token expiries, so a
      // future PR must not accidentally hand it to authenticated.
      // Regex is anchored on the exact 6-arg signature so it cannot
      // span across to set_qb_connection_tokens's GRANT line.
      const refreshSig =
        String.raw`public\.refresh_qb_connection_tokens\(\s*uuid, text, text, text, timestamptz, timestamptz\s*\)`;
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${refreshSig} FROM PUBLIC`));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${refreshSig} FROM authenticated`));
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION ${refreshSig} FROM anon`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${refreshSig} TO service_role`));
      expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${refreshSig} TO authenticated`));
    });
  });

  describe('get_qb_connection RPC', () => {
    it('exists and is SECURITY DEFINER', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.get_qb_connection\(\s*p_org_id\s+uuid,\s*p_environment\s+text DEFAULT 'production'\s*\)/
      );
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.get_qb_connection[\s\S]*?SECURITY DEFINER/
      );
    });

    it('returns decrypted tokens from vault.decrypted_secrets', () => {
      expect(sql).toMatch(/FROM vault\.decrypted_secrets vds WHERE vds\.name = v_refresh_name/);
      expect(sql).toMatch(/FROM vault\.decrypted_secrets vds WHERE vds\.name = v_access_name/);
    });

    it('is service-role only — REVOKEs from authenticated and anon, GRANTs to service_role', () => {
      // This is the single most important security assertion in this
      // file. If a future PR accidentally grants EXECUTE on this
      // function to authenticated, every staff user could pull raw
      // QuickBooks tokens via RPC.
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.get_qb_connection\(uuid, text\) FROM PUBLIC/
      );
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.get_qb_connection\(uuid, text\) FROM authenticated/
      );
      expect(sql).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.get_qb_connection\(uuid, text\) FROM anon/
      );
      expect(sql).toMatch(
        /GRANT\s+EXECUTE ON FUNCTION public\.get_qb_connection\(uuid, text\) TO service_role/
      );
      // And explicitly NOT to authenticated.
      expect(sql).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.get_qb_connection\(uuid, text\) TO authenticated/
      );
    });
  });

  describe('clear_qb_connection RPC', () => {
    it('exists, is SECURITY DEFINER, and gates on owner + JWT org match', () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.clear_qb_connection\(\s*p_org_id\s+uuid,\s*p_environment\s+text DEFAULT 'production'\s*\)/
      );
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.clear_qb_connection[\s\S]*?SECURITY DEFINER/
      );
      // Error strings unique to this function — full-SQL match is fine.
      expect(sql).toMatch(/Cannot clear QuickBooks tokens for another org/);
      expect(sql).toMatch(/Only the org owner can disconnect QuickBooks/);
    });

    it('deletes both Vault secrets and the row', () => {
      expect(sql).toMatch(/DELETE FROM vault\.secrets WHERE name = v_refresh_name/);
      expect(sql).toMatch(/DELETE FROM vault\.secrets WHERE name = v_access_name/);
      expect(sql).toMatch(
        /DELETE FROM public\.quickbooks_connections\s+WHERE org_id = p_org_id AND environment = p_environment/
      );
    });
  });

  describe('runtime sanity checks (DO blocks)', () => {
    it('verifies the table exists', () => {
      expect(sql).toMatch(/quickbooks_connections: table missing after migration/);
    });

    it('verifies RLS is enabled', () => {
      expect(sql).toMatch(/quickbooks_connections: RLS not enabled/);
    });

    it('verifies the exact policy count (5)', () => {
      expect(sql).toMatch(/quickbooks_connections: expected 5 policies, found %/);
    });

    it('verifies all 4 RPCs exist', () => {
      expect(sql).toMatch(/set_qb_connection_tokens: function missing after migration/);
      expect(sql).toMatch(/refresh_qb_connection_tokens: function missing after migration/);
      expect(sql).toMatch(/get_qb_connection: function missing after migration/);
      expect(sql).toMatch(/clear_qb_connection: function missing after migration/);
    });
  });

  describe('rollback', () => {
    it('drops every policy this migration creates', () => {
      // The rollback iterates the four CRUD verbs for owner policies
      // and drops the admin select policy explicitly.
      expect(rollback).toMatch(/quickbooks_connections_owner_' \|\| cmd/);
      expect(rollback).toMatch(/quickbooks_connections_admin_select/);
    });

    it('drops all four RPCs by exact signature', () => {
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.set_qb_connection_tokens\(\s*uuid, text, text, text, text, timestamptz, timestamptz, text\[\]\s*\)/
      );
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.refresh_qb_connection_tokens\(\s*uuid, text, text, text, timestamptz, timestamptz\s*\)/
      );
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.get_qb_connection\(uuid, text\)/
      );
      expect(rollback).toMatch(
        /DROP FUNCTION IF EXISTS public\.clear_qb_connection\(uuid, text\)/
      );
    });

    it('drops the trigger before the table', () => {
      expect(rollback).toMatch(
        /DROP TRIGGER IF EXISTS quickbooks_connections_touch_updated_at[\s\S]*?DROP TABLE IF EXISTS public\.quickbooks_connections/
      );
    });

    it('cleans up vault secrets it created', () => {
      expect(rollback).toMatch(/qb_refresh_token_%/);
      expect(rollback).toMatch(/qb_access_token_%/);
    });

    it('wraps everything in a single transaction', () => {
      expect(rollback).toMatch(/^[\s\S]*BEGIN;[\s\S]*COMMIT;[\s\S]*$/);
    });
  });
});
