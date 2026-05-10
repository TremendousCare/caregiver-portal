// Phase 1.1.B — structural assertions for the new migrations.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../../supabase/migrations');
const rollbackDir = join(migrationsDir, '_rollback');

const anonSql = readFileSync(join(migrationsDir, '20260510070000_agent_platform_phase_1_1_b_anon_privilege_cleanup.sql'), 'utf-8');
const anonDownSql = readFileSync(join(rollbackDir, '20260510070000_agent_platform_phase_1_1_b_anon_privilege_cleanup_down.sql'), 'utf-8');
const cronSql = readFileSync(join(migrationsDir, '20260510080000_agent_platform_phase_1_1_b_verify_cron.sql'), 'utf-8');
const cronDownSql = readFileSync(join(rollbackDir, '20260510080000_agent_platform_phase_1_1_b_verify_cron_down.sql'), 'utf-8');

describe('Phase 1.1.B — anon privilege cleanup migration', () => {
  const tables = ['agents', 'agent_versions', 'agent_actions'];
  const privileges = ['INSERT', 'UPDATE', 'DELETE'];

  for (const table of tables) {
    for (const priv of privileges) {
      it(`revokes ${priv} on public.${table} from anon`, () => {
        expect(anonSql).toMatch(
          new RegExp(`REVOKE[^;]*\\b${priv}\\b[^;]*ON public\\.${table}\\b[^;]*FROM anon`, 'i')
        );
      });
    }
  }

  it('does NOT revoke SELECT (anon read still possible; RLS denies the rows)', () => {
    expect(anonSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agents/i);
    expect(anonSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agent_versions/i);
    expect(anonSql).not.toMatch(/REVOKE[^;]*\bSELECT\b[^;]*ON public\.agent_actions/i);
  });

  it('has a sanity DO block that aborts deploy if REVOKE failed', () => {
    expect(anonSql).toMatch(/information_schema\.table_privileges/);
    expect(anonSql).toMatch(/grantee = 'anon'/);
    expect(anonSql).toMatch(/RAISE EXCEPTION/);
  });

  it('rollback re-grants the three privileges on all three tables', () => {
    for (const table of tables) {
      for (const priv of privileges) {
        expect(anonDownSql).toMatch(
          new RegExp(`GRANT[^;]*\\b${priv}\\b[^;]*ON public\\.${table}\\b[^;]*TO anon`, 'i')
        );
      }
    }
  });
});

describe('Phase 1.1.B — agent-actions-verify cron migration', () => {
  it('schedules a job named agent-actions-verify', () => {
    expect(cronSql).toMatch(/cron\.schedule\(\s*'agent-actions-verify'/);
  });

  it('runs daily at 13:30 UTC', () => {
    expect(cronSql).toMatch(/'30 13 \* \* \*'/);
  });

  it('POSTs to /functions/v1/agent-actions-verify via pg_net', () => {
    expect(cronSql).toMatch(/net\.http_post/);
    expect(cronSql).toMatch(/\/functions\/v1\/agent-actions-verify/);
  });

  it('uses Vault-stored project_url + publishable_key (matches existing cron pattern)', () => {
    expect(cronSql).toMatch(/vault\.decrypted_secrets[\s\S]*?'project_url'/);
    expect(cronSql).toMatch(/vault\.decrypted_secrets[\s\S]*?'publishable_key'/);
  });

  it('rollback unschedules the job', () => {
    expect(cronDownSql).toMatch(/cron\.unschedule\(\s*'agent-actions-verify'\s*\)/);
  });
});
