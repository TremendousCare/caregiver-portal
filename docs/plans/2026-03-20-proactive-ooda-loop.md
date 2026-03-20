# Phase 4: Proactive OODA Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a daily Sonnet-powered AI planner that analyzes the full pipeline, reads Action Item Rules and Automation Rules as context, and generates up to 7 high-impact suggestions per day — all flowing through existing autonomy_config guardrails and executeSuggestion engine.

**Architecture:** New `ai-planner` Edge Function (daily cron, 7am PT). Reads pipeline state + action_item_rules + automation_rules + business context → calls Sonnet for strategic analysis → creates `ai_suggestions` rows with source_type='proactive' → auto-executes at L3/L4 via existing `executeSuggestion()`. Shared helpers in `_shared/operations/planner.ts` handle pipeline summary building, dedup, and response parsing.

**Tech Stack:** Supabase (Postgres, pg_cron, Edge Functions/Deno), Claude Sonnet API, React (Vitest for tests)

---

## Task 1: Migration — Proactive planner infrastructure

**Files:**
- Create: `supabase/migrations/20260321_proactive_planner.sql`

**Step 1: Write the migration**

```sql
-- ── Proactive Planner Infrastructure ──

-- 1. Expand autonomy_config context CHECK to include 'proactive'
ALTER TABLE autonomy_config DROP CONSTRAINT IF EXISTS autonomy_config_context_check;
ALTER TABLE autonomy_config ADD CONSTRAINT autonomy_config_context_check
  CHECK (context IN ('inbound_routing', 'ai_chat', 'automation', 'proactive'));

-- 2. Seed proactive autonomy config rows (conservative defaults)
-- All start at L1 (suggest only) so the team reviews every suggestion initially
INSERT INTO autonomy_config (action_type, entity_type, context, autonomy_level, max_autonomy_level, auto_promote_threshold)
VALUES
  ('send_sms', 'caregiver', 'proactive', 'L1', 'L3', 10),
  ('send_sms', 'client', 'proactive', 'L1', 'L3', 10),
  ('send_email', 'caregiver', 'proactive', 'L1', 'L3', 10),
  ('send_email', 'client', 'proactive', 'L1', 'L3', 10),
  ('add_note', 'caregiver', 'proactive', 'L4', 'L4', 5),
  ('add_note', 'client', 'proactive', 'L4', 'L4', 5),
  ('complete_task', 'caregiver', 'proactive', 'L1', 'L2', 10),
  ('complete_task', 'client', 'proactive', 'L1', 'L2', 10),
  ('update_phase', 'caregiver', 'proactive', 'L1', 'L2', 15),
  ('update_phase', 'client', 'proactive', 'L1', 'L2', 15),
  ('create_calendar_event', 'caregiver', 'proactive', 'L1', 'L2', 10),
  ('create_calendar_event', 'client', 'proactive', 'L1', 'L2', 10),
  ('send_docusign_envelope', 'caregiver', 'proactive', 'L1', 'L1', 999)
ON CONFLICT (action_type, entity_type, context) DO NOTHING;

-- 3. Add planner app_settings keys
INSERT INTO app_settings (key, value)
VALUES
  ('planner_enabled', '"true"'),
  ('planner_max_suggestions', '7'),
  ('last_planner_run', 'null')
ON CONFLICT (key) DO NOTHING;
```

**Step 2: Apply migration** via Supabase MCP `apply_migration` tool.

**Step 3: Verify**

```sql
SELECT action_type, entity_type, context, autonomy_level, max_autonomy_level
FROM autonomy_config WHERE context = 'proactive' ORDER BY action_type;
-- Expect: 13 rows

SELECT key, value FROM app_settings WHERE key LIKE 'planner%';
-- Expect: planner_enabled = "true", planner_max_suggestions = 7
```

---

## Task 2: Shared planner helpers

**Files:**
- Create: `supabase/functions/_shared/operations/planner.ts`

**Step 1: Write the shared helpers**

```typescript
// ─── Proactive Planner Helpers ───
// Pure functions + DB queries used by the ai-planner Edge Function.
// Pipeline summary building, dedup, rule loading, response parsing.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ───

export interface PipelineEntity {
  id: string;
  name: string;
  entity_type: "caregiver" | "client";
  phase: string;
  days_in_phase: number;
  days_since_contact: number;
  last_contact_channel: string | null;
  incomplete_tasks: string[];
  total_tasks: number;
  completed_tasks: number;
  has_phone: boolean;
  has_email: boolean;
  active_alerts: string[];
  recent_outcomes: string[];
  board_status: string | null;
}

export interface PlannerSuggestion {
  entity_id: string;
  entity_type: "caregiver" | "client";
  entity_name: string;
  action_type: string;
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  drafted_content: string | null;
  action_params: Record<string, any>;
}

// ─── Pipeline Summary Builder ───

export function buildPipelineSummary(
  caregivers: any[],
  clients: any[],
  actionItemRules: any[],
  automationRules: any[],
  recentOutcomes: any[],
): { entities: PipelineEntity[]; rules_context: string; automation_context: string } {
  const now = Date.now();
  const entities: PipelineEntity[] = [];

  // Process caregivers
  for (const cg of caregivers) {
    if (cg.archived) continue;

    const phase = cg.phase_override || inferPhase(cg.phase_timestamps) || "Unknown";
    const daysInPhase = calculateDaysInPhase(cg.phase_timestamps, phase, now);
    const { daysSince, channel } = getLastContact(cg.notes, cg.created_at, now);
    const { incomplete, total, completed } = getTaskProgress(cg.tasks);
    const alerts = evaluateAlerts(cg, actionItemRules, "caregiver", now);
    const outcomes = getRecentOutcomes(cg.id, recentOutcomes);

    entities.push({
      id: cg.id,
      name: `${cg.first_name || ""} ${cg.last_name || ""}`.trim() || "Unknown",
      entity_type: "caregiver",
      phase,
      days_in_phase: daysInPhase,
      days_since_contact: daysSince,
      last_contact_channel: channel,
      incomplete_tasks: incomplete,
      total_tasks: total,
      completed_tasks: completed,
      has_phone: !!cg.phone,
      has_email: !!cg.email,
      active_alerts: alerts,
      recent_outcomes: outcomes,
      board_status: cg.board_status || null,
    });
  }

  // Process clients
  for (const cl of clients) {
    if (cl.archived) continue;

    const phase = cl.phase || "Unknown";
    const daysInPhase = calculateDaysInPhase(cl.phase_timestamps, phase, now);
    const { daysSince, channel } = getLastContact(cl.notes, cl.created_at, now);
    const { incomplete, total, completed } = getTaskProgress(cl.tasks);
    const alerts = evaluateAlerts(cl, actionItemRules, "client", now);
    const outcomes = getRecentOutcomes(cl.id, recentOutcomes);

    entities.push({
      id: cl.id,
      name: `${cl.first_name || ""} ${cl.last_name || ""}`.trim() || "Unknown",
      entity_type: "client",
      phase,
      days_in_phase: daysInPhase,
      days_since_contact: daysSince,
      last_contact_channel: channel,
      incomplete_tasks: incomplete,
      total_tasks: total,
      completed_tasks: completed,
      has_phone: !!cl.phone,
      has_email: !!cl.email,
      active_alerts: alerts,
      recent_outcomes: outcomes,
      board_status: null,
    });
  }

  // Sort: most stale first, then by alert count
  entities.sort((a, b) => {
    if (b.active_alerts.length !== a.active_alerts.length) {
      return b.active_alerts.length - a.active_alerts.length;
    }
    return b.days_since_contact - a.days_since_contact;
  });

  // Cap at 100 entities for token budget
  const capped = entities.slice(0, 100);

  // Build rules context string
  const rules_context = actionItemRules
    .filter((r: any) => r.enabled)
    .map((r: any) => `- ${r.name}: ${r.detail_template || r.title_template} (${r.urgency})`)
    .join("\n");

  // Build automation context string
  const automation_context = automationRules
    .filter((r: any) => r.enabled)
    .map((r: any) => `- ${r.name}: trigger=${r.trigger_type}, action=${r.action_type}`)
    .join("\n");

  return { entities: capped, rules_context, automation_context };
}

// ─── Pure Helper Functions ───

export function inferPhase(timestamps: any): string | null {
  if (!timestamps || typeof timestamps !== "object") return null;
  const phases = ["Intake", "Interview", "Onboarding", "Verification", "Orientation", "Active Roster"];
  for (let i = phases.length - 1; i >= 0; i--) {
    const key = phases[i].toLowerCase().replace(/\s+/g, "_");
    if (timestamps[key]) return phases[i];
  }
  return null;
}

export function calculateDaysInPhase(timestamps: any, currentPhase: string, now: number): number {
  if (!timestamps || typeof timestamps !== "object") return 0;
  const key = currentPhase.toLowerCase().replace(/\s+/g, "_");
  const entered = timestamps[key];
  if (!entered) return 0;
  return Math.floor((now - new Date(entered).getTime()) / 86400000);
}

export function getLastContact(
  notes: any[],
  createdAt: string,
  now: number,
): { daysSince: number; channel: string | null } {
  let lastTs = new Date(createdAt || 0).getTime();
  let channel: string | null = null;

  for (const n of notes || []) {
    if (typeof n === "string") continue;
    const ts = n.timestamp ? new Date(n.timestamp).getTime() : 0;
    if (ts > lastTs) {
      lastTs = ts;
      channel = n.type || n.direction || null;
    }
  }

  return {
    daysSince: Math.floor((now - lastTs) / 86400000),
    channel,
  };
}

export function getTaskProgress(tasks: any): {
  incomplete: string[];
  total: number;
  completed: number;
} {
  if (!tasks || typeof tasks !== "object") {
    return { incomplete: [], total: 0, completed: 0 };
  }

  const incomplete: string[] = [];
  let total = 0;
  let completed = 0;

  for (const [taskId, taskData] of Object.entries(tasks)) {
    total++;
    if ((taskData as any)?.completed) {
      completed++;
    } else {
      // Convert task ID to readable label
      incomplete.push(taskId.replace(/^task_/, "").replace(/_/g, " "));
    }
  }

  return { incomplete, total, completed };
}

export function evaluateAlerts(
  entity: any,
  rules: any[],
  entityType: string,
  now: number,
): string[] {
  const alerts: string[] = [];
  const applicableRules = rules.filter(
    (r: any) => r.enabled && r.entity_type === entityType,
  );

  for (const rule of applicableRules) {
    // Simple evaluation — check condition_type
    switch (rule.condition_type) {
      case "task_missing": {
        const taskId = rule.condition_config?.task_id;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) {
          alerts.push(rule.name);
        }
        break;
      }
      case "stale_task": {
        const taskId = rule.condition_config?.task_id;
        const days = rule.condition_config?.days || 3;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) {
          const phase = entity.phase_override || entity.phase;
          const phaseKey = (phase || "").toLowerCase().replace(/\s+/g, "_");
          const entered = entity.phase_timestamps?.[phaseKey];
          if (entered) {
            const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
            if (daysIn >= days) alerts.push(rule.name);
          }
        }
        break;
      }
      case "phase_time": {
        const days = rule.condition_config?.days || 7;
        const phase = entity.phase_override || entity.phase;
        const phaseKey = (phase || "").toLowerCase().replace(/\s+/g, "_");
        const entered = entity.phase_timestamps?.[phaseKey];
        if (entered) {
          const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
          if (daysIn >= days) alerts.push(rule.name);
        }
        break;
      }
      case "date_expiry": {
        const field = rule.condition_config?.date_field;
        const warnDays = rule.condition_config?.warn_days || 30;
        if (field && entity[field]) {
          const expiry = new Date(entity[field]).getTime();
          const daysUntil = Math.floor((expiry - now) / 86400000);
          if (daysUntil <= warnDays) alerts.push(rule.name);
        }
        break;
      }
      // sprint and other types can be added as needed
    }
  }

  return alerts;
}

export function getRecentOutcomes(entityId: string, outcomes: any[]): string[] {
  return outcomes
    .filter((o: any) => o.entity_id === entityId)
    .slice(0, 3)
    .map((o: any) => {
      const action = (o.action_type || "").replace(/_/g, " ");
      const outcome = o.outcome_type || "pending";
      return `${action}: ${outcome}`;
    });
}

// ─── Dedup Check ───

export async function checkDuplicateSuggestion(
  supabase: SupabaseClient,
  entityId: string,
  actionType: string,
  windowHours: number = 24,
): Promise<boolean> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("ai_suggestions")
    .select("id")
    .eq("entity_id", entityId)
    .eq("action_type", actionType)
    .eq("source_type", "proactive")
    .gte("created_at", since)
    .limit(1);

  return (data?.length || 0) > 0;
}

// ─── Response Parser ───

const VALID_ACTION_TYPES = new Set([
  "send_sms", "send_email", "add_note", "add_client_note",
  "update_phase", "update_client_phase",
  "complete_task", "complete_client_task",
  "update_caregiver_field", "update_client_field",
  "update_board_status", "create_calendar_event",
  "send_docusign_envelope",
]);

const VALID_PRIORITIES = new Set(["high", "medium", "low"]);

export function parsePlannerResponse(responseText: string): PlannerSuggestion[] {
  // Extract JSON array from response (may have markdown wrapping)
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  jsonStr = jsonMatch[0];

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const suggestions: PlannerSuggestion[] = [];
  for (const item of parsed) {
    // Validate required fields
    if (!item.entity_id || !item.action_type || !item.title) continue;
    if (!VALID_ACTION_TYPES.has(item.action_type)) continue;

    suggestions.push({
      entity_id: String(item.entity_id),
      entity_type: item.entity_type === "client" ? "client" : "caregiver",
      entity_name: String(item.entity_name || "Unknown"),
      action_type: item.action_type,
      priority: VALID_PRIORITIES.has(item.priority) ? item.priority : "medium",
      title: String(item.title).slice(0, 200),
      detail: String(item.detail || "").slice(0, 500),
      drafted_content: item.drafted_content ? String(item.drafted_content) : null,
      action_params: item.action_params || {},
    });
  }

  return suggestions;
}

// ─── Compact Summary Formatter ───

export function formatPipelineSummaryForPrompt(entities: PipelineEntity[]): string {
  if (entities.length === 0) return "No active entities in pipeline.";

  const lines: string[] = [];
  for (const e of entities) {
    const parts = [
      `${e.name} (${e.entity_type}, ${e.phase})`,
      `${e.days_in_phase}d in phase`,
      `last contact: ${e.days_since_contact}d ago${e.last_contact_channel ? ` via ${e.last_contact_channel}` : ""}`,
      `tasks: ${e.completed_tasks}/${e.total_tasks}`,
    ];
    if (e.incomplete_tasks.length > 0) {
      parts.push(`pending: ${e.incomplete_tasks.slice(0, 3).join(", ")}`);
    }
    if (e.active_alerts.length > 0) {
      parts.push(`ALERTS: ${e.active_alerts.join(", ")}`);
    }
    if (e.recent_outcomes.length > 0) {
      parts.push(`outcomes: ${e.recent_outcomes.join("; ")}`);
    }
    if (!e.has_phone) parts.push("NO PHONE");
    lines.push(`- [${e.id}] ${parts.join(" | ")}`);
  }

  return lines.join("\n");
}
```

**Step 2: Commit**

```bash
git add supabase/functions/_shared/operations/planner.ts
git commit -m "feat: add shared planner helpers for proactive OODA loop"
```

---

## Task 3: Testable planner helpers + tests

**Files:**
- Create: `src/lib/plannerHelpers.js`
- Create: `src/lib/__tests__/proactivePlanner.test.js`

**Step 1: Create Node-compatible planner helpers**

```javascript
// ─── Planner Helpers (Node/Vitest compatible) ───
// Re-implements pure logic from _shared/operations/planner.ts for testing.

export function inferPhase(timestamps) {
  if (!timestamps || typeof timestamps !== 'object') return null;
  const phases = ['Intake', 'Interview', 'Onboarding', 'Verification', 'Orientation', 'Active Roster'];
  for (let i = phases.length - 1; i >= 0; i--) {
    const key = phases[i].toLowerCase().replace(/\s+/g, '_');
    if (timestamps[key]) return phases[i];
  }
  return null;
}

export function calculateDaysInPhase(timestamps, currentPhase, now) {
  if (!timestamps || typeof timestamps !== 'object') return 0;
  const key = currentPhase.toLowerCase().replace(/\s+/g, '_');
  const entered = timestamps[key];
  if (!entered) return 0;
  return Math.floor((now - new Date(entered).getTime()) / 86400000);
}

export function getLastContact(notes, createdAt, now) {
  let lastTs = new Date(createdAt || 0).getTime();
  let channel = null;
  for (const n of notes || []) {
    if (typeof n === 'string') continue;
    const ts = n.timestamp ? new Date(n.timestamp).getTime() : 0;
    if (ts > lastTs) {
      lastTs = ts;
      channel = n.type || n.direction || null;
    }
  }
  return { daysSince: Math.floor((now - lastTs) / 86400000), channel };
}

export function getTaskProgress(tasks) {
  if (!tasks || typeof tasks !== 'object') return { incomplete: [], total: 0, completed: 0 };
  const incomplete = [];
  let total = 0, completed = 0;
  for (const [taskId, taskData] of Object.entries(tasks)) {
    total++;
    if (taskData?.completed) completed++;
    else incomplete.push(taskId.replace(/^task_/, '').replace(/_/g, ' '));
  }
  return { incomplete, total, completed };
}

export function evaluateAlerts(entity, rules, entityType, now) {
  const alerts = [];
  const applicable = rules.filter(r => r.enabled && r.entity_type === entityType);
  for (const rule of applicable) {
    switch (rule.condition_type) {
      case 'task_missing': {
        const taskId = rule.condition_config?.task_id;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) alerts.push(rule.name);
        break;
      }
      case 'phase_time': {
        const days = rule.condition_config?.days || 7;
        const phase = entity.phase_override || entity.phase;
        const phaseKey = (phase || '').toLowerCase().replace(/\s+/g, '_');
        const entered = entity.phase_timestamps?.[phaseKey];
        if (entered) {
          const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
          if (daysIn >= days) alerts.push(rule.name);
        }
        break;
      }
      case 'date_expiry': {
        const field = rule.condition_config?.date_field;
        const warnDays = rule.condition_config?.warn_days || 30;
        if (field && entity[field]) {
          const expiry = new Date(entity[field]).getTime();
          const daysUntil = Math.floor((expiry - now) / 86400000);
          if (daysUntil <= warnDays) alerts.push(rule.name);
        }
        break;
      }
    }
  }
  return alerts;
}

export function getRecentOutcomes(entityId, outcomes) {
  return outcomes
    .filter(o => o.entity_id === entityId)
    .slice(0, 3)
    .map(o => `${(o.action_type || '').replace(/_/g, ' ')}: ${o.outcome_type || 'pending'}`);
}

const VALID_ACTION_TYPES = new Set([
  'send_sms', 'send_email', 'add_note', 'add_client_note',
  'update_phase', 'update_client_phase',
  'complete_task', 'complete_client_task',
  'update_caregiver_field', 'update_client_field',
  'update_board_status', 'create_calendar_event',
  'send_docusign_envelope',
]);

export function parsePlannerResponse(responseText) {
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  jsonStr = jsonMatch[0];
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(item => item.entity_id && item.action_type && item.title && VALID_ACTION_TYPES.has(item.action_type))
    .map(item => ({
      entity_id: String(item.entity_id),
      entity_type: item.entity_type === 'client' ? 'client' : 'caregiver',
      entity_name: String(item.entity_name || 'Unknown'),
      action_type: item.action_type,
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      title: String(item.title).slice(0, 200),
      detail: String(item.detail || '').slice(0, 500),
      drafted_content: item.drafted_content ? String(item.drafted_content) : null,
      action_params: item.action_params || {},
    }));
}

export function formatPipelineSummaryForPrompt(entities) {
  if (!entities || entities.length === 0) return 'No active entities in pipeline.';
  return entities.map(e => {
    const parts = [
      `${e.name} (${e.entity_type}, ${e.phase})`,
      `${e.days_in_phase}d in phase`,
      `last contact: ${e.days_since_contact}d ago${e.last_contact_channel ? ` via ${e.last_contact_channel}` : ''}`,
      `tasks: ${e.completed_tasks}/${e.total_tasks}`,
    ];
    if (e.incomplete_tasks.length > 0) parts.push(`pending: ${e.incomplete_tasks.slice(0, 3).join(', ')}`);
    if (e.active_alerts.length > 0) parts.push(`ALERTS: ${e.active_alerts.join(', ')}`);
    if (e.recent_outcomes.length > 0) parts.push(`outcomes: ${e.recent_outcomes.join('; ')}`);
    if (!e.has_phone) parts.push('NO PHONE');
    return `- [${e.id}] ${parts.join(' | ')}`;
  }).join('\n');
}
```

**Step 2: Write the test file**

```javascript
import { describe, it, expect } from 'vitest';
import {
  inferPhase,
  calculateDaysInPhase,
  getLastContact,
  getTaskProgress,
  evaluateAlerts,
  getRecentOutcomes,
  parsePlannerResponse,
  formatPipelineSummaryForPrompt,
} from '../plannerHelpers';

const NOW = new Date('2026-03-21T12:00:00Z').getTime();

describe('Proactive Planner', () => {
  describe('inferPhase', () => {
    it('returns the most advanced phase from timestamps', () => {
      expect(inferPhase({ intake: '2026-01-01', interview: '2026-01-05' })).toBe('Interview');
    });

    it('returns null for null/undefined timestamps', () => {
      expect(inferPhase(null)).toBeNull();
      expect(inferPhase(undefined)).toBeNull();
    });

    it('handles active_roster key correctly', () => {
      expect(inferPhase({ intake: '2026-01-01', active_roster: '2026-03-01' })).toBe('Active Roster');
    });

    it('returns Intake for single phase', () => {
      expect(inferPhase({ intake: '2026-03-01' })).toBe('Intake');
    });
  });

  describe('calculateDaysInPhase', () => {
    it('calculates days correctly', () => {
      const ts = { interview: '2026-03-18T12:00:00Z' };
      expect(calculateDaysInPhase(ts, 'Interview', NOW)).toBe(3);
    });

    it('returns 0 for missing phase key', () => {
      expect(calculateDaysInPhase({ intake: '2026-03-01' }, 'Onboarding', NOW)).toBe(0);
    });

    it('returns 0 for null timestamps', () => {
      expect(calculateDaysInPhase(null, 'Intake', NOW)).toBe(0);
    });
  });

  describe('getLastContact', () => {
    it('uses most recent note timestamp', () => {
      const notes = [
        { text: 'old', timestamp: '2026-03-10T12:00:00Z', type: 'sms' },
        { text: 'recent', timestamp: '2026-03-19T12:00:00Z', type: 'email' },
      ];
      const result = getLastContact(notes, '2026-01-01', NOW);
      expect(result.daysSince).toBe(2);
      expect(result.channel).toBe('email');
    });

    it('falls back to created_at if no notes', () => {
      const result = getLastContact([], '2026-03-14T12:00:00Z', NOW);
      expect(result.daysSince).toBe(7);
      expect(result.channel).toBeNull();
    });

    it('skips string notes', () => {
      const result = getLastContact(['old string note'], '2026-03-20T12:00:00Z', NOW);
      expect(result.daysSince).toBe(1);
    });
  });

  describe('getTaskProgress', () => {
    it('counts completed and incomplete tasks', () => {
      const tasks = {
        task_phone_screen: { completed: true, completedAt: '2026-03-01' },
        task_tb_test: { completed: false },
        task_i9: { completed: false },
      };
      const result = getTaskProgress(tasks);
      expect(result.total).toBe(3);
      expect(result.completed).toBe(1);
      expect(result.incomplete).toEqual(['phone screen', 'tb test', 'i9']);
    });

    it('returns zeros for null tasks', () => {
      const result = getTaskProgress(null);
      expect(result.total).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.incomplete).toEqual([]);
    });
  });

  describe('evaluateAlerts', () => {
    const rules = [
      { name: 'HCA Missing', entity_type: 'caregiver', condition_type: 'task_missing', condition_config: { task_id: 'task_hca' }, enabled: true },
      { name: 'Verification Pending', entity_type: 'caregiver', condition_type: 'phase_time', condition_config: { days: 5 }, enabled: true },
      { name: 'Disabled Rule', entity_type: 'caregiver', condition_type: 'task_missing', condition_config: { task_id: 'task_i9' }, enabled: false },
      { name: 'Client Rule', entity_type: 'client', condition_type: 'task_missing', condition_config: { task_id: 'task_intake' }, enabled: true },
    ];

    it('triggers task_missing alert when task incomplete', () => {
      const entity = { tasks: { task_hca: { completed: false } }, phase_override: 'Verification', phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).toContain('HCA Missing');
    });

    it('does not trigger task_missing when task is complete', () => {
      const entity = { tasks: { task_hca: { completed: true } }, phase_override: 'Verification', phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('HCA Missing');
    });

    it('skips disabled rules', () => {
      const entity = { tasks: { task_i9: { completed: false } }, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('Disabled Rule');
    });

    it('only evaluates rules for matching entity type', () => {
      const entity = { tasks: { task_intake: { completed: false } }, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('Client Rule');
    });

    it('triggers phase_time alert when over threshold', () => {
      const entity = {
        tasks: {},
        phase_override: 'Verification',
        phase_timestamps: { verification: '2026-03-10T12:00:00Z' },
      };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).toContain('Verification Pending');
    });

    it('evaluates date_expiry rule', () => {
      const dateRules = [
        { name: 'HCA Expiring', entity_type: 'caregiver', condition_type: 'date_expiry', condition_config: { date_field: 'hca_expiration', warn_days: 30 }, enabled: true },
      ];
      const entity = { hca_expiration: '2026-04-10T00:00:00Z', tasks: {}, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, dateRules, 'caregiver', NOW);
      expect(alerts).toContain('HCA Expiring');
    });
  });

  describe('getRecentOutcomes', () => {
    it('returns formatted outcomes for entity', () => {
      const outcomes = [
        { entity_id: 'cg1', action_type: 'sms_sent', outcome_type: 'response_received' },
        { entity_id: 'cg1', action_type: 'email_sent', outcome_type: 'no_response' },
        { entity_id: 'cg2', action_type: 'sms_sent', outcome_type: 'pending' },
      ];
      const result = getRecentOutcomes('cg1', outcomes);
      expect(result).toEqual(['sms sent: response_received', 'email sent: no_response']);
    });

    it('returns empty array for unknown entity', () => {
      expect(getRecentOutcomes('unknown', [])).toEqual([]);
    });

    it('caps at 3 outcomes', () => {
      const outcomes = Array.from({ length: 5 }, (_, i) => ({
        entity_id: 'cg1', action_type: 'sms_sent', outcome_type: `outcome_${i}`,
      }));
      expect(getRecentOutcomes('cg1', outcomes).length).toBe(3);
    });
  });

  describe('parsePlannerResponse', () => {
    it('parses valid JSON array', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', entity_type: 'caregiver', entity_name: 'John Doe',
        action_type: 'send_sms', priority: 'high', title: 'Follow up with John',
        detail: 'No response in 4 days', drafted_content: 'Hi John, checking in!',
        action_params: { message: 'Hi John, checking in!' },
      }]);
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
      expect(result[0].entity_id).toBe('cg1');
      expect(result[0].action_type).toBe('send_sms');
      expect(result[0].priority).toBe('high');
    });

    it('handles markdown-wrapped JSON', () => {
      const response = '```json\n[{"entity_id":"cg1","action_type":"send_sms","title":"Test"}]\n```';
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
    });

    it('filters invalid action types', () => {
      const response = JSON.stringify([
        { entity_id: 'cg1', action_type: 'delete_everything', title: 'Bad' },
        { entity_id: 'cg2', action_type: 'send_sms', title: 'Good' },
      ]);
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
      expect(result[0].action_type).toBe('send_sms');
    });

    it('filters items missing required fields', () => {
      const response = JSON.stringify([
        { entity_id: 'cg1', action_type: 'send_sms' }, // missing title
        { action_type: 'send_sms', title: 'Test' }, // missing entity_id
      ]);
      expect(parsePlannerResponse(response).length).toBe(0);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parsePlannerResponse('not json')).toEqual([]);
      expect(parsePlannerResponse('')).toEqual([]);
    });

    it('defaults priority to medium if invalid', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', action_type: 'send_sms', title: 'Test', priority: 'urgent',
      }]);
      expect(parsePlannerResponse(response)[0].priority).toBe('medium');
    });

    it('truncates long titles and details', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', action_type: 'send_sms',
        title: 'A'.repeat(300), detail: 'B'.repeat(600),
      }]);
      const result = parsePlannerResponse(response);
      expect(result[0].title.length).toBe(200);
      expect(result[0].detail.length).toBe(500);
    });
  });

  describe('formatPipelineSummaryForPrompt', () => {
    it('formats entities into compact lines', () => {
      const entities = [{
        id: 'cg1', name: 'John Doe', entity_type: 'caregiver', phase: 'Interview',
        days_in_phase: 5, days_since_contact: 3, last_contact_channel: 'sms',
        incomplete_tasks: ['tb test', 'i9'], total_tasks: 5, completed_tasks: 3,
        has_phone: true, has_email: true, active_alerts: ['24-Hour Interview Standard'],
        recent_outcomes: ['sms sent: response_received'], board_status: null,
      }];
      const result = formatPipelineSummaryForPrompt(entities);
      expect(result).toContain('[cg1]');
      expect(result).toContain('John Doe');
      expect(result).toContain('5d in phase');
      expect(result).toContain('3d ago via sms');
      expect(result).toContain('ALERTS: 24-Hour Interview Standard');
    });

    it('flags entities with no phone', () => {
      const entities = [{
        id: 'cg2', name: 'Jane', entity_type: 'caregiver', phase: 'Intake',
        days_in_phase: 1, days_since_contact: 0, last_contact_channel: null,
        incomplete_tasks: [], total_tasks: 0, completed_tasks: 0,
        has_phone: false, has_email: true, active_alerts: [], recent_outcomes: [],
        board_status: null,
      }];
      expect(formatPipelineSummaryForPrompt(entities)).toContain('NO PHONE');
    });

    it('returns message for empty pipeline', () => {
      expect(formatPipelineSummaryForPrompt([])).toBe('No active entities in pipeline.');
    });
  });
});
```

**Step 3: Run tests**

```bash
npm test
```

Expected: All existing tests pass + ~25 new proactive planner tests pass.

**Step 4: Commit**

```bash
git add src/lib/plannerHelpers.js src/lib/__tests__/proactivePlanner.test.js
git commit -m "feat: add planner helpers with tests for proactive OODA loop"
```

---

## Task 4: AI Planner Edge Function

**Files:**
- Create: `supabase/functions/ai-planner/index.ts`

**Step 1: Write the Edge Function**

```typescript
// ─── AI Planner ───
// Daily cron (7am PT / 14:00 UTC) that analyzes the full pipeline
// using Claude Sonnet and generates up to 7 high-impact suggestions.
//
// Reads: caregivers, clients, action_item_rules, automation_rules,
//        action_outcomes, app_settings (business context + planner config)
// Writes: ai_suggestions (source_type = 'proactive')
//
// All suggestions flow through autonomy_config (context = 'proactive')
// and executeSuggestion() for the same guardrails as inbound routing.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { logMetric, startTimer } from "../_shared/operations/metrics.ts";
import {
  buildPipelineSummary,
  formatPipelineSummaryForPrompt,
  parsePlannerResponse,
  checkDuplicateSuggestion,
  type PlannerSuggestion,
} from "../_shared/operations/planner.ts";
import {
  lookupAutonomyLevel,
  executeSuggestion,
} from "../_shared/operations/routing.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const SONNET_MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 2048;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Planner System Prompt ───

const PLANNER_SYSTEM_PROMPT = `You are the daily planner for Tremendous Care, a home care staffing agency in California. Analyze the full pipeline and recommend the highest-impact actions for today.

For each caregiver/client in the pipeline, you have:
- Name, phase, days in phase, board status
- Last contact date and channel
- Incomplete tasks
- Active alerts from our rules engine (these reflect what the team watches for)
- Recent outcome history (did previous outreach get responses?)
- Whether they have a phone number and/or email

Recommend up to {max_suggestions} actions, prioritized by impact. Consider:
- People who were responsive before but went quiet — a nudge can re-engage them
- People close to completing onboarding — don't let them fall off when they're almost done
- New applicants — first 24h response rate matters most for conversion
- Compliance gaps (expiring HCA, missing documents) — these block deployment
- Don't suggest actions that our automation rules already handle (listed below)
- Don't suggest follow-ups for people you've already suggested follow-ups for recently
- If someone has no phone number, suggest email instead of SMS
- Draft SMS messages under 160 characters, warm and professional
- Draft emails with a clear subject line and brief body

For each recommendation, return a JSON array. Each item must have:
- entity_id: the ID string from the pipeline data (in brackets)
- entity_type: "caregiver" or "client"
- entity_name: their name
- action_type: one of: send_sms, send_email, add_note, complete_task, update_phase, create_calendar_event, send_docusign_envelope
- priority: "high", "medium", or "low"
- title: brief description (under 80 chars)
- detail: your reasoning (1-2 sentences)
- drafted_content: the message text (for send_sms or send_email) or null
- action_params: structured params for execution. For send_sms: {message: "..."}. For send_email: {subject: "...", body: "..."}. For add_note: {text: "...", type: "ai_planner"}. For complete_task: {task_id: "task_xxx"}. For update_phase: {new_phase: "Phase Name"}. For create_calendar_event: {subject: "...", start_time: "ISO string", duration_minutes: 30}.

Respond with ONLY the JSON array. No explanation or markdown wrapping.`;

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Record<string, any> = {};
  const doneInvocation = startTimer(supabase, "ai-planner", "invocation");

  try {
    // ── Check if planner is enabled ──
    const { data: enabledSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "planner_enabled")
      .single();

    if (enabledSetting?.value === "false" || enabledSetting?.value === false) {
      results.skipped = "Planner is disabled";
      doneInvocation(true, results);
      return new Response(JSON.stringify({ success: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Check idempotency (don't run twice in same day) ──
    const { data: lastRun } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "last_planner_run")
      .single();

    const today = new Date().toISOString().split("T")[0];
    if (lastRun?.value && typeof lastRun.value === "string") {
      const lastRunDate = lastRun.value.split("T")[0];
      if (lastRunDate === today) {
        results.skipped = `Already ran today (${lastRun.value})`;
        doneInvocation(true, results);
        return new Response(JSON.stringify({ success: true, results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Get max suggestions setting ──
    const { data: maxSugSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "planner_max_suggestions")
      .single();
    const maxSuggestions = parseInt(maxSugSetting?.value) || 7;

    // ── Load pipeline data ──
    const { data: caregivers } = await supabase
      .from("caregivers")
      .select("id, first_name, last_name, phone, email, phase_override, phase_timestamps, tasks, notes, created_at, archived, board_status, has_hca, hca_expiration")
      .order("created_at", { ascending: false });

    const { data: clients } = await supabase
      .from("clients")
      .select("id, first_name, last_name, phone, email, phase, phase_timestamps, tasks, notes, created_at, archived")
      .order("created_at", { ascending: false });

    // ── Load rules context ──
    const { data: actionItemRules } = await supabase
      .from("action_item_rules")
      .select("name, entity_type, condition_type, condition_config, urgency, title_template, detail_template, enabled")
      .eq("enabled", true);

    const { data: automationRules } = await supabase
      .from("automation_rules")
      .select("name, trigger_type, action_type, conditions, enabled, entity_type")
      .eq("enabled", true);

    // ── Load recent outcomes (last 14 days) ──
    const since14d = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentOutcomes } = await supabase
      .from("action_outcomes")
      .select("entity_id, action_type, outcome_type, created_at")
      .gte("created_at", since14d)
      .order("created_at", { ascending: false })
      .limit(200);

    // ── Load business context ──
    const { data: bizCtx } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "ai_business_context")
      .single();
    const businessContext = bizCtx?.value || "";

    // ── Build pipeline summary ──
    const { entities, rules_context, automation_context } = buildPipelineSummary(
      caregivers || [],
      clients || [],
      actionItemRules || [],
      automationRules || [],
      recentOutcomes || [],
    );

    results.pipeline_size = entities.length;
    results.active_rules = (actionItemRules || []).length;
    results.active_automations = (automationRules || []).length;

    if (entities.length === 0) {
      results.skipped = "No active entities in pipeline";
      doneInvocation(true, results);
      return new Response(JSON.stringify({ success: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Build Sonnet prompt ──
    const pipelineText = formatPipelineSummaryForPrompt(entities);
    const systemPrompt = PLANNER_SYSTEM_PROMPT.replace("{max_suggestions}", String(maxSuggestions));

    let userPrompt = `## Pipeline (${entities.length} active entities)\n\n${pipelineText}`;

    if (rules_context) {
      userPrompt += `\n\n## Active Alert Rules (what our team watches for)\n${rules_context}`;
    }
    if (automation_context) {
      userPrompt += `\n\n## Active Automation Rules (already handled automatically — skip these)\n${automation_context}`;
    }
    if (businessContext) {
      userPrompt += `\n\n## Business Context & Preferences\n${businessContext}`;
    }

    // ── Call Sonnet ──
    const doneClassify = startTimer(supabase, "ai-planner", "sonnet_call");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      doneClassify(false, { error: `HTTP ${response.status}`, detail: errText.slice(0, 200) });
      throw new Error(`Sonnet API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const responseText = data.content?.[0]?.text || "";
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    doneClassify(true, { input_tokens: inputTokens, output_tokens: outputTokens });

    results.input_tokens = inputTokens;
    results.output_tokens = outputTokens;

    // ── Parse response ──
    const suggestions = parsePlannerResponse(responseText);
    results.suggestions_parsed = suggestions.length;

    // ── Create suggestions with dedup + autonomy ──
    let created = 0;
    let skipped = 0;
    let autoExecuted = 0;

    for (const sug of suggestions.slice(0, maxSuggestions)) {
      // Dedup check
      const isDuplicate = await checkDuplicateSuggestion(
        supabase,
        sug.entity_id,
        sug.action_type,
        24,
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Look up autonomy level for proactive context
      const autonomyConfig = await lookupAutonomyLevel(
        supabase,
        sug.action_type,
        sug.entity_type,
        "proactive",
      );
      const autonomyLevel = autonomyConfig.autonomy_level;

      // Build action_params with required fields
      const actionParams = {
        ...sug.action_params,
        entity_id: sug.entity_id,
        entity_type: sug.entity_type,
      };

      // Insert suggestion
      const status = (autonomyLevel === "L3" || autonomyLevel === "L4")
        ? "auto_executed"
        : "pending";

      const { data: inserted, error: insertErr } = await supabase
        .from("ai_suggestions")
        .insert({
          source_type: "proactive",
          source_id: null,
          entity_type: sug.entity_type,
          entity_id: sug.entity_id,
          entity_name: sug.entity_name,
          suggestion_type: sug.action_type.startsWith("send_") ? "follow_up" : "action",
          action_type: sug.action_type,
          title: `[${sug.priority.toUpperCase()}] ${sug.title}`,
          detail: sug.detail,
          drafted_content: sug.drafted_content,
          action_params: actionParams,
          intent: "proactive_planner",
          intent_confidence: 0.9,
          autonomy_level: autonomyLevel,
          status,
          input_tokens: Math.round(inputTokens / suggestions.length),
          output_tokens: Math.round(outputTokens / suggestions.length),
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error(`[ai-planner] Failed to insert suggestion for ${sug.entity_name}:`, insertErr);
        continue;
      }

      created++;

      // Auto-execute if L3/L4
      if (status === "auto_executed" && inserted?.id) {
        const execResult = await executeSuggestion(
          supabase,
          inserted.id,
          "system:ai-planner",
        );
        if (execResult.success) {
          autoExecuted++;
        } else {
          console.error(`[ai-planner] Auto-execute failed for ${inserted.id}:`, execResult.error);
        }
      }
    }

    results.suggestions_created = created;
    results.suggestions_skipped_dedup = skipped;
    results.auto_executed = autoExecuted;

    // ── Record planner run ──
    await supabase
      .from("app_settings")
      .upsert({
        key: "last_planner_run",
        value: new Date().toISOString(),
      });

    doneInvocation(true, results);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[ai-planner] Fatal error:", err);
    logMetric(supabase, "ai-planner", "error", undefined, false, {
      error: (err as Error).message,
    });
    doneInvocation(false, { error: (err as Error).message });

    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
```

**Step 2: Commit**

```bash
git add supabase/functions/ai-planner/index.ts
git commit -m "feat: add ai-planner Edge Function for daily proactive suggestions"
```

---

## Task 5: Planner cron migration

**Files:**
- Create: `supabase/migrations/20260321_planner_cron.sql`

**Step 1: Write the cron migration**

```sql
-- ── AI Planner Daily Cron ──
-- Runs at 14:00 UTC (7:00 AM Pacific) every day
SELECT cron.schedule(
  'daily-ai-planner',
  '0 14 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/ai-planner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $$
);
```

**Step 2: Apply via Supabase MCP**

**Step 3: Verify**

```sql
SELECT jobname, schedule FROM cron.job WHERE jobname = 'daily-ai-planner';
-- Expect: schedule = '0 14 * * *'
```

---

## Task Summary & Execution Order

| # | Task | Type | Dependencies |
|---|------|------|-------------|
| 1 | Proactive planner migration | SQL migration | None |
| 2 | Shared planner helpers | New Deno file | None |
| 3 | Planner tests + Node helpers | Tests | Task 2 (conceptual) |
| 4 | AI Planner Edge Function | New Edge Function | Tasks 1, 2 |
| 5 | Planner cron migration | SQL migration | Task 4 |

**Recommended branch:** `feature/proactive-ooda-loop`

**PR strategy:** Single PR with all changes. Deploy after merge:
1. Apply migration (Task 1)
2. Deploy ai-planner: `npx supabase functions deploy ai-planner --no-verify-jwt`
3. Apply cron migration (Task 5)
4. Test: manually invoke the planner or wait for 7am PT

**Post-PR testing:**
- Manually invoke planner via curl or Supabase dashboard
- Verify suggestions appear in NotificationCenter
- Check system_metrics for ai-planner invocation + sonnet_call metrics
- Approve/reject a suggestion to verify autonomy flow works

---

## Future Enhancements (NOT in this PR)

- **NotificationCenter badges**: Show "Proactive" vs "Inbound" source on suggestions
- **Briefing integration**: Show "Planner ran at X, created N suggestions" in morning briefing
- **Planner Settings UI**: Enable/disable + max suggestions in AdminSettings
- **Per-scope business context**: Different context per agent role
- **Event-driven suggestions**: Real-time triggers for DocuSign completed, etc.
