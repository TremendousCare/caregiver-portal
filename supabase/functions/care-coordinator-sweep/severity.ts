// ─── Deterministic severity grading ────────────────────────────
//
// The model's job is accurate *categorization* and a good SBAR draft —
// reading the notes is its strength. Final *severity* is decided here,
// deterministically, from the number of distinct Stop-and-Watch
// categories that fired. This keeps severity predictable, tunable from
// config, and enforces the design rule "clusters, not points": a single
// category never produces a signal.
//
// Pure functions only — unit-testable.

export interface SeverityThresholds {
  watch_min_categories: number;
  urgent_min_categories: number;
}

export const DEFAULT_THRESHOLDS: SeverityThresholds = {
  watch_min_categories: 2,
  urgent_min_categories: 3,
};

export type Severity = 'info' | 'watch' | 'urgent';

const RANK: Record<Severity, number> = { info: 0, watch: 1, urgent: 2 };

export function severityRank(s: Severity): number {
  return RANK[s] ?? -1;
}

/**
 * Grade severity from the distinct categories that fired.
 *
 *   - >= urgent_min_categories            -> 'urgent'
 *   - >= watch_min_categories             -> 'watch' (or 'urgent' if `acute`)
 *   - below watch threshold               -> null (stay silent)
 *
 * `acute` lets the model promote a borderline 2-category cluster to
 * urgent when it judges a clearly acute new symptom — but it can never
 * manufacture a signal from below the watch threshold.
 */
export function gradeSeverity(
  categories: string[],
  thresholds: SeverityThresholds = DEFAULT_THRESHOLDS,
  opts: { acute?: boolean } = {},
): Severity | null {
  const n = new Set(categories).size;
  if (n >= thresholds.urgent_min_categories) return 'urgent';
  if (n >= thresholds.watch_min_categories) return opts.acute ? 'urgent' : 'watch';
  return null;
}
