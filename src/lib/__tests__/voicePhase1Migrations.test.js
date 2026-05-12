import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Voice / CTI Phase 1 schema migrations.
// The migrations' own PL/pgSQL DO blocks are the runtime safety net
// (they abort the deploy if policies, defaults, or indexes are wrong).
// This spec is a cheap regression net that catches accidental deletion
// of those guards or drift away from the Phase B locked patterns in
// future PRs.

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations'
);

const VOICE_CONFIG_SQL = readFileSync(
  join(MIGRATIONS_DIR, '20260511000000_voice_phase1_communication_voice_config.sql'),
  'utf-8'
);

const EXTENSION_SQL = readFileSync(
  join(MIGRATIONS_DIR, '20260511000001_voice_phase1_org_memberships_extension_id.sql'),
  'utf-8'
);

const CALL_SESSIONS_SQL = readFileSync(
  join(MIGRATIONS_DIR, '20260511000002_voice_phase1_call_sessions.sql'),
  'utf-8'
);

const ROLLBACK_DIR = join(MIGRATIONS_DIR, '_rollback');
const ROLLBACK_FILES = [
  '20260511000000_voice_phase1_communication_voice_config_down.sql',
  '20260511000001_voice_phase1_org_memberships_extension_id_down.sql',
  '20260511000002_voice_phase1_call_sessions_down.sql',
];

// ─────────────────────────────────────────────────────────────────
// Migration A — communication_voice_config
// ─────────────────────────────────────────────────────────────────

describe('Voice Phase 1 — communication_voice_config migration', () => {
  const sql = VOICE_CONFIG_SQL;

  it('creates the communication_voice_config table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS communication_voice_config/);
  });

  it('uses the default_org_id() helper rather than a hardcoded UUID', () => {
    expect(sql).toMatch(/DEFAULT public\.default_org_id\(\)/);
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('makes org_id the primary key (one row per org)', () => {
    expect(sql).toMatch(/org_id\s+uuid PRIMARY KEY/);
  });

  it('references communication_routes(category) for auth lookup', () => {
    expect(sql).toMatch(/auth_route_category\s+text\s+REFERENCES communication_routes\(category\)/);
  });

  it('has the four tenant_isolation policies matching the B2b regex pattern', () => {
    const policies = ['select', 'insert', 'update', 'delete'].map(
      (cmd) => `tenant_isolation_communication_voice_config_${cmd}`
    );
    for (const policyName of policies) {
      expect(sql).toContain(policyName);
    }
    // The naming must satisfy the suffix-anchored regex locked in PR #237.
    const policyRegex = /^tenant_isolation_.*_(select|insert|update|delete)$/;
    for (const policyName of policies) {
      expect(policyRegex.test(policyName)).toBe(true);
    }
  });

  it('uses the fail-closed tenant predicate with nullif() on the JWT claim', () => {
    expect(sql).toMatch(
      /org_id\s*=\s*nullif\(\(SELECT auth\.jwt\(\)\) ->> 'org_id', ''\)::uuid/
    );
  });

  it('gates writes through public.is_admin() rather than inline EXISTS (RLS_GOTCHAS rule 1)', () => {
    // Three write commands × at least one is_admin() reference each.
    const adminCalls = sql.match(/public\.is_admin\(\)/g) ?? [];
    expect(adminCalls.length).toBeGreaterThanOrEqual(3);
    // No inline EXISTS against user_roles in this migration.
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[^)]*FROM\s+user_roles/i);
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[^)]*FROM\s+public\.user_roles/i);
  });

  it('has a service_role_full_access policy for edge functions', () => {
    expect(sql).toMatch(/service_role_full_access_communication_voice_config/);
    expect(sql).toMatch(/FOR ALL\s+TO service_role/);
  });

  it('constrains transcription_provider to the supported set', () => {
    expect(sql).toMatch(/transcription_provider IN \(\s*'ringcentral_native',\s*'whisper',\s*'both'\s*\)/);
  });

  it('contains a sanity DO block that aborts on policy count or default mismatch', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/expected 5 RLS policies/);
    expect(sql).toMatch(/default must reference default_org_id\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Migration B — org_memberships.ringcentral_extension_id
// ─────────────────────────────────────────────────────────────────

describe('Voice Phase 1 — org_memberships.ringcentral_extension_id migration', () => {
  const sql = EXTENSION_SQL;

  it('adds the column idempotently', () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.org_memberships\s+ADD COLUMN IF NOT EXISTS ringcentral_extension_id text/
    );
  });

  it('creates a partial lookup index excluding NULL extensions', () => {
    expect(sql).toMatch(/idx_org_memberships_rc_extension/);
    expect(sql).toMatch(/WHERE ringcentral_extension_id IS NOT NULL/);
  });

  it('creates a unique constraint per (org_id, extension_id) so an extension cannot double-bind', () => {
    expect(sql).toMatch(/uniq_org_memberships_rc_extension_per_org/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_memberships_rc_extension_per_org/);
    expect(sql).toMatch(/\(org_id, ringcentral_extension_id\)/);
  });

  it('contains a sanity DO block that aborts on missing column or indexes', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/ringcentral_extension_id missing/);
    expect(sql).toMatch(/idx_org_memberships_rc_extension missing/);
    expect(sql).toMatch(/uniq_org_memberships_rc_extension_per_org missing/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Migration C — call_sessions
// ─────────────────────────────────────────────────────────────────

describe('Voice Phase 1 — call_sessions migration', () => {
  const sql = CALL_SESSIONS_SQL;

  it('creates the call_sessions table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS call_sessions/);
  });

  it('uses the default_org_id() helper rather than a hardcoded UUID', () => {
    expect(sql).toMatch(/DEFAULT public\.default_org_id\(\)/);
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('marks org_id NOT NULL with a FK to organizations', () => {
    expect(sql).toMatch(/org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)\s+REFERENCES organizations\(id\)/);
  });

  it('enforces one row per (org, telephony_session_id) so the webhook upserts cleanly', () => {
    expect(sql).toMatch(/CONSTRAINT call_sessions_unique_session\s+UNIQUE \(org_id, telephony_session_id\)/);
  });

  it('constrains direction and status to the supported sets', () => {
    expect(sql).toMatch(/direction\s+text NOT NULL[\s\S]*?CHECK \(direction IN \('inbound', 'outbound'\)\)/);
    expect(sql).toMatch(/status\s+text NOT NULL[\s\S]*?CHECK \(status IN \([\s\S]*?'ringing'[\s\S]*?'answered'[\s\S]*?'ended'[\s\S]*?'missed'[\s\S]*?'voicemail'[\s\S]*?\)\)/);
  });

  it('constrains matched_entity_type so the screen-pop matcher cannot drift', () => {
    expect(sql).toMatch(/matched_entity_type\s+text CHECK \(matched_entity_type IN \('caregiver', 'client'\)\)/);
  });

  it('does NOT create a FK to call_transcriptions (PK shape mismatch — joins via recording_id)', () => {
    // call_transcriptions.recording_id is the PK (text), not id (uuid).
    // A `transcript_id uuid REFERENCES call_transcriptions(id)` would fail to apply.
    expect(sql).not.toMatch(/REFERENCES call_transcriptions/);
    // Worker uses a status marker on this table instead.
    expect(sql).toMatch(/transcript_fetched_at\s+timestamptz/);
  });

  it('has the four tenant_isolation policies matching the B2b regex pattern', () => {
    const policies = ['select', 'insert', 'update', 'delete'].map(
      (cmd) => `tenant_isolation_call_sessions_${cmd}`
    );
    for (const policyName of policies) {
      expect(sql).toContain(policyName);
    }
    const policyRegex = /^tenant_isolation_.*_(select|insert|update|delete)$/;
    for (const policyName of policies) {
      expect(policyRegex.test(policyName)).toBe(true);
    }
  });

  it('uses the fail-closed tenant predicate with nullif() on the JWT claim', () => {
    expect(sql).toMatch(
      /org_id\s*=\s*nullif\(\(SELECT auth\.jwt\(\)\) ->> 'org_id', ''\)::uuid/
    );
  });

  it('has a service_role_full_access policy for the webhook handler', () => {
    expect(sql).toMatch(/service_role_full_access_call_sessions/);
    expect(sql).toMatch(/FOR ALL\s+TO service_role/);
  });

  it('pending-transcript partial index avoids non-IMMUTABLE now() (CLAUDE.md gotcha)', () => {
    // The partial index predicate must not call now() — Postgres rejects
    // non-IMMUTABLE functions in index predicates. Filter by time at
    // query time instead.
    const indexBlock = sql.match(/CREATE INDEX IF NOT EXISTS idx_call_sessions_pending_transcript[\s\S]*?;/);
    expect(indexBlock).not.toBeNull();
    expect(indexBlock[0]).not.toMatch(/\bnow\(\)/i);
    expect(indexBlock[0]).toMatch(/transcript_fetched_at IS NULL/);
  });

  it('contains a sanity DO block that aborts on policy count or default mismatch', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/expected 5 RLS policies/);
    expect(sql).toMatch(/default must reference default_org_id\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Rollback files exist and are non-empty
// ─────────────────────────────────────────────────────────────────

describe('Voice Phase 1 — rollback files', () => {
  for (const filename of ROLLBACK_FILES) {
    it(`has a rollback file: ${filename}`, () => {
      const path = join(ROLLBACK_DIR, filename);
      const contents = readFileSync(path, 'utf-8');
      expect(contents.length).toBeGreaterThan(100);
      // Every rollback ends with the destructive operation it reverses.
      expect(contents).toMatch(/DROP (TABLE|INDEX|POLICY)|ALTER TABLE[^;]+DROP COLUMN/);
    });
  }
});
