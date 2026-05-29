// ─── Transcript-backfill row selection ──────────────────────────────────────
//
// Pure helper for the one-time transcript-backfill function. PostgREST can't
// express the anti-join "call_sessions with no row in call_transcriptions",
// so the function fetches a candidate window and the set of already-cached
// recording_ids separately, then subtracts here. Keeping this pure makes the
// drain logic (the bit that lets repeated batches make progress instead of
// re-returning the same top rows) unit-testable without the edge runtime.

export interface HasRecordingId {
  recording_id: string;
}

// Returns the candidates whose recording has NOT yet been transcribed, in the
// same order they were passed. Once a row is processed its recording lands in
// call_transcriptions, so on the next invocation it is filtered out here and
// the batch advances to fresh rows.
export function filterUncached<T extends HasRecordingId>(
  candidates: T[],
  cachedRecordingIds: Iterable<string>,
): T[] {
  const cached = new Set(cachedRecordingIds);
  return candidates.filter((c) => !cached.has(c.recording_id));
}
