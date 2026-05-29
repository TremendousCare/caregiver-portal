// ─── Shared call-transcript note shape + idempotency helpers ────────────────
//
// Single source of truth for the `type: 'call'` note that gets appended to a
// caregiver/client `notes` array when a call transcript lands. Used by:
//   - post-call-processor/index.ts (the per-minute cron, live path)
//   - transcript-backfill/index.ts  (one-time recovery of calls whose
//                                     transcript never landed during the
//                                     2026-05-27 RingSense outage)
//
// Both paths must produce byte-identical notes and must be safe to re-run, so
// the build + dedupe logic lives here and is unit-tested independently of the
// edge-function runtime.

export interface CallNoteSource {
  direction: "inbound" | "outbound";
  from_e164: string | null;
  to_e164: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface CallTranscriptNote {
  text: string;
  type: "call";
  direction: "inbound" | "outbound";
  source: "ringcentral";
  timestamp: number;
  author: "Call Transcript";
  outcome: string;
}

// Stable per-call timestamp: the moment the call ended, in epoch ms. This is
// what the timeline sorts on AND what dedupe keys on, so it must be derived
// the same way everywhere. Falls back to now() only when ended_at is absent
// (which shouldn't happen for a recorded call, but keeps the function total).
export function callNoteTimestamp(endedAt: string | null): number {
  return endedAt ? Date.parse(endedAt) : Date.now();
}

// Builds the note object. Mirrors exactly what post-call-processor's
// appendCallNote() has always written, so the cron and the backfill are
// indistinguishable to the timeline UI.
export function buildCallTranscriptNote(
  row: CallNoteSource,
  transcript: string,
): CallTranscriptNote {
  const remotePhone = row.direction === "inbound" ? row.from_e164 : row.to_e164;
  const label = row.direction === "inbound" ? "Inbound" : "Outbound";
  const outcome =
    `${label} call` +
    `${remotePhone ? " " + remotePhone : ""}` +
    `${row.duration_seconds ? ` (${row.duration_seconds}s)` : ""}`;
  return {
    text: transcript,
    type: "call",
    direction: row.direction,
    source: "ringcentral",
    timestamp: callNoteTimestamp(row.ended_at),
    author: "Call Transcript",
    outcome,
  };
}

// Idempotency check: has a transcript note for this exact call already been
// appended? Keys on author + timestamp, which together uniquely identify a
// given call's transcript note within an entity's notes array. Lets both the
// cron and the backfill re-run without producing duplicate notes.
export function hasCallTranscriptNote(
  notes: unknown,
  timestamp: number,
): boolean {
  if (!Array.isArray(notes)) return false;
  return notes.some(
    (n) =>
      n &&
      typeof n === "object" &&
      (n as any).author === "Call Transcript" &&
      (n as any).timestamp === timestamp,
  );
}
