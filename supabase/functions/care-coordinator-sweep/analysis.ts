// ─── Observation analysis + detector-output normalization ──────
//
// Pure functions that (1) turn raw observations into a prompt-ready,
// baseline-relative summary and (2) validate + gate the model's JSON
// response. No I/O — unit-testable under vitest.

import { gradeSeverity, SeverityThresholds, Severity } from './severity.ts';
import { isValidCategory } from './stopAndWatch.ts';

// Shape the orchestrator maps DB rows into (camelCase, matching
// src/lib/carePlanObservationFormatting.js).
export interface Observation {
  id: string;
  observationType: string; // task_completion | refusal | shift_note | mood | concern | positive | vital | general
  rating: string | null; // done|partial|not_done (task_completion); great..poor (mood); numeric (vital)
  note: string | null;
  taskId: string | null;
  shiftId: string | null;
  loggedAt: string; // ISO timestamp
}

export interface Task {
  id: string;
  taskName: string;
  category: string | null;
}

export interface ObservationSummary {
  acuteCount: number;
  baselineCount: number;
  // Acute-window entries, oldest-first, with resolved task names.
  acute: Array<{ id: string; loggedAt: string; type: string; rating: string | null; note: string | null; taskName: string | null }>;
  // Per-task completion baseline vs acute (only tasks with task_completion data).
  taskTrends: Array<{
    taskName: string;
    baseline: { done: number; partial: number; not_done: number };
    acute: { done: number; partial: number; not_done: number };
    declined: boolean; // acute has partial/not_done where baseline was mostly done
  }>;
  baselineMood: Record<string, number>;
  acuteRefusals: number;
}

function emptyCounts() {
  return { done: 0, partial: 0, not_done: 0 };
}

/**
 * Build a baseline-relative summary. `acuteWindowStart` splits the
 * observations: anything logged on/after it is "acute"; everything else
 * (still within the baseline lookback the caller fetched) is "baseline".
 */
export function summarizeObservations(
  observations: Observation[],
  tasks: Task[],
  opts: { acuteWindowStart: string | Date },
): ObservationSummary {
  const cutoff = new Date(opts.acuteWindowStart).getTime();
  const taskName = (id: string | null) => (id ? tasks.find((t) => t.id === id)?.taskName ?? null : null);

  const acuteObs: Observation[] = [];
  const baselineObs: Observation[] = [];
  for (const o of observations) {
    (new Date(o.loggedAt).getTime() >= cutoff ? acuteObs : baselineObs).push(o);
  }

  const sortAsc = (a: Observation, b: Observation) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime();

  const perTask = new Map<string, { baseline: ReturnType<typeof emptyCounts>; acute: ReturnType<typeof emptyCounts> }>();
  const tally = (o: Observation, bucket: 'baseline' | 'acute') => {
    if (o.observationType !== 'task_completion' || !o.taskId || !o.rating) return;
    if (!perTask.has(o.taskId)) perTask.set(o.taskId, { baseline: emptyCounts(), acute: emptyCounts() });
    const counts = perTask.get(o.taskId)![bucket] as Record<string, number>;
    if (o.rating in counts) counts[o.rating] += 1;
  };
  baselineObs.forEach((o) => tally(o, 'baseline'));
  acuteObs.forEach((o) => tally(o, 'acute'));

  const taskTrends: ObservationSummary['taskTrends'] = [];
  for (const [taskId, c] of perTask) {
    const baseDone = c.baseline.done;
    const baseTotal = c.baseline.done + c.baseline.partial + c.baseline.not_done;
    const acuteMisses = c.acute.partial + c.acute.not_done;
    // "Declined" = task was reliably done at baseline (>=60% done) but is
    // now being missed/partially done in the acute window.
    const declined = baseTotal > 0 && baseDone / baseTotal >= 0.6 && acuteMisses > 0;
    taskTrends.push({
      taskName: taskName(taskId) ?? '(unknown task)',
      baseline: c.baseline,
      acute: c.acute,
      declined,
    });
  }

  const baselineMood: Record<string, number> = {};
  for (const o of baselineObs) {
    if (o.observationType === 'mood' && o.rating) baselineMood[o.rating] = (baselineMood[o.rating] ?? 0) + 1;
  }

  return {
    acuteCount: acuteObs.length,
    baselineCount: baselineObs.length,
    acute: acuteObs.sort(sortAsc).map((o) => ({
      id: o.id,
      loggedAt: o.loggedAt,
      type: o.observationType,
      rating: o.rating,
      note: o.note,
      taskName: taskName(o.taskId),
    })),
    taskTrends,
    baselineMood,
    acuteRefusals: acuteObs.filter((o) => o.observationType === 'refusal').length,
  };
}

export interface NormalizedSignal {
  severity: Severity;
  categories: string[];
  summary: string;
  sbar: { situation?: string; background?: string; assessment?: string; recommendation?: string } | null;
  evidenceObservationIds: string[];
  acute: boolean;
}

/**
 * Validate + gate the model's raw JSON. Returns null when the model
 * declined to signal, the categories don't clear the cluster threshold,
 * or the payload is malformed — i.e. when we should stay silent.
 */
export function normalizeDetectorOutput(
  raw: unknown,
  opts: { thresholds: SeverityThresholds },
): NormalizedSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.signal !== true) return null;

  const categories = Array.isArray(r.categories)
    ? Array.from(new Set(r.categories.filter(isValidCategory) as string[]))
    : [];
  const acute = r.acute === true;
  const severity = gradeSeverity(categories, opts.thresholds, { acute });
  if (!severity) return null; // below cluster threshold -> silent

  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (!summary) return null; // a signal must say something

  const sbarRaw = (r.sbar && typeof r.sbar === 'object' ? r.sbar : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof sbarRaw[k] === 'string' ? (sbarRaw[k] as string) : undefined);
  const sbar = {
    situation: pick('situation'),
    background: pick('background'),
    assessment: pick('assessment'),
    recommendation: pick('recommendation'),
  };

  const evidenceObservationIds = Array.isArray(r.evidence_observation_ids)
    ? (r.evidence_observation_ids.filter((x) => typeof x === 'string') as string[])
    : [];

  return { severity, categories, summary, sbar, evidenceObservationIds, acute };
}
