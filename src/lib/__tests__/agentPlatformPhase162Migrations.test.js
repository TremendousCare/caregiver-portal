/**
 * Phase 1.6.2 — call_analyst migrations.
 *
 * Structural assertions on:
 *   * ai_suggestions.source_type CHECK extension (adds 'call_analyst')
 *   * agents row seed for the call_analyst extractor + version snapshot
 *
 * Runtime semantics (CHECK enforcement on bad rows, kill_switch posture)
 * are verified in the Supabase SQL editor pre-merge per CLAUDE.md →
 * RLS Safety.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_TYPE_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516020000_agent_platform_phase_1_6_2_ai_suggestions_source_type_call_analyst.sql',
);
const SOURCE_TYPE_ROLLBACK = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516020000_agent_platform_phase_1_6_2_ai_suggestions_source_type_call_analyst_down.sql',
);
const AGENT_SEED_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516020001_agent_platform_phase_1_6_2_seed_call_analyst_agent.sql',
);
const AGENT_SEED_ROLLBACK = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516020001_agent_platform_phase_1_6_2_seed_call_analyst_agent_down.sql',
);

const sourceTypeSql   = readFileSync(SOURCE_TYPE_PATH, 'utf-8');
const sourceTypeBack  = readFileSync(SOURCE_TYPE_ROLLBACK, 'utf-8');
const agentSeedSql    = readFileSync(AGENT_SEED_PATH, 'utf-8');
const agentSeedBack   = readFileSync(AGENT_SEED_ROLLBACK, 'utf-8');

describe('ai_suggestions.source_type extension — schema', () => {
  it('drops the existing CHECK by name (dynamic, idempotent)', () => {
    expect(sourceTypeSql).toMatch(/SELECT 1 FROM pg_constraint[\s\S]*?contype\s+=\s*'c'[\s\S]*?source_type/);
    expect(sourceTypeSql).toMatch(/ALTER TABLE public\.ai_suggestions DROP CONSTRAINT/);
  });

  it('recreates the CHECK with the full six-value enum (including event_triggered)', () => {
    // The pre-1.6.2 production enum is FIVE values — the original
    // four from migration 20260311200407 plus 'event_triggered' added
    // later by 20260321220555_fix_source_type_constraint.sql when the
    // proactive planner started writing event-triggered suggestions.
    // The 1.6.2 migration must include all five plus 'call_analyst'.
    // (The first version of this migration dropped 'event_triggered'
    // and the production deploy rolled back because rows already used
    // it — see commit history.)
    expect(sourceTypeSql).toMatch(/CHECK \(source_type IN \(/);
    for (const value of [
      'inbound_sms', 'inbound_email', 'proactive', 'outcome',
      'event_triggered', 'call_analyst',
    ]) {
      expect(sourceTypeSql).toContain(`'${value}'`);
    }
  });

  it('runs a sanity DO block that fails the migration if call_analyst is absent', () => {
    expect(sourceTypeSql).toMatch(/ai_suggestions source_type extension failed/);
    expect(sourceTypeSql).toMatch(/call_analyst not present in CHECK/);
  });

  it('runs a sanity DO block that fails the migration if event_triggered is missing (regression guard)', () => {
    expect(sourceTypeSql).toMatch(/event_triggered missing from CHECK/);
  });
});

describe('ai_suggestions.source_type extension — rollback', () => {
  it('restores the pre-1.6.2 five-value enum (NOT the original four)', () => {
    expect(sourceTypeBack).toMatch(/CHECK \(source_type IN \(/);
    for (const value of [
      'inbound_sms', 'inbound_email', 'proactive', 'outcome',
      'event_triggered',
    ]) {
      expect(sourceTypeBack).toContain(`'${value}'`);
    }
    // Critically: call_analyst is NOT in the recreated CHECK clause.
    // (The header comment mentions it explanatorily; we strip
    //  comments before checking so the regex doesn't false-positive.)
    const noComments = sourceTypeBack
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(noComments).not.toMatch(/'call_analyst'/);
  });
});

describe('call_analyst agent seed — schema + content', () => {
  it('inserts into the agents table with ON CONFLICT (org_id, slug) DO NOTHING', () => {
    expect(agentSeedSql).toMatch(/INSERT INTO public\.agents/);
    expect(agentSeedSql).toMatch(/ON CONFLICT \(org_id, slug\) DO NOTHING/);
  });

  it('uses default_org_id() for tenancy', () => {
    expect(agentSeedSql).toMatch(/public\.default_org_id\(\)/);
  });

  it('seeds the canonical agent slug + name', () => {
    expect(agentSeedSql).toMatch(/'call_analyst'/);
    expect(agentSeedSql).toMatch(/'Call Analyst'/);
  });

  it('locks kill_switch=true and shadow_mode=true on the initial seed', () => {
    // The DO block at the bottom asserts both invariants at migration time.
    expect(agentSeedSql).toMatch(/kill_switch must be true on initial seed/);
    expect(agentSeedSql).toMatch(/shadow_mode must be true on initial seed/);
  });

  it('uses the Haiku 4.5 model', () => {
    expect(agentSeedSql).toContain('claude-haiku-4-5-20251001');
    expect(agentSeedSql).toMatch(/expected Haiku model/);
  });

  it('declares the call_analyst tool_allowlist with submit_call_analysis', () => {
    expect(agentSeedSql).toContain("'submit_call_analysis'");
    expect(agentSeedSql).toContain("'get_call_transcription'");
    expect(agentSeedSql).toContain("'get_call_recording'");
    expect(agentSeedSql).toContain("'get_caregiver_detail'");
    expect(agentSeedSql).toContain("'get_client_detail'");
  });

  it('locks submit_call_analysis at L1 in the autonomy_profile', () => {
    // Match the JSON-build form: 'submit_call_analysis', ... 'current_level', 'L1'.
    expect(agentSeedSql).toMatch(/'submit_call_analysis'[\s\S]{0,400}?'current_level',\s*'L1'/);
  });

  it('wires the event_triggered invocation mode + post-call-processor invoker', () => {
    expect(agentSeedSql).toMatch(/'invocation_modes'[\s\S]{0,200}?'event_triggered'/);
    expect(agentSeedSql).toContain('call_session.transcript_fetched_at');
    expect(agentSeedSql).toContain('null_to_not_null');
    expect(agentSeedSql).toContain('supabase/functions/post-call-processor/index.ts');
    expect(agentSeedSql).toContain('call_sessions.ai_summary IS NULL');
  });

  it('declares outcome primary signal as ai_suggestion_status_changed', () => {
    expect(agentSeedSql).toContain("'ai_suggestion_status_changed'");
    expect(agentSeedSql).toMatch(/'from_status'[\s\S]{0,100}?'pending'/);
    expect(agentSeedSql).toMatch(/'to_status_in'[\s\S]{0,200}?'approved'[\s\S]{0,200}?'executed'/);
    expect(agentSeedSql).toMatch(/'window_days'[\s\S]{0,20}?7/);
  });

  it('seeds an agent_versions snapshot via the canonical SELECT pattern', () => {
    expect(agentSeedSql).toMatch(/INSERT INTO public\.agent_versions/);
    expect(agentSeedSql).toMatch(/to_jsonb\(a\) - 'created_at' - 'updated_at'/);
    expect(agentSeedSql).toContain('Initial seed (Phase 1.6.2)');
    expect(agentSeedSql).toMatch(/ON CONFLICT \(agent_id, version\) DO NOTHING/);
  });
});

describe('call_analyst agent seed — rollback', () => {
  it('deletes the version snapshot before the agent row', () => {
    const deleteVersionPos = agentSeedBack.indexOf('DELETE FROM public.agent_versions');
    const deleteAgentPos   = agentSeedBack.indexOf('DELETE FROM public.agents');
    expect(deleteVersionPos).toBeGreaterThan(-1);
    expect(deleteAgentPos).toBeGreaterThan(-1);
    expect(deleteVersionPos).toBeLessThan(deleteAgentPos);
  });

  it('scopes deletes to the Tremendous Care org_id + call_analyst slug', () => {
    expect(agentSeedBack).toMatch(/org_id = public\.default_org_id\(\)/);
    expect(agentSeedBack).toContain("'call_analyst'");
  });
});
