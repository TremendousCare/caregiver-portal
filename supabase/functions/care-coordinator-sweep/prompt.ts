// ─── Detector prompt builder ───────────────────────────────────
//
// Builds the system + user prompt for one client's analysis. The model
// returns a single structured JSON verdict (no tool loop) — cheaper,
// faster, and more deterministic for a batch surveillance job.
//
// Pure string building — unit-testable.

import { categoriesRubric } from './stopAndWatch.ts';
import { ObservationSummary } from './analysis.ts';

export interface ClientContext {
  preferredName: string | null;
  ageOrDob: string | null;
  // Compact baseline pulled from the published care-plan version.
  baselineNarrative: string;
}

export function buildSystemPrompt(): string {
  return [
    'You are a home-care Care Coordinator performing CLINICAL SURVEILLANCE, not diagnosis.',
    'You read a client\'s recent caregiver-logged shift observations and compare them to that client\'s own baseline (their care plan and their normal recent pattern).',
    'Your single job: decide whether there is a CLUSTER of changes that a human should review today as a possible change of condition.',
    '',
    'Use the validated "Stop and Watch" early-warning categories:',
    categoriesRubric(),
    '',
    'HARD RULES:',
    '- Baseline-relative: judge against THIS client. Behaviors their care plan documents as normal (e.g. frequently refuses meals, needs 2-person transfer) are NOT signals.',
    '- Clusters, not points: a single isolated observation is almost never a signal. Look for multiple categories co-occurring, or a clear worsening trend across recent shifts.',
    '- Default to silence. If in doubt, do not signal. Precision matters more than recall.',
    '- Decision support only: never diagnose or instruct care. Recommendations are always "recommend a nurse/office review," never orders.',
    '- Ground every signal in the actual observations: cite the observation ids you relied on.',
    '',
    'Respond with ONLY a JSON object, no prose, in this exact schema:',
    '{',
    '  "signal": boolean,                  // true only if a human should review',
    '  "categories": string[],            // Stop-and-Watch category ids that fired (from the list above)',
    '  "acute": boolean,                  // true if a clearly acute new symptom is present',
    '  "summary": string,                 // one sentence for the staff worklist',
    '  "sbar": {                          // nurse hand-off draft (omit fields you cannot fill)',
    '    "situation": string,',
    '    "background": string,',
    '    "assessment": string,',
    '    "recommendation": string',
    '  },',
    '  "evidence_observation_ids": string[]  // the observation ids behind this signal',
    '}',
    'If there is no cluster worth a human\'s attention, return {"signal": false}.',
  ].join('\n');
}

export function buildUserPrompt(client: ClientContext, summary: ObservationSummary): string {
  const lines: string[] = [];
  lines.push(`CLIENT: ${client.preferredName ?? 'Unknown'}${client.ageOrDob ? ` (${client.ageOrDob})` : ''}`);
  lines.push('');
  lines.push('CARE-PLAN BASELINE (what is normal / expected for this client):');
  lines.push(client.baselineNarrative || '(no published care-plan baseline available)');
  lines.push('');

  lines.push(`RECENT TASK TRENDS (baseline vs. acute window):`);
  if (summary.taskTrends.length === 0) {
    lines.push('(no task-completion history)');
  } else {
    for (const t of summary.taskTrends) {
      const b = t.baseline;
      const a = t.acute;
      lines.push(
        `- ${t.taskName}: baseline done/partial/not-done = ${b.done}/${b.partial}/${b.not_done}; ` +
          `acute = ${a.done}/${a.partial}/${a.not_done}${t.declined ? '  <-- DECLINING' : ''}`,
      );
    }
  }
  lines.push('');

  if (Object.keys(summary.baselineMood).length > 0) {
    lines.push(`BASELINE MOOD MIX: ${JSON.stringify(summary.baselineMood)}`);
    lines.push('');
  }

  lines.push(`ACUTE WINDOW OBSERVATIONS (${summary.acuteCount} entries, oldest first):`);
  if (summary.acute.length === 0) {
    lines.push('(none)');
  } else {
    for (const o of summary.acute) {
      const label = o.taskName ? `${o.taskName} — ${o.type}` : o.type;
      const rating = o.rating ? ` [${o.rating}]` : '';
      const note = o.note ? ` — "${o.note}"` : '';
      lines.push(`- id=${o.id} (${o.loggedAt}) ${label}${rating}${note}`);
    }
  }
  lines.push('');
  lines.push('Decide whether to signal. Return only the JSON object.');
  return lines.join('\n');
}
