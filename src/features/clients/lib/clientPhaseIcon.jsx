import {
  Bell,
  MessageSquare,
  FileText,
  CheckCircle2,
  XCircle,
  Sprout,
  Circle,
} from 'lucide-react';

// Canonical lucide-react icon map for client pipeline phases.
// Mirrors the BD-portal `activityTypeIcon` pattern (the reference
// implementation called out in CLAUDE.md) so the icon mapping is a
// single source of truth — every place that needs a phase glyph
// renders <ClientPhaseIcon phaseId="..." /> instead of looking at
// CLIENT_PHASES.icon, which previously held emoji glyphs and is being
// retired in favor of lucide components.
const MAP = {
  new_lead:  Bell,
  consult:   MessageSquare,
  proposal:  FileText,
  won:       CheckCircle2,
  lost:      XCircle,
  nurture:   Sprout,
  // Legacy pre-consolidation phase IDs. Still surfaced briefly while
  // any cached state references them (e.g. open AI chat sessions that
  // pulled phase strings before the migration ran).
  initial_contact: MessageSquare,
  consultation:    MessageSquare,
  assessment:      FileText,
};

export function ClientPhaseIcon({ phaseId, size = 14, className, strokeWidth = 2 }) {
  const Cmp = MAP[phaseId] ?? Circle;
  return <Cmp size={size} className={className} strokeWidth={strokeWidth} aria-hidden />;
}

export const CLIENT_PHASE_ICON_IDS = Object.keys(MAP);
