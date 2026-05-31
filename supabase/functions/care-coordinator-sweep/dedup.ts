// ─── Dedup: don't re-flag the same cluster every sweep ─────────
//
// The detector runs every few hours. Without dedup it would re-create a
// signal for the same observations on every pass. Pure decision logic —
// unit-testable.

import { Severity, severityRank } from './severity.ts';

export interface ExistingSignal {
  id: string;
  severity: Severity;
  evidenceObservationIds: string[];
}

export interface Candidate {
  severity: Severity;
  evidenceObservationIds: string[];
}

export type Disposition =
  | { action: 'insert' }
  | { action: 'update'; targetId: string }
  | { action: 'skip'; targetId: string };

/**
 * Decide what to do with a freshly-detected candidate given the client's
 * currently-open signals:
 *
 *   - overlaps an open signal (shares >=1 evidence observation) and is
 *     more severe  -> UPDATE that signal (escalation).
 *   - overlaps an open signal and is same/less severe -> SKIP (already
 *     surfaced; don't spam the worklist).
 *   - overlaps nothing open -> INSERT.
 */
export function decideDisposition(existingOpen: ExistingSignal[], candidate: Candidate): Disposition {
  const candIds = new Set(candidate.evidenceObservationIds);
  const overlap = existingOpen.find((s) => s.evidenceObservationIds.some((id) => candIds.has(id)));
  if (!overlap) return { action: 'insert' };
  if (severityRank(candidate.severity) > severityRank(overlap.severity)) {
    return { action: 'update', targetId: overlap.id };
  }
  return { action: 'skip', targetId: overlap.id };
}
