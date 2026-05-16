// ─── Pipeline Health — Pure Logic ───
//
// Testable functions for the /pipeline-health surface (Phase 1.5
// follow-up — the daily-driver view that replaces the retired
// AI Priorities feed). No React, no Supabase — just data
// transformation.
//
// Spec: docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md
//
// The "stalled" axis is **days in the current phase** —
// pipeline-health language an owner instantly understands, not
// "days since last AI action." `daysSinceActivity` is the
// secondary signal (distinguishes "stuck but waiting on
// someone" from "stuck and forgotten").

import { PHASES } from './constants';
import { getCurrentPhase, getDaysInPhase } from './utils';
import { getLastActivityTimestamp } from './aiPriorities';

// ─── Stall thresholds (locked in spec §8 D3) ───
// Revisit after ~4 weeks of operator use; both become editable
// per-org in Phase D once we have data.
export const STALL_AMBER_DAYS = 5;
export const STALL_RED_DAYS = 14;

export function stallSeverity(daysInPhase) {
  if (typeof daysInPhase !== 'number' || daysInPhase < STALL_AMBER_DAYS) return 'none';
  if (daysInPhase >= STALL_RED_DAYS) return 'red';
  return 'amber';
}

// ─── Pipeline-health row builder ───
//
// Takes one caregiver and returns a row shape ready for the table:
//   { caregiver, currentPhase, daysInPhase, daysSinceActivity, severity }
// Returns null when the caregiver should be excluded from the view
// (archived, deployed/reserve, nameless).

export function buildPipelineRow(cg, nowMs = Date.now()) {
  if (!cg || cg.archived) return null;
  if (cg.board_status === 'deployed' || cg.board_status === 'reserve') return null;
  // Active-roster caregivers are no longer "in the funnel."
  if (cg.employmentStatus && cg.employmentStatus !== 'onboarding') return null;
  if (!cg.first_name && !cg.last_name && !cg.firstName && !cg.lastName) return null;

  const currentPhase = getCurrentPhase(cg);
  const daysInPhase  = getDaysInPhase(cg);
  const lastActivity = getLastActivityTimestamp(cg);
  const daysSinceActivity = lastActivity
    ? Math.floor((nowMs - lastActivity) / 86400000)
    : null;

  return {
    caregiver:         cg,
    currentPhase,
    daysInPhase,
    daysSinceActivity,
    severity:          stallSeverity(daysInPhase),
  };
}

// ─── Group caregivers by current phase ───
//
// Returns an object keyed by phase id; each value is the rows in
// that phase, sorted by daysInPhase DESC (most stalled first).
// Phases with no caregivers still appear as empty arrays so the
// UI can render the section header with "(0 caregivers)" — spec
// §2 "Empty phases render the section header with `(0
// caregivers)` and no table."

export function groupCaregiversByPhase(caregivers, nowMs = Date.now()) {
  const grouped = {};
  for (const phase of PHASES) {
    grouped[phase.id] = [];
  }
  if (!Array.isArray(caregivers)) return grouped;

  for (const cg of caregivers) {
    const row = buildPipelineRow(cg, nowMs);
    if (!row) continue;
    // Caregivers with a phase outside the canonical PHASES list
    // (e.g. legacy data with a stale phase_override) get dropped
    // rather than displayed under a phantom bucket.
    if (!grouped[row.currentPhase]) continue;
    grouped[row.currentPhase].push(row);
  }

  // Sort each phase's rows by days-in-phase DESC. Ties broken by
  // entity id (stable, deterministic).
  for (const phaseId of Object.keys(grouped)) {
    grouped[phaseId].sort((a, b) => {
      if (b.daysInPhase !== a.daysInPhase) return b.daysInPhase - a.daysInPhase;
      const aid = a.caregiver?.id || '';
      const bid = b.caregiver?.id || '';
      return aid.localeCompare(bid);
    });
  }

  return grouped;
}

// ─── Median days-in-phase for a phase section ───
//
// Used in the section header next to the caregiver count. Pure;
// returns 0 for empty phases.

export function medianDaysInPhase(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const sorted = rows.map((r) => r.daysInPhase).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

// ─── Pending AI suggestion lookup ───
//
// Given a flat array of suggestions, return a Map<entity_id, suggestion>
// containing the freshest pending suggestion per entity. The
// pipeline-health table renders at most one inline AI badge per
// row, so we collapse multiple pending suggestions to the most
// recently created.

export function indexSuggestionsByEntity(suggestions) {
  const out = new Map();
  if (!Array.isArray(suggestions)) return out;
  for (const sug of suggestions) {
    if (!sug || !sug.entity_id) continue;
    const existing = out.get(sug.entity_id);
    if (!existing) {
      out.set(sug.entity_id, sug);
      continue;
    }
    const existingTs = existing.created_at ? Date.parse(existing.created_at) : 0;
    const candidateTs = sug.created_at ? Date.parse(sug.created_at) : 0;
    if (candidateTs > existingTs) out.set(sug.entity_id, sug);
  }
  return out;
}

// ─── Filter pipeline rows ───
//
// `phaseFilter` is a Set<phaseId>. When undefined, every phase
// passes through. When defined, only those phase ids survive.
// `stalledOnly` filters to severity != 'none'.
// `hasAiSuggestion` filters to rows whose caregiver has a pending
// suggestion in the supplied entity-indexed map.

export function filterPipelineGroups(grouped, options = {}) {
  const phaseFilter      = options.phaseFilter;
  const stalledOnly      = !!options.stalledOnly;
  const hasAiSuggestion  = !!options.hasAiSuggestion;
  const suggestionByEnt  = options.suggestionByEntity instanceof Map
    ? options.suggestionByEntity
    : null;

  const out = {};
  for (const [phaseId, rows] of Object.entries(grouped || {})) {
    if (phaseFilter && !phaseFilter.has(phaseId)) continue;
    let kept = rows;
    if (stalledOnly) {
      kept = kept.filter((r) => r.severity !== 'none');
    }
    if (hasAiSuggestion && suggestionByEnt) {
      kept = kept.filter((r) => suggestionByEnt.has(r.caregiver?.id));
    }
    out[phaseId] = kept;
  }
  return out;
}
