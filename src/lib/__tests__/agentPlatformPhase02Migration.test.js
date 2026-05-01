import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Agent Platform Phase 0.2 migration.
// As with Phase 0.1, the migration's own DO sanity blocks are the runtime
// safety net (every known-source row must end up stamped). This spec
// catches accidental deletion or mutation of those guards or the backfill
// heuristics in future PRs.
const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260503000000_agent_platform_phase_0_2_agent_id_columns.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260503000000_agent_platform_phase_0_2_agent_id_columns_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('Agent Platform Phase 0.2 — agent_id columns + backfill', () => {
  describe('column adds', () => {
    it('adds agent_id to all four AI-tier tables', () => {
      const targets = ['events', 'action_outcomes', 'ai_suggestions', 'context_memory'];
      for (const t of targets) {
        expect(sql, `missing ALTER TABLE for ${t}`).toMatch(
          new RegExp(`ALTER TABLE public\\.${t}\\s+ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public\\.agents\\(id\\)`)
        );
      }
    });

    it('keeps agent_id NULLABLE in this phase', () => {
      // Phase 0.2 is intentionally nullable. NOT NULL is deferred to a
      // later phase after every insert path is audited.
      expect(sql).not.toMatch(/agent_id uuid[^,;]*NOT NULL/);
      expect(sql).not.toMatch(/ALTER COLUMN agent_id SET NOT NULL/);
    });

    it('uses IF NOT EXISTS for idempotent column adds', () => {
      const adds = (sql.match(/ADD COLUMN IF NOT EXISTS agent_id/g) ?? []).length;
      expect(adds).toBe(4);
    });

    it('references public.agents(id) (not a hardcoded uuid or wrong table)', () => {
      const fkRefs = (sql.match(/REFERENCES public\.agents\(id\)/g) ?? []).length;
      expect(fkRefs).toBe(4);
    });
  });

  describe('indexes', () => {
    it('creates idx_<table>_org_agent_time on each of the four tables', () => {
      const targets = [
        'idx_events_org_agent_time',
        'idx_action_outcomes_org_agent_time',
        'idx_ai_suggestions_org_agent_time',
        'idx_context_memory_org_agent_time',
      ];
      for (const ix of targets) {
        expect(sql, `missing index ${ix}`).toMatch(
          new RegExp(`CREATE INDEX IF NOT EXISTS ${ix}\\s+ON public\\.\\w+\\s*\\(org_id, agent_id, created_at DESC\\)`)
        );
      }
    });
  });

  describe('backfill heuristics', () => {
    it('resolves agent ids inside a DO block (one lookup per agent)', () => {
      // We do this once per migration run, not per row. Lock the pattern.
      expect(sql).toMatch(/v_recruiting_id\s+uuid;/);
      expect(sql).toMatch(/v_planner_id\s+uuid;/);
      expect(sql).toMatch(/v_router_id\s+uuid;/);
      expect(sql).toMatch(/SELECT id INTO v_recruiting_id FROM public\.agents\s+WHERE org_id = v_org AND slug = 'recruiting'/);
      expect(sql).toMatch(/SELECT id INTO v_planner_id\s+FROM public\.agents\s+WHERE org_id = v_org AND slug = 'proactive_planner'/);
      expect(sql).toMatch(/SELECT id INTO v_router_id\s+FROM public\.agents\s+WHERE org_id = v_org AND slug = 'inbound_router'/);
    });

    it('aborts backfill if any of the three seeded agents is missing', () => {
      expect(sql).toMatch(/IF v_recruiting_id IS NULL OR v_planner_id IS NULL OR v_router_id IS NULL/);
      expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*missing seeded agents/);
    });

    it('stamps inbound_sms and inbound_email ai_suggestions to the router', () => {
      expect(sql).toMatch(
        /UPDATE public\.ai_suggestions\s+SET agent_id = v_router_id[\s\S]*?source_type IN \('inbound_sms', 'inbound_email'\)/
      );
    });

    it('stamps proactive, event_triggered, and outcome ai_suggestions to the planner', () => {
      expect(sql).toMatch(
        /UPDATE public\.ai_suggestions\s+SET agent_id = v_planner_id[\s\S]*?source_type IN \('proactive', 'event_triggered', 'outcome'\)/
      );
    });

    it('stamps source=ai_chat action_outcomes to the recruiting agent', () => {
      expect(sql).toMatch(
        /UPDATE public\.action_outcomes\s+SET agent_id = v_recruiting_id[\s\S]*?source = 'ai_chat'/
      );
    });

    it('does NOT stamp source=automation or source=manual action_outcomes', () => {
      // Those rows are not agent-caused. Locking the absence prevents a
      // future PR from sweeping them in incorrectly.
      const outcomesUpdates = sql.match(
        /UPDATE public\.action_outcomes[\s\S]*?(?=UPDATE|RAISE NOTICE|END \$\$)/g
      );
      const concatenated = (outcomesUpdates ?? []).join('\n');
      expect(concatenated).not.toMatch(/source = 'automation'/);
      expect(concatenated).not.toMatch(/source = 'manual'/);
    });

    it('stamps events by narrow actor LIKE patterns only', () => {
      expect(sql).toMatch(/UPDATE public\.events\s+SET agent_id = v_planner_id[\s\S]*?actor LIKE 'system:ai-planner%'/);
      expect(sql).toMatch(/UPDATE public\.events\s+SET agent_id = v_router_id[\s\S]*?actor LIKE 'system:message-router%'/);
      expect(sql).toMatch(/UPDATE public\.events\s+SET agent_id = v_recruiting_id[\s\S]*?actor LIKE 'system:ai-chat%'/);
    });

    it('does NOT blanket-stamp user:* or caregiver:* events to an agent', () => {
      // user:* and caregiver:* events come from direct portal actions and
      // caregiver self-service, not from agents. Stamping them would lie
      // about provenance. Locking the absence prevents drift.
      const eventsUpdates = sql.match(
        /UPDATE public\.events[\s\S]*?(?=UPDATE|context_memory:|--)/g
      );
      const concatenated = (eventsUpdates ?? []).join('\n');
      expect(concatenated).not.toMatch(/actor LIKE 'user:/);
      expect(concatenated).not.toMatch(/actor LIKE 'caregiver:/);
    });

    it('does NOT update context_memory rows (zero rows in production today)', () => {
      // context_memory has no rows to backfill. The runtime in Phase 0.4
      // stamps future writes. Lock that no UPDATE is issued here.
      expect(sql).not.toMatch(/UPDATE public\.context_memory/);
    });

    it('every UPDATE filters on agent_id IS NULL (idempotent re-run)', () => {
      const updates = sql.match(/UPDATE public\.\w+\s+SET agent_id =[\s\S]*?(?=UPDATE|END \$\$)/g) ?? [];
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(u, `UPDATE missing agent_id IS NULL guard:\n${u}`).toMatch(/agent_id IS NULL/);
      }
    });

    it('every UPDATE filters on org_id = v_org (tenant scope)', () => {
      const updates = sql.match(/UPDATE public\.\w+\s+SET agent_id =[\s\S]*?(?=UPDATE|END \$\$)/g) ?? [];
      for (const u of updates) {
        expect(u, `UPDATE missing org_id scope:\n${u}`).toMatch(/org_id = v_org/);
      }
    });
  });

  describe('sanity checks', () => {
    it('aborts if any ai_suggestions row with a known source_type is unstamped', () => {
      expect(sql).toMatch(/v_unstamped_suggestions[\s\S]*?source_type IN \('inbound_sms', 'inbound_email', 'proactive', 'event_triggered', 'outcome'\)/);
      expect(sql).toMatch(/Phase 0\.2 sanity check failed: % ai_suggestions rows have known source_type but no agent_id stamped/);
    });

    it('aborts if any action_outcomes row with source=ai_chat is unstamped', () => {
      expect(sql).toMatch(/v_unstamped_outcomes[\s\S]*?source = 'ai_chat'/);
      expect(sql).toMatch(/Phase 0\.2 sanity check failed: % action_outcomes rows with source=ai_chat have no agent_id stamped/);
    });

    it('reports events stamped vs unattributable counts (NOTICE, not EXCEPTION)', () => {
      // Today no events match the system:ai-* patterns, so failing on a
      // count would force this migration to never apply. NOTICE keeps the
      // diagnostic without blocking deploy.
      expect(sql).toMatch(/RAISE NOTICE[\s\S]*?Phase 0\.2 events backfill: % stamped, % unattributable/);
    });
  });

  describe('non-destructiveness (additive only)', () => {
    it('never drops a column or table', () => {
      expect(sql).not.toMatch(/DROP TABLE/);
      expect(sql).not.toMatch(/DROP COLUMN/);
    });

    it('never modifies a non-target column', () => {
      // The only ALTER TABLE statements should be the four ADD COLUMN agent_id.
      const alters = sql.match(/ALTER TABLE\s+public\.\w+\s+[^;]+/g) ?? [];
      expect(alters.length).toBe(4);
      for (const a of alters) {
        expect(a, `unexpected ALTER TABLE:\n${a}`).toMatch(/ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public\.agents\(id\)/);
      }
    });

    it('never deletes data', () => {
      expect(sql).not.toMatch(/DELETE FROM/);
      expect(sql).not.toMatch(/TRUNCATE/);
    });

    it('never modifies any RLS policy or function', () => {
      expect(sql).not.toMatch(/CREATE POLICY/);
      expect(sql).not.toMatch(/DROP POLICY/);
      expect(sql).not.toMatch(/ALTER POLICY/);
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/);
      expect(sql).not.toMatch(/DROP FUNCTION/);
    });

    it('never touches the agents or agent_versions tables', () => {
      // Phase 0.2 only reads agents (to resolve seeded ids). It never
      // writes to or alters those tables — Phase 0.1's territory.
      expect(sql).not.toMatch(/INSERT INTO public\.agents\b/);
      expect(sql).not.toMatch(/UPDATE public\.agents\b/);
      expect(sql).not.toMatch(/ALTER TABLE public\.agents\b/);
      expect(sql).not.toMatch(/INSERT INTO public\.agent_versions/);
      expect(sql).not.toMatch(/UPDATE public\.agent_versions/);
      expect(sql).not.toMatch(/ALTER TABLE public\.agent_versions/);
    });
  });
});

describe('Agent Platform Phase 0.2 — rollback script', () => {
  it('drops the indexes before the columns', () => {
    const indexDrop = rollback.indexOf('DROP INDEX IF EXISTS public.idx_events_org_agent_time');
    const columnDrop = rollback.indexOf('DROP COLUMN IF EXISTS agent_id');
    expect(indexDrop).toBeGreaterThan(-1);
    expect(columnDrop).toBeGreaterThan(-1);
    expect(indexDrop).toBeLessThan(columnDrop);
  });

  it('drops agent_id from all four AI-tier tables', () => {
    const targets = ['events', 'action_outcomes', 'ai_suggestions', 'context_memory'];
    for (const t of targets) {
      expect(rollback, `rollback missing DROP for ${t}`).toMatch(
        new RegExp(`ALTER TABLE public\\.${t}\\s+DROP COLUMN IF EXISTS agent_id`)
      );
    }
  });

  it('drops all four supporting indexes', () => {
    const indexes = [
      'idx_events_org_agent_time',
      'idx_action_outcomes_org_agent_time',
      'idx_ai_suggestions_org_agent_time',
      'idx_context_memory_org_agent_time',
    ];
    for (const ix of indexes) {
      expect(rollback).toMatch(new RegExp(`DROP INDEX IF EXISTS public\\.${ix}`));
    }
  });

  it('runs in a transaction', () => {
    expect(rollback).toMatch(/^BEGIN;/m);
    expect(rollback).toMatch(/^COMMIT;/m);
  });

  it('does not touch agents or agent_versions tables (separate down script)', () => {
    expect(rollback).not.toMatch(/DROP TABLE.*public\.agents\b/);
    expect(rollback).not.toMatch(/DROP TABLE.*public\.agent_versions/);
  });
});
