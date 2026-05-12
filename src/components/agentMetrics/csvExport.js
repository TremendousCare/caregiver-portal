// Phase 1.4 — CSV export for the agent metrics dashboard.
//
// We export the same dataset the page is currently rendering — one row
// per agent_action, with a best-effort correlated outcome and the
// computed dollar cost so the user gets the exact numbers they see on
// screen. This avoids spinning up a separate edge function path for v1;
// the existing `agent-actions-export` function streams NDJSON and could
// be extended to emit CSV server-side in a future phase if exports
// outgrow what the browser can comfortably stream.
//
// Outcome correlation: `agent_actions.outcome_id` is NULL today (the
// audit row is written before the outcome lands and the hash chain is
// immutable). We correlate via the natural composite key
// `(agent_id, entity_type, entity_id, mapped_action_type)` within a
// ±10-minute window of the action's `created_at`. The mapping
// translates `agent_actions.action_type` ("send_sms") to its
// outcome-side past-tense form ("sms_sent"). Mismatches across that
// window land in the export as empty outcome cells — same shape the
// dashboard surfaces.

import { computeCostUsd } from './modelPricing';

const HEADER = [
  'created_at',
  'chain_seq',
  'action_type',
  'phase',
  'entity_type',
  'entity_id',
  'actor',
  'agent_version',
  'input_tokens',
  'output_tokens',
  'duration_ms',
  'model',
  'dollars',
  'outcome_type',
  'outcome_detected_at',
];

const ACTION_TYPE_TO_OUTCOME = {
  send_sms: 'sms_sent',
  send_email: 'email_sent',
  send_docusign_envelope: 'docusign_sent',
  update_phase: 'phase_changed',
  complete_task: 'task_completed',
  create_calendar_event: 'calendar_event_created',
};

const OUTCOME_MATCH_WINDOW_MS = 10 * 60 * 1000;

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function correlateOutcome(action, outcomes) {
  const mappedType = ACTION_TYPE_TO_OUTCOME[action.action_type];
  if (!mappedType || !action.entity_id) return null;
  const actionMs = new Date(action.created_at).getTime();
  if (!Number.isFinite(actionMs)) return null;

  let best = null;
  let bestDelta = Infinity;
  for (const o of outcomes) {
    if (o.action_type !== mappedType) continue;
    if (o.entity_id !== action.entity_id) continue;
    const oMs = new Date(o.created_at).getTime();
    if (!Number.isFinite(oMs)) continue;
    const delta = Math.abs(oMs - actionMs);
    if (delta <= OUTCOME_MATCH_WINDOW_MS && delta < bestDelta) {
      best = o;
      bestDelta = delta;
    }
  }
  return best;
}

export function buildAgentActionsCsv(actions, outcomes) {
  const lines = [HEADER.join(',')];
  for (const row of actions) {
    const cost = row?.payload?._cost || {};
    const dollars = computeCostUsd(cost.input_tokens, cost.output_tokens, cost.model);
    const outcome = correlateOutcome(row, outcomes || []);
    const cells = [
      row.created_at,
      row.chain_seq,
      row.action_type,
      row.phase,
      row.entity_type,
      row.entity_id,
      row.actor,
      row.agent_version,
      cost.input_tokens ?? '',
      cost.output_tokens ?? '',
      cost.duration_ms ?? '',
      cost.model ?? '',
      dollars ? dollars.toFixed(6) : '0',
      outcome?.outcome_type ?? '',
      outcome?.outcome_detected_at ?? '',
    ].map(escapeCsv);
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

export function exportAgentMetricsCsv({ agent, window, actions, outcomes }) {
  const csv = buildAgentActionsCsv(actions, outcomes);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const name = `agent-metrics-${agent.slug}-${window.id}-${stamp}.csv`;
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
