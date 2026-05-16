/**
 * Phase 1.6.1 — upsert_call_taxonomy_row_v1 RPC migration.
 *
 * Structural assertions on the migration SQL. Runtime semantics
 * (admin gate, JWT extraction, UPSERT correctness) are verified in
 * the Supabase SQL editor pre-merge.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516010001_agent_platform_phase_1_6_1_upsert_call_taxonomy_row_rpc.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516010001_agent_platform_phase_1_6_1_upsert_call_taxonomy_row_rpc_down.sql',
);

const sql      = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('upsert_call_taxonomy_row_v1 RPC — signature', () => {
  it('declares the function with the canonical parameter shape', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.upsert_call_taxonomy_row_v1\(/);
    expect(sql).toMatch(/p_axis\s+text/);
    expect(sql).toMatch(/p_slug\s+text/);
    expect(sql).toMatch(/p_label\s+text/);
    expect(sql).toMatch(/p_description text\s+DEFAULT NULL/);
    expect(sql).toMatch(/p_sort_order\s+integer DEFAULT 0/);
    expect(sql).toMatch(/p_is_active\s+boolean DEFAULT true/);
  });

  it('returns uuid and is SECURITY DEFINER', () => {
    expect(sql).toMatch(/RETURNS uuid/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });
});

describe('upsert_call_taxonomy_row_v1 RPC — admin gate + validation', () => {
  it('rejects non-admin callers with permission denied', () => {
    expect(sql).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(sql).toMatch(/permission denied: not an admin/);
    expect(sql).toMatch(/ERRCODE = '42501'/);
  });

  it('rejects invalid axis values at the RPC layer', () => {
    expect(sql).toMatch(/p_axis NOT IN \('call_type', 'red_flag'\)/);
    expect(sql).toMatch(/invalid axis/);
    expect(sql).toMatch(/ERRCODE = '22023'/);
  });

  it('rejects missing slug + label', () => {
    expect(sql).toMatch(/p_slug IS NULL OR length\(p_slug\) = 0/);
    expect(sql).toMatch(/p_label IS NULL OR length\(p_label\) = 0/);
  });

  it('rejects JWTs missing the org_id claim', () => {
    expect(sql).toMatch(/JWT missing org_id claim/);
    expect(sql).toMatch(/v_jwt_org_id := nullif\(auth\.jwt\(\) ->> 'org_id', ''\)::uuid/);
  });
});

describe('upsert_call_taxonomy_row_v1 RPC — write behaviour', () => {
  it('UPSERTs on (org_id, axis, slug)', () => {
    expect(sql).toMatch(/ON CONFLICT \(org_id, axis, slug\) DO UPDATE/);
  });

  it('updates mutable fields and preserves created_by', () => {
    expect(sql).toMatch(/SET label\s+= EXCLUDED\.label/);
    expect(sql).toMatch(/description = EXCLUDED\.description/);
    expect(sql).toMatch(/sort_order\s+= EXCLUDED\.sort_order/);
    expect(sql).toMatch(/is_active\s+= EXCLUDED\.is_active/);
    expect(sql).toMatch(/updated_by\s+= EXCLUDED\.updated_by/);
    // created_by is set on INSERT but NOT in the DO UPDATE SET clause.
    const updateClause = sql.split('DO UPDATE')[1] ?? '';
    expect(updateClause).not.toMatch(/created_by\s+= EXCLUDED\.created_by/);
  });

  it('stamps the actor from the JWT email', () => {
    expect(sql).toMatch(/v_actor_email := lower\(\(auth\.jwt\(\) ->> 'email'\)\)/);
    expect(sql).toMatch(/v_actor\s+:= 'user:' \|\| coalesce\(v_actor_email, 'unknown'\)/);
  });

  it('returns the resulting row id', () => {
    expect(sql).toMatch(/RETURNING id INTO v_row_id/);
    expect(sql).toMatch(/RETURN v_row_id/);
  });
});

describe('upsert_call_taxonomy_row_v1 RPC — privileges', () => {
  it('revokes EXECUTE from PUBLIC, grants to authenticated', () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.upsert_call_taxonomy_row_v1\([\s\S]*?\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.upsert_call_taxonomy_row_v1\([\s\S]*?\) TO authenticated/);
  });

  it('fails the migration if the function did not land as SECURITY DEFINER', () => {
    expect(sql).toMatch(/upsert_call_taxonomy_row_v1 missing or not SECURITY DEFINER/);
    expect(sql).toMatch(/prosecdef = true/);
  });
});

describe('upsert_call_taxonomy_row_v1 rollback', () => {
  it('drops the function', () => {
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.upsert_call_taxonomy_row_v1\(/);
  });
});
