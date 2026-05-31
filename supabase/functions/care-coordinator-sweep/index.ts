// ═══════════════════════════════════════════════════════════════
// Care Coordinator — Change-of-Condition Detector (sweep)
//
// Triggered by pg_cron every few hours. For each client with recent
// caregiver observations, it compares the acute window against the
// client's care-plan baseline + recent normal, asks Claude for a single
// structured verdict, and writes any resulting care_signal to the
// triage worklist. Read-only with respect to client care: it never
// sends anything or changes a care plan.
//
// FEATURE FLAG: no-ops unless the care_coordinator agent row has
// kill_switch = false. Seeded with kill_switch = true, so safe to
// deploy disabled; an operator flips it on.
//
// Design: docs/CARE_COORDINATOR_AGENT.md
// ═══════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { DEFAULT_THRESHOLDS, SeverityThresholds } from './severity.ts';
import { Observation, Task, summarizeObservations, normalizeDetectorOutput } from './analysis.ts';
import { decideDisposition, ExistingSignal } from './dedup.ts';
import { buildSystemPrompt, buildUserPrompt } from './prompt.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const FALLBACK_MODEL = Deno.env.get('CARE_COORDINATOR_MODEL') || 'claude-sonnet-4-5-20250929';

const DAY_MS = 86_400_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Defensively extract the first JSON object from a model response. */
function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function mapObservation(row: Record<string, unknown>): Observation {
  return {
    id: row.id as string,
    observationType: row.observation_type as string,
    rating: (row.rating as string) ?? null,
    note: (row.note as string) ?? null,
    taskId: (row.task_id as string) ?? null,
    shiftId: (row.shift_id as string) ?? null,
    loggedAt: row.logged_at as string,
  };
}

function buildBaselineNarrative(data: unknown, generatedSummary: string | null): string {
  let narrative = '';
  if (generatedSummary) narrative += `Summary: ${generatedSummary}\n\n`;
  try {
    narrative += `Structured plan: ${JSON.stringify(data).slice(0, 4000)}`;
  } catch {
    /* ignore */
  }
  return narrative.trim();
}

async function callClaude(model: string, system: string, user: string): Promise<unknown> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) {
    console.error('Anthropic error', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  const text = data?.content?.[0]?.text ?? '';
  return parseModelJson(text);
}

serve(async (req) => {
  // Auth: the Supabase gateway verifies the JWT the cron passes (the
  // publishable key), matching the shift-reminders / automation-cron
  // pattern. If a CRON_SECRET is configured we additionally require it,
  // as optional defense-in-depth.
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // 1. Load the agent. The on/off control is kill_switch (true = OFF),
  // matching the agents-table convention; window + threshold config
  // lives in context_recipe. Slug is the CHECK-valid 'care_coordinator'.
  const { data: agent } = await supabase
    .from('agents')
    .select('id, model, context_recipe, kill_switch')
    .eq('slug', 'care_coordinator')
    .maybeSingle();

  if (!agent || agent.kill_switch === true) {
    return jsonResponse({ ok: true, skipped: 'care_coordinator disabled (kill_switch)', evaluated: 0, created: 0 });
  }

  const recipe = (agent.context_recipe ?? {}) as Record<string, unknown>;
  const acuteDays = Number(recipe.acute_window_days) || 7;
  const baselineDays = Number(recipe.baseline_window_days) || 30;
  const thresholds: SeverityThresholds = {
    watch_min_categories:
      Number((recipe.severity_thresholds as Record<string, unknown>)?.watch_min_categories) ||
      DEFAULT_THRESHOLDS.watch_min_categories,
    urgent_min_categories:
      Number((recipe.severity_thresholds as Record<string, unknown>)?.urgent_min_categories) ||
      DEFAULT_THRESHOLDS.urgent_min_categories,
  };
  const model = (agent.model as string) || FALLBACK_MODEL;

  const now = Date.now();
  const acuteStart = new Date(now - acuteDays * DAY_MS).toISOString();
  const baselineStart = new Date(now - baselineDays * DAY_MS).toISOString();
  const systemPrompt = buildSystemPrompt();

  // 2. Care plans with fresh observations in the acute window.
  const { data: recent } = await supabase
    .from('care_plan_observations')
    .select('care_plan_id')
    .gte('logged_at', acuteStart);
  const carePlanIds = Array.from(new Set((recent ?? []).map((r) => r.care_plan_id as string).filter(Boolean)));

  let evaluated = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const carePlanId of carePlanIds) {
    try {
      const { data: plan } = await supabase
        .from('care_plans')
        .select('id, client_id, current_version_id, status, org_id')
        .eq('id', carePlanId)
        .maybeSingle();
      if (!plan || plan.status !== 'active' || !plan.current_version_id) continue;

      const { data: version } = await supabase
        .from('care_plan_versions')
        .select('data, generated_summary')
        .eq('id', plan.current_version_id)
        .maybeSingle();
      if (!version) continue;

      const { data: taskRows } = await supabase
        .from('care_plan_tasks')
        .select('id, task_name, category')
        .eq('version_id', plan.current_version_id);
      const tasks: Task[] = (taskRows ?? []).map((t) => ({
        id: t.id as string,
        taskName: t.task_name as string,
        category: (t.category as string) ?? null,
      }));

      const { data: obsRows } = await supabase
        .from('care_plan_observations')
        .select('id, observation_type, rating, note, task_id, shift_id, logged_at')
        .eq('care_plan_id', carePlanId)
        .gte('logged_at', baselineStart)
        .order('logged_at', { ascending: true });
      const observations = (obsRows ?? []).map(mapObservation);
      if (observations.length === 0) continue;

      evaluated += 1;

      const summary = summarizeObservations(observations, tasks, { acuteWindowStart: acuteStart });
      if (summary.acuteCount === 0) continue;

      const data = version.data as Record<string, unknown>;
      const who = (data?.whoTheyAre ?? {}) as Record<string, unknown>;
      const userPrompt = buildUserPrompt(
        {
          preferredName: (who.preferredName as string) || (who.fullName as string) || null,
          ageOrDob: (who.dateOfBirth as string) || null,
          baselineNarrative: buildBaselineNarrative(version.data, version.generated_summary as string | null),
        },
        summary,
      );

      const raw = await callClaude(model, systemPrompt, userPrompt);
      // Gate evidence ids to real acute-window observations: a signal
      // must cite at least one, both for traceability and so dedup has
      // ids to overlap against on the next sweep.
      const acuteIds = new Set(summary.acute.map((o) => o.id));
      const signal = normalizeDetectorOutput(raw, { thresholds, validObservationIds: acuteIds });
      if (!signal) continue;

      // Dedup against this client's open signals.
      const { data: openRows } = await supabase
        .from('care_signals')
        .select('id, severity, evidence')
        .eq('client_id', plan.client_id)
        .eq('status', 'open');
      const existingOpen: ExistingSignal[] = (openRows ?? []).map((s) => ({
        id: s.id as string,
        severity: s.severity as ExistingSignal['severity'],
        evidenceObservationIds: Array.isArray(s.evidence)
          ? (s.evidence as Array<Record<string, unknown>>).map((e) => e.observation_id as string).filter(Boolean)
          : [],
      }));
      const disposition = decideDisposition(existingOpen, signal);
      if (disposition.action === 'skip') continue;

      // Resolve evidence ids to full rows for traceability.
      const evMap = new Map(observations.map((o) => [o.id, o]));
      const evidence = signal.evidenceObservationIds
        .map((id) => evMap.get(id))
        .filter(Boolean)
        .map((o) => ({
          observation_id: o!.id,
          logged_at: o!.loggedAt,
          type: o!.observationType,
          rating: o!.rating,
          note: o!.note,
          task_name: tasks.find((t) => t.id === o!.taskId)?.taskName ?? null,
        }));

      const row = {
        org_id: plan.org_id ?? undefined,
        client_id: plan.client_id,
        care_plan_id: carePlanId,
        severity: signal.severity,
        categories: signal.categories,
        summary: signal.summary,
        sbar: signal.sbar,
        evidence,
        window_start: acuteStart,
        window_end: new Date(now).toISOString(),
        agent_id: agent.id,
        model,
      };

      // Supabase writes return { error } rather than throwing. Check it
      // before counting success / emitting the event, otherwise a
      // constraint or schema rejection would report a false success and
      // operators would lose the only signal that the detector is broken.
      let writeError = null;
      if (disposition.action === 'update') {
        ({ error: writeError } = await supabase.from('care_signals').update(row).eq('id', disposition.targetId));
        if (!writeError) updated += 1;
      } else {
        ({ error: writeError } = await supabase.from('care_signals').insert(row));
        if (!writeError) created += 1;
      }
      if (writeError) {
        console.error('care-coordinator: care_signals write failed', plan.client_id, writeError.message);
        failed += 1;
        continue; // don't emit a success event for a write that didn't land
      }

      // Best-effort event log (full instrumentation lands in M3).
      await supabase.from('events').insert({
        event_type: 'care_signal_created',
        entity_type: 'client',
        entity_id: plan.client_id,
        actor: 'system:care_coordinator',
        agent_id: agent.id,
        payload: { severity: signal.severity, categories: signal.categories, action: disposition.action },
      });
    } catch (err) {
      console.error('care-coordinator sweep error for care_plan', carePlanId, err);
    }
  }

  return jsonResponse({ ok: true, evaluated, created, updated, failed });
});
