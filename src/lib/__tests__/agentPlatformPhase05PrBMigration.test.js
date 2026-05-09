// Phase 0.5 PR B — structural assertions for the three new migrations
// (update_agent_manifest_v1, revert_agent_to_version_v1,
// agent_table_write_lockdown). Runtime behaviour is verified by the
// migrations' own DO sanity blocks + manual smoke before merge.
//
// The lockdown spec includes a security regression assertion: the
// REVOKE statements MUST be present on both tables for all three of
// INSERT, UPDATE, DELETE. Future PRs that try to "open up" direct
// table writes (e.g. for a new debug surface) will fail this spec
// before they hit production.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../../supabase/migrations');
const rollbackDir   = join(migrationsDir, '_rollback');

const updateSql   = readFileSync(join(migrationsDir, '20260510020000_agent_platform_phase_0_5_pr_b_update_agent_manifest_rpc.sql'), 'utf-8');
const updateDown  = readFileSync(join(rollbackDir, '20260510020000_agent_platform_phase_0_5_pr_b_update_agent_manifest_rpc_down.sql'), 'utf-8');
const revertSql   = readFileSync(join(migrationsDir, '20260510030000_agent_platform_phase_0_5_pr_b_revert_agent_to_version_rpc.sql'), 'utf-8');
const revertDown  = readFileSync(join(rollbackDir, '20260510030000_agent_platform_phase_0_5_pr_b_revert_agent_to_version_rpc_down.sql'), 'utf-8');
const lockdownSql = readFileSync(join(migrationsDir, '20260510040000_agent_platform_phase_0_5_pr_b_table_write_lockdown.sql'), 'utf-8');
const lockdownDown = readFileSync(join(rollbackDir, '20260510040000_agent_platform_phase_0_5_pr_b_table_write_lockdown_down.sql'), 'utf-8');

describe('PR B / update_agent_manifest_v1 migration', () => {
  it('has the locked signature', () => {
    expect(updateSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.update_agent_manifest_v1\(\s*p_agent_id\s+uuid,\s*p_expected_version\s+integer,\s*p_updates\s+jsonb,\s*p_change_summary\s+text\s*\)/
    );
    expect(updateSql).toMatch(/RETURNS integer/);
  });

  it('is SECURITY DEFINER with explicit search_path', () => {
    expect(updateSql).toMatch(/SECURITY DEFINER/);
    expect(updateSql).toMatch(/SET search_path = public/);
  });

  it('admin-gates via public.is_admin()', () => {
    expect(updateSql).toMatch(/IF NOT public\.is_admin\(\) THEN/);
  });

  it('rejects empty change_summary (audit hygiene)', () => {
    expect(updateSql).toMatch(/length\(trim\(p_change_summary\)\) = 0/);
    expect(updateSql).toMatch(/change_summary is required/);
  });

  it('rejects non-object updates', () => {
    expect(updateSql).toMatch(/jsonb_typeof\(p_updates\) <> 'object'/);
  });

  it('verifies JWT org_id matches agent org_id (tenant isolation)', () => {
    expect(updateSql).toMatch(/auth\.jwt\(\) ->> 'org_id'/);
    expect(updateSql).toMatch(/agent org mismatch/);
  });

  it('takes a FOR UPDATE row lock during the agent read', () => {
    expect(updateSql).toMatch(/SELECT \*[\s\S]*?FROM public\.agents[\s\S]*?FOR UPDATE/);
  });

  it('enforces optimistic version check (locked D3)', () => {
    expect(updateSql).toMatch(/version <> p_expected_version/);
    expect(updateSql).toMatch(/agent_version_conflict/);
    expect(updateSql).toMatch(/USING ERRCODE = 'P0001'/);
  });

  it('only updates allowlisted manifest fields', () => {
    const allowed = [
      'name', 'system_prompt', 'tool_allowlist', 'autonomy_profile',
      'context_recipe', 'model', 'max_iterations', 'outcome_definition',
    ];
    for (const f of allowed) {
      expect(updateSql, `expected to update ${f}`).toMatch(
        new RegExp(`p_updates \\? '${f}'`)
      );
    }
  });

  it('does NOT touch operational levers or identity fields via this RPC', () => {
    // These keys must not appear as `p_updates ? '<key>'` patterns —
    // the RPC silently drops them. (kill_switch / shadow_mode have
    // their own RPC; id/org_id/slug are immutable lineage.)
    const forbidden = ['kill_switch', 'shadow_mode', 'slug', 'org_id', 'triggers'];
    for (const f of forbidden) {
      expect(updateSql, `must NOT update ${f}`).not.toMatch(
        new RegExp(`p_updates \\? '${f}'`)
      );
    }
  });

  it('increments version and updates updated_by', () => {
    expect(updateSql).toMatch(/version\s*=\s*v_new_version/);
    expect(updateSql).toMatch(/updated_by\s*=\s*v_actor/);
  });

  it('writes a snapshot row to agent_versions with the new version', () => {
    expect(updateSql).toMatch(/INSERT INTO public\.agent_versions/);
    expect(updateSql).toMatch(/v_new_version/);
    // Mirror seed convention: snapshot excludes timestamps.
    expect(updateSql).toMatch(/'created_at'/);
    expect(updateSql).toMatch(/'updated_at'/);
  });

  it('grants EXECUTE to authenticated and revokes from PUBLIC', () => {
    expect(updateSql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.update_agent_manifest_v1\(uuid, integer, jsonb, text\) FROM PUBLIC/);
    expect(updateSql).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.update_agent_manifest_v1\(uuid, integer, jsonb, text\) TO authenticated/);
  });

  it('has a deploy-time sanity DO block', () => {
    expect(updateSql).toMatch(/proname = 'update_agent_manifest_v1'/);
    expect(updateSql).toMatch(/prosecdef = true/);
  });

  it('rollback drops the function', () => {
    expect(updateDown).toMatch(/DROP FUNCTION IF EXISTS public\.update_agent_manifest_v1\(uuid, integer, jsonb, text\)/);
  });

  it('uses public.is_admin() helper, not inline EXISTS over user_roles (recursion safety)', () => {
    expect(updateSql).not.toMatch(/EXISTS\s*\(\s*SELECT.*FROM\s+user_roles/i);
  });
});

describe('PR B / revert_agent_to_version_v1 migration', () => {
  it('has the locked signature', () => {
    expect(revertSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.revert_agent_to_version_v1\(\s*p_agent_id\s+uuid,\s*p_target_version\s+integer,\s*p_change_summary\s+text\s*\)/
    );
    expect(revertSql).toMatch(/RETURNS integer/);
  });

  it('is SECURITY DEFINER + admin-gated', () => {
    expect(revertSql).toMatch(/SECURITY DEFINER/);
    expect(revertSql).toMatch(/IF NOT public\.is_admin\(\) THEN/);
  });

  it('takes FOR UPDATE row lock', () => {
    expect(revertSql).toMatch(/SELECT \*[\s\S]*?FROM public\.agents[\s\S]*?FOR UPDATE/);
  });

  it('verifies org isolation', () => {
    expect(revertSql).toMatch(/agent org mismatch/);
  });

  it('rejects target_version equal to current version (no-op revert blocked)', () => {
    expect(revertSql).toMatch(/p_target_version = v_agent\.version/);
    expect(revertSql).toMatch(/no-op revert blocked/);
  });

  it('raises P0002 when target version not found', () => {
    expect(revertSql).toMatch(/target version % not found/);
    expect(revertSql).toMatch(/USING ERRCODE = 'P0002'/);
  });

  it('does NOT change identity / operational fields', () => {
    // The UPDATE clause must not assign these.
    const excluded = ['id', 'org_id', 'slug', 'kill_switch', 'shadow_mode', 'triggers', 'created_at', 'created_by'];
    // Build a list of fields actually assigned in the UPDATE SET.
    const setBlock = revertSql.match(/UPDATE public\.agents\s*\n\s*SET([\s\S]*?)WHERE/);
    expect(setBlock).toBeTruthy();
    for (const f of excluded) {
      expect(setBlock[1], `revert must not change ${f}`).not.toMatch(
        new RegExp(`^\\s*${f}\\s*=`, 'm')
      );
    }
  });

  it('writes a snapshot row to agent_versions', () => {
    expect(revertSql).toMatch(/INSERT INTO public\.agent_versions/);
  });

  it('grants EXECUTE to authenticated', () => {
    expect(revertSql).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.revert_agent_to_version_v1\(uuid, integer, text\) TO authenticated/);
  });

  it('rollback drops the function', () => {
    expect(revertDown).toMatch(/DROP FUNCTION IF EXISTS public\.revert_agent_to_version_v1\(uuid, integer, text\)/);
  });

  it('uses public.is_admin() helper (recursion safety)', () => {
    expect(revertSql).not.toMatch(/EXISTS\s*\(\s*SELECT.*FROM\s+user_roles/i);
  });
});

describe('PR B / agent_table_write_lockdown migration (security regression)', () => {
  // The CRITICAL spec for this migration: REVOKE must be present for
  // every (table, privilege) pair. A future PR that tries to "open up"
  // direct writes for any reason will fail this spec before merge.
  const tables = ['agents', 'agent_versions'];
  const privileges = ['INSERT', 'UPDATE', 'DELETE'];

  for (const table of tables) {
    for (const priv of privileges) {
      it(`revokes ${priv} on public.${table} from authenticated`, () => {
        expect(lockdownSql).toMatch(
          new RegExp(`REVOKE[^;]*\\b${priv}\\b[^;]*ON public\\.${table}\\b[^;]*FROM authenticated`, 'i')
        );
      });
    }
  }

  it('does NOT revoke SELECT (admins + non-admins still need read)', () => {
    expect(lockdownSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agents/i);
    expect(lockdownSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agent_versions/i);
  });

  it('has a sanity DO block that aborts deploy if REVOKE failed', () => {
    expect(lockdownSql).toMatch(/information_schema\.table_privileges/);
    expect(lockdownSql).toMatch(/grantee = 'authenticated'/);
    expect(lockdownSql).toMatch(/RAISE EXCEPTION/);
  });

  it('rollback re-grants the three privileges on both tables', () => {
    for (const table of tables) {
      for (const priv of privileges) {
        expect(lockdownDown).toMatch(
          new RegExp(`GRANT[^;]*\\b${priv}\\b[^;]*ON public\\.${table}\\b[^;]*TO authenticated`, 'i')
        );
      }
    }
  });
});
