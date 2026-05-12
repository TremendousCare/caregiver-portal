// Phase 1.4 — CSV export for the agent metrics dashboard.
//
// We export the same dataset the page is currently rendering — one row
// per agent_action, with the joined outcome (when present) and the
// computed dollar cost so the user gets the exact numbers they see on
// screen. This avoids spinning up a separate edge function path for v1;
// the existing `agent-actions-export` function streams NDJSON and could
// be extended to emit CSV server-side in a future phase if exports
// outgrow what the browser can comfortably stream.

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
  'outcome_id',
  'outcome_type',
  'outcome_resolved_at',
];

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildAgentActionsCsv(actions, outcomes) {
  const outcomeById = new Map();
  for (const o of outcomes || []) outcomeById.set(o.id, o);

  const lines = [HEADER.join(',')];
  for (const row of actions) {
    const cost = row?.payload?._cost || {};
    const dollars = computeCostUsd(cost.input_tokens, cost.output_tokens, cost.model);
    const outcome = row.outcome_id ? outcomeById.get(row.outcome_id) : null;
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
      row.outcome_id ?? '',
      outcome?.outcome_type ?? '',
      outcome?.resolved_at ?? '',
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
