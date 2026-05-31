// ─── Client health event helpers (pure) ────────────────────────
//
// Display + validation logic for client_health_events (hospitalizations,
// ED visits, falls, discharges) — the outcome-measurement substrate.
// No I/O, no React. Unit-tested.

// event_type → display metadata. `icon` is a lucide-react component name
// (no emoji glyphs, per UI conventions). The set MUST mirror the
// client_health_events CHECK constraint.
export const EVENT_TYPE_META = {
  hospitalization: { label: 'Hospitalization', icon: 'Building2', tone: 'danger' },
  ed_visit: { label: 'ED visit', icon: 'Ambulance', tone: 'danger' },
  fall: { label: 'Fall', icon: 'TrendingDown', tone: 'warning' },
  infection: { label: 'Infection', icon: 'Thermometer', tone: 'warning' },
  hospital_discharge: { label: 'Hospital discharge', icon: 'Home', tone: 'info' },
  death: { label: 'Death', icon: 'Heart', tone: 'neutral' },
  other: { label: 'Other', icon: 'CircleDot', tone: 'neutral' },
};

export const EVENT_TYPES = Object.keys(EVENT_TYPE_META);

export function eventTypeMeta(type) {
  return EVENT_TYPE_META[type] || EVENT_TYPE_META.other;
}

export function eventTypeLabel(type) {
  return eventTypeMeta(type).label;
}

const VALID_SOURCES = ['caregiver', 'family', 'office', 'partner'];

// Map a raw client_health_events row (snake_case) → camelCase view model.
export function mapHealthEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    relatedDischargeId: row.related_discharge_id ?? null,
    avoidable: row.avoidable ?? null,
    precedingSignalId: row.preceding_signal_id ?? null,
    source: row.source ?? null,
    note: row.note ?? null,
    recordedBy: row.recorded_by ?? null,
    createdAt: row.created_at ?? null,
  };
}

// Newest first for the client-page timeline.
export function sortHealthEvents(events) {
  return [...(events || [])].sort(
    (a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0),
  );
}

// Validate + normalize a logging-form input into a DB row. Returns
// { row, error }. occurredAt may be a Date, an ISO string, or a
// datetime-local string; we normalize to ISO.
export function buildHealthEventRow(input, { recordedBy } = {}) {
  if (!input || typeof input !== 'object') {
    return { row: null, error: new Error('Missing event input') };
  }
  const eventType = String(input.eventType ?? '').trim();
  if (!EVENT_TYPES.includes(eventType)) {
    return { row: null, error: new Error('A valid event type is required') };
  }
  let occurredAt = null;
  if (input.occurredAt instanceof Date) {
    occurredAt = Number.isNaN(input.occurredAt.getTime()) ? null : input.occurredAt.toISOString();
  } else if (typeof input.occurredAt === 'string' && input.occurredAt.trim()) {
    const d = new Date(input.occurredAt);
    occurredAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (!occurredAt) {
    return { row: null, error: new Error('When it occurred is required') };
  }
  if (!input.clientId) {
    return { row: null, error: new Error('clientId is required') };
  }
  const source = input.source && VALID_SOURCES.includes(input.source) ? input.source : 'office';
  const avoidable =
    input.avoidable === true || input.avoidable === false ? input.avoidable : null;

  return {
    row: {
      client_id: input.clientId,
      event_type: eventType,
      occurred_at: occurredAt,
      source,
      avoidable,
      note: (input.note || '').trim() || null,
      recorded_by: recordedBy || null,
    },
    error: null,
  };
}

// Is `event` (a hospitalization) a 30-day readmission, given the
// client's event history? Pure — used for the timeline badge and as a
// client-side mirror of the attribution job's logic.
export function isReadmission(event, events, { windowDays = 30 } = {}) {
  if (!event || event.eventType !== 'hospitalization') return false;
  if (event.relatedDischargeId) return true; // already attributed
  const occurred = new Date(event.occurredAt).getTime();
  const windowStart = occurred - windowDays * 86_400_000;
  return (events || []).some(
    (e) =>
      e.id !== event.id &&
      e.clientId === event.clientId &&
      e.eventType === 'hospital_discharge' &&
      (() => {
        const t = new Date(e.occurredAt).getTime();
        return t < occurred && t >= windowStart;
      })(),
  );
}
