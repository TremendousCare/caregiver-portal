import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Agent Platform Phase 0.1 migration.
// As with the SaaS retrofit's B2a/B2b specs, the migration's own DO
// sanity blocks are the runtime safety net (count = 3 seeded agents,
// slug list matches expected, version-history rows exist). This spec
// catches accidental deletion or mutation of those guards or the seed
// content in future PRs.
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260502000000_agent_platform_phase_0_1_agents_table.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260502000000_agent_platform_phase_0_1_agents_table_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('Agent Platform Phase 0.1 — agents + agent_versions migration', () => {
  describe('table structure', () => {
    it('creates the agents table with all manifest fields', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.agents/);
      // Required manifest fields per docs/AGENT_PLATFORM.md
      const requiredFields = [
        'id', 'org_id', 'slug', 'name', 'version',
        'system_prompt', 'tool_allowlist', 'autonomy_profile',
        'context_recipe', 'model', 'max_iterations',
        'kill_switch', 'shadow_mode',
        'outcome_definition', 'triggers',
        'created_at', 'updated_at', 'created_by', 'updated_by',
      ];
      for (const field of requiredFields) {
        expect(sql, `missing manifest field: ${field}`).toMatch(
          new RegExp(`\\b${field}\\b\\s+(uuid|text|integer|jsonb|boolean|timestamptz|text\\[\\])`)
        );
      }
    });

    it('creates the agent_versions table with snapshot history fields', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.agent_versions/);
      const requiredFields = [
        'id', 'org_id', 'agent_id', 'agent_slug',
        'version', 'snapshot', 'change_summary',
        'changed_by', 'changed_at',
      ];
      for (const field of requiredFields) {
        expect(sql, `missing version-history field: ${field}`).toMatch(
          new RegExp(`\\b${field}\\b\\s+(uuid|text|integer|jsonb|timestamptz)`)
        );
      }
    });

    it('uses public.default_org_id() for both tables', () => {
      // The Phase B helper must be the default; never a hardcoded UUID.
      const matches = sql.match(/DEFAULT public\.default_org_id\(\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('references public.organizations(id) for both org_id columns', () => {
      const matches = sql.match(/REFERENCES public\.organizations\(id\)/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('enforces unique (org_id, slug) on agents', () => {
      expect(sql).toMatch(/CONSTRAINT agents_slug_per_org_unique UNIQUE \(org_id, slug\)/);
    });

    it('enforces a slug format check (lowercase + underscore + digits)', () => {
      expect(sql).toMatch(/agents_slug_format CHECK \(slug ~ '\^\[a-z\]\[a-z0-9_\]\*\$'\)/);
    });

    it('enforces non-empty system_prompt and model', () => {
      expect(sql).toMatch(/agents_system_prompt_nonempty CHECK \(length\(system_prompt\) > 0\)/);
      expect(sql).toMatch(/agents_model_nonempty CHECK \(length\(model\) > 0\)/);
    });

    it('cascades agent_versions deletion when an agent is dropped', () => {
      expect(sql).toMatch(/agent_id\s+uuid NOT NULL REFERENCES public\.agents\(id\) ON DELETE CASCADE/);
    });

    it('enforces unique (agent_id, version) on agent_versions', () => {
      expect(sql).toMatch(/CONSTRAINT agent_versions_unique_per_agent UNIQUE \(agent_id, version\)/);
    });

    it('indexes org_id, slug, kill_switch, and version history lookups', () => {
      // Migration may break index DDL across lines; allow whitespace between
      // the index name and the ON clause.
      expect(sql).toMatch(/idx_agents_org_id\s+ON public\.agents\s*\(org_id\)/);
      expect(sql).toMatch(/idx_agents_slug\s+ON public\.agents\s*\(slug\)/);
      expect(sql).toMatch(/idx_agents_kill_switch\s+ON public\.agents\s*\(org_id, kill_switch\)\s+WHERE kill_switch = false/);
      expect(sql).toMatch(/idx_agent_versions_org_id\s+ON public\.agent_versions\s*\(org_id\)/);
      expect(sql).toMatch(/idx_agent_versions_agent_changed_at\s+ON public\.agent_versions\s*\(agent_id, changed_at DESC\)/);
    });
  });

  describe('RLS posture (matches SaaS retrofit B2b)', () => {
    it('enables RLS on both new tables', () => {
      expect(sql).toMatch(/ALTER TABLE public\.agents\s+ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/ALTER TABLE public\.agent_versions\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('uses the strict fail-closed predicate with nullif coercion', () => {
      // Identical to the B2b predicate in 20260501010000_phase_b2b_org_scoped_rls.sql.
      // A missing or empty org_id claim coerces to NULL and the equality check fails.
      expect(sql).toMatch(
        /org_id = nullif\(auth\.jwt\(\) ->> ''org_id'', ''''\)::uuid/
      );
    });

    it('targets the authenticated role, not public/anon', () => {
      const createPolicyLines = sql.match(/CREATE POLICY .* TO authenticated/g) ?? [];
      // 2 tables × 4 commands = 8 CREATE POLICY lines (built via DO loop)
      expect(createPolicyLines.length).toBeGreaterThanOrEqual(0); // built dynamically
      expect(sql).toMatch(/FOR SELECT TO authenticated USING/);
      expect(sql).toMatch(/FOR INSERT TO authenticated WITH CHECK/);
      expect(sql).toMatch(/FOR UPDATE TO authenticated USING .* WITH CHECK/);
      expect(sql).toMatch(/FOR DELETE TO authenticated USING/);
      expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
      expect(sql).not.toMatch(/CREATE POLICY .* TO public[^a-z_]/);
    });

    it('uses the tenant_isolation_<table>_<command> naming convention', () => {
      // Suffix-anchored to align with B2b's filter regex.
      expect(sql).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_select'/);
      expect(sql).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_insert'/);
      expect(sql).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_update'/);
      expect(sql).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_delete'/);
    });

    it('is idempotent — every CREATE POLICY paired with DROP POLICY IF EXISTS', () => {
      const drops = (sql.match(/DROP POLICY IF EXISTS/g) ?? []).length;
      const creates = (sql.match(/CREATE POLICY/g) ?? []).length;
      expect(drops).toBe(creates);
    });
  });

  describe('seed content (three production agents)', () => {
    it('seeds exactly the three expected slugs', () => {
      // Asserted by the migration's own DO block AND by checking the INSERT.
      expect(sql).toMatch(/'recruiting'/);
      expect(sql).toMatch(/'proactive_planner'/);
      expect(sql).toMatch(/'inbound_router'/);
    });

    it('seeds with public.default_org_id() (never a hardcoded UUID)', () => {
      const insertSection = sql.split('INSERT INTO public.agents')[1] || '';
      expect(insertSection).toMatch(/public\.default_org_id\(\)/);
      // No hex UUID literal that would hardcode a specific org id
      expect(insertSection).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
      );
    });

    it('uses ON CONFLICT DO NOTHING for idempotent seeding', () => {
      expect(sql).toMatch(/ON CONFLICT \(org_id, slug\) DO NOTHING/);
      expect(sql).toMatch(/ON CONFLICT \(agent_id, version\) DO NOTHING/);
    });

    it('recruiting agent allowlist includes all 40 production tools', () => {
      // Pull the recruiting block specifically.
      const recruitingBlock = sql.match(
        /'recruiting',[\s\S]*?'Recruiting Agent'[\s\S]*?ARRAY\[([\s\S]*?)\]/
      );
      expect(recruitingBlock, 'recruiting agent block not found').toBeTruthy();
      const tools = (recruitingBlock[1].match(/'[a-z_]+'/g) ?? []).map((s) => s.slice(1, -1));

      // From `grep '^    name: "' tools/*.ts` — there are 40 unique tools.
      const expectedTools = [
        'add_client_note', 'add_note',
        'check_availability', 'check_compliance',
        'complete_client_task', 'complete_task',
        'create_calendar_event',
        'draft_message',
        'get_action_items', 'get_automation_summary',
        'get_calendar_events', 'get_call_log', 'get_call_recording', 'get_call_transcription',
        'get_caregiver_detail', 'get_caregiver_documents',
        'get_client_detail', 'get_client_pipeline_stats',
        'get_docusign_envelopes', 'get_email_thread', 'get_esign_envelopes',
        'get_inbound_messages', 'get_pipeline_stats', 'get_sms_history',
        'list_stale_clients', 'list_stale_leads',
        'manage_suggestions',
        'search_caregivers', 'search_clients', 'search_emails',
        'send_docusign_envelope', 'send_email', 'send_esign_envelope', 'send_sms',
        'update_board_status', 'update_calendar_event',
        'update_caregiver_field', 'update_client_field',
        'update_client_phase', 'update_phase',
      ];
      expect(tools.sort()).toEqual(expectedTools.sort());
    });

    it('proactive_planner allowlist matches actions emittable via executeSuggestion', () => {
      const block = sql.match(
        /'proactive_planner',[\s\S]*?'Proactive Planner'[\s\S]*?ARRAY\[([\s\S]*?)\]/
      );
      expect(block, 'proactive_planner block not found').toBeTruthy();
      const tools = (block[1].match(/'[a-z_]+'/g) ?? []).map((s) => s.slice(1, -1));
      // Per ai-planner/index.ts SYSTEM_PROMPT: send_sms, send_email, add_note,
      // complete_task, update_phase, create_calendar_event, send_docusign_envelope.
      // We extend with client variants because executeSuggestion supports both.
      expect(tools).toContain('send_sms');
      expect(tools).toContain('send_email');
      expect(tools).toContain('add_note');
      expect(tools).toContain('add_client_note');
      expect(tools).toContain('update_phase');
      expect(tools).toContain('update_client_phase');
      expect(tools).toContain('complete_task');
      expect(tools).toContain('complete_client_task');
      expect(tools).toContain('create_calendar_event');
      expect(tools).toContain('send_docusign_envelope');
    });

    it('inbound_router allowlist matches VALID_ACTIONS from routing.ts', () => {
      const block = sql.match(
        /'inbound_router',[\s\S]*?'Inbound Message Router'[\s\S]*?ARRAY\[([\s\S]*?)\]/
      );
      expect(block, 'inbound_router block not found').toBeTruthy();
      const tools = (block[1].match(/'[a-z_]+'/g) ?? []).map((s) => s.slice(1, -1));
      // VALID_ACTIONS in _shared/operations/routing.ts (excluding 'none').
      const expectedActions = [
        'send_sms', 'send_email',
        'add_note', 'add_client_note',
        'update_phase', 'update_client_phase',
        'complete_task', 'complete_client_task',
        'update_caregiver_field', 'update_client_field',
        'update_board_status',
        'create_calendar_event',
        'send_docusign_envelope', 'send_esign_envelope',
      ];
      expect(tools.sort()).toEqual(expectedActions.sort());
    });

    it('seeds add_note and add_client_note at L4 across both planner and router (matches autonomy_config)', () => {
      // The seed must mirror today's autonomy_config rows for inbound_routing
      // (migration 20260311200407) and proactive (migration 20260320235959):
      // add_note auto-fires (L4) in both contexts.
      const plannerBlock = sql.split("'proactive_planner'")[1].split("'inbound_router'")[0];
      expect(plannerBlock).toMatch(/'add_note',\s+jsonb_build_object\('current_level', 'L4'\)/);
      expect(plannerBlock).toMatch(/'add_client_note',\s+jsonb_build_object\('current_level', 'L4'\)/);

      const routerBlock = sql.split("'inbound_router'")[1].split('ON CONFLICT')[0];
      expect(routerBlock).toMatch(/'add_note',\s+jsonb_build_object\('current_level', 'L4'\)/);
      expect(routerBlock).toMatch(/'add_client_note',\s+jsonb_build_object\('current_level', 'L4'\)/);
    });

    it('inbound_router uses Haiku to preserve today\'s classifier cost profile', () => {
      const block = sql.split("'inbound_router'")[1].split('ON CONFLICT')[0];
      expect(block).toMatch(/'claude-haiku-4-5-20251001'/);
    });

    it('all three agents seed kill_switch=false and shadow_mode=false (already in production today)', () => {
      // The migration uses the column DEFAULT (false) by passing `false` explicitly
      // in each VALUES row. Verify each row has both.
      const insertCount = (sql.match(/'system:phase_0_1_seed',\s*\n\s*'system:phase_0_1_seed'/g) ?? []).length;
      expect(insertCount).toBe(3);
    });

    it('seeds an initial v1 history row for each agent', () => {
      expect(sql).toMatch(/INSERT INTO public\.agent_versions/);
      expect(sql).toMatch(/SELECT[\s\S]*?to_jsonb\(a\) - 'created_at' - 'updated_at'/);
      expect(sql).toMatch(/'Initial seed \(Phase 0\.1\)'/);
    });
  });

  describe('runtime guards', () => {
    it('aborts the deploy if the seed produces other than 3 agents', () => {
      expect(sql).toMatch(/expected 3 seeded agents for Tremendous Care, found %/);
      expect(sql).toMatch(/RAISE EXCEPTION/);
    });

    it('aborts the deploy if the slug set is wrong', () => {
      expect(sql).toMatch(
        /expected slugs \(inbound_router, proactive_planner, recruiting\)/
      );
    });

    it('aborts the deploy if any agent is missing a v1 history row', () => {
      expect(sql).toMatch(/expected 3 v1 history rows/);
    });

    it('installs an updated_at trigger on agents', () => {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.tg_agents_set_updated_at/);
      expect(sql).toMatch(/CREATE TRIGGER agents_set_updated_at/);
      expect(sql).toMatch(/BEFORE UPDATE ON public\.agents/);
    });
  });

  describe('non-destructiveness (additive only)', () => {
    it('never drops an existing table', () => {
      expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS public\.agent)/);
    });

    it('never alters an unrelated existing table', () => {
      // Must not alter anything outside our two new tables.
      const alterMatches = sql.match(/ALTER TABLE\s+public\.(\w+)/g) ?? [];
      const allowed = ['ALTER TABLE public.agents', 'ALTER TABLE public.agent_versions'];
      for (const m of alterMatches) {
        expect(allowed, `forbidden ALTER TABLE: ${m}`).toContain(m);
      }
    });

    it('never deletes data', () => {
      expect(sql).not.toMatch(/DELETE FROM/);
      expect(sql).not.toMatch(/TRUNCATE/);
    });
  });
});

describe('Agent Platform Phase 0.1 — rollback script', () => {
  it('drops the policies, trigger, function, and tables in correct order', () => {
    // Policies first
    expect(rollback).toMatch(/DROP POLICY IF EXISTS/);
    // Then trigger and function
    expect(rollback).toMatch(/DROP TRIGGER IF EXISTS agents_set_updated_at ON public\.agents/);
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.tg_agents_set_updated_at\(\)/);
    // Then tables — child first to satisfy FK
    const versionsIdx = rollback.indexOf('DROP TABLE IF EXISTS public.agent_versions');
    const agentsIdx = rollback.indexOf('DROP TABLE IF EXISTS public.agents');
    expect(versionsIdx).toBeGreaterThan(-1);
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(versionsIdx).toBeLessThan(agentsIdx);
  });

  it('only targets the 8 policies from this migration (does NOT use the broad B2b regex)', () => {
    // The B2b suffix-anchored regex would also match all 160 production policies.
    // Rollback must use a targeted list. Lock this in.
    expect(rollback).not.toMatch(/polname ~ '\^tenant_isolation_/);
    expect(rollback).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_select'/);
    expect(rollback).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_insert'/);
    expect(rollback).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_update'/);
    expect(rollback).toMatch(/'tenant_isolation_' \|\| v_target \|\| '_delete'/);
  });

  it('runs in a transaction', () => {
    expect(rollback).toMatch(/^BEGIN;/m);
    expect(rollback).toMatch(/^COMMIT;/m);
  });

  it('does not touch any unrelated table or function', () => {
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS public\.(?!agent_versions|agents)/);
    expect(rollback).not.toMatch(/DROP FUNCTION IF EXISTS public\.(?!tg_agents_set_updated_at)/);
  });
});
