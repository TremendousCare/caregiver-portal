/**
 * Tests for supabase/functions/_shared/operations/callTranscriptNote.ts —
 * the shared call-transcript note builder + idempotency helpers used by both
 * the post-call-processor cron and the one-time transcript-backfill function.
 *
 * The note shape must stay byte-identical to what the cron has always written
 * so the timeline UI can't tell a backfilled note from a live one, and the
 * dedupe must let both paths re-run without producing duplicate notes.
 */

import { describe, it, expect } from 'vitest';

async function loadModule() {
  return await import(
    '../../../supabase/functions/_shared/operations/callTranscriptNote.ts'
  );
}

const ENDED = '2026-05-27T18:30:00.000Z';
const ENDED_MS = Date.parse(ENDED);

describe('callNoteTimestamp', () => {
  it('returns epoch ms of ended_at when present', async () => {
    const { callNoteTimestamp } = await loadModule();
    expect(callNoteTimestamp(ENDED)).toBe(ENDED_MS);
  });

  it('falls back to now() when ended_at is null', async () => {
    const { callNoteTimestamp } = await loadModule();
    const before = Date.now();
    const ts = callNoteTimestamp(null);
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});

describe('buildCallTranscriptNote', () => {
  it('builds an inbound note keyed on the caller (from_e164)', async () => {
    const { buildCallTranscriptNote } = await loadModule();
    const note = buildCallTranscriptNote(
      {
        direction: 'inbound',
        from_e164: '+14155551234',
        to_e164: '+18005550000',
        ended_at: ENDED,
        duration_seconds: 45,
      },
      'Speaker 1: hello',
    );
    expect(note).toEqual({
      text: 'Speaker 1: hello',
      type: 'call',
      direction: 'inbound',
      source: 'ringcentral',
      timestamp: ENDED_MS,
      author: 'Call Transcript',
      outcome: 'Inbound call +14155551234 (45s)',
    });
  });

  it('builds an outbound note keyed on the callee (to_e164)', async () => {
    const { buildCallTranscriptNote } = await loadModule();
    const note = buildCallTranscriptNote(
      {
        direction: 'outbound',
        from_e164: '+18005550000',
        to_e164: '+14155559876',
        ended_at: ENDED,
        duration_seconds: 12,
      },
      'transcript body',
    );
    expect(note.direction).toBe('outbound');
    expect(note.outcome).toBe('Outbound call +14155559876 (12s)');
  });

  it('omits the phone segment when the relevant number is null', async () => {
    const { buildCallTranscriptNote } = await loadModule();
    const note = buildCallTranscriptNote(
      { direction: 'inbound', from_e164: null, to_e164: null, ended_at: ENDED, duration_seconds: 30 },
      't',
    );
    expect(note.outcome).toBe('Inbound call (30s)');
  });

  it('omits the duration segment when duration is null or zero', async () => {
    const { buildCallTranscriptNote } = await loadModule();
    const noDur = buildCallTranscriptNote(
      { direction: 'inbound', from_e164: '+14155551234', to_e164: null, ended_at: ENDED, duration_seconds: null },
      't',
    );
    expect(noDur.outcome).toBe('Inbound call +14155551234');
    const zeroDur = buildCallTranscriptNote(
      { direction: 'inbound', from_e164: '+14155551234', to_e164: null, ended_at: ENDED, duration_seconds: 0 },
      't',
    );
    expect(zeroDur.outcome).toBe('Inbound call +14155551234');
  });
});

describe('hasCallTranscriptNote', () => {
  it('detects an existing transcript note by author + timestamp', async () => {
    const { hasCallTranscriptNote } = await loadModule();
    const notes = [
      { author: 'Jessica', type: 'note', timestamp: 1 },
      { author: 'Call Transcript', timestamp: ENDED_MS },
    ];
    expect(hasCallTranscriptNote(notes, ENDED_MS)).toBe(true);
  });

  it('returns false when no note matches the timestamp', async () => {
    const { hasCallTranscriptNote } = await loadModule();
    const notes = [{ author: 'Call Transcript', timestamp: 999 }];
    expect(hasCallTranscriptNote(notes, ENDED_MS)).toBe(false);
  });

  it('returns false for a same-timestamp note authored by someone else', async () => {
    const { hasCallTranscriptNote } = await loadModule();
    const notes = [{ author: 'SMS Webhook', timestamp: ENDED_MS }];
    expect(hasCallTranscriptNote(notes, ENDED_MS)).toBe(false);
  });

  it('treats a non-array notes value as empty', async () => {
    const { hasCallTranscriptNote } = await loadModule();
    expect(hasCallTranscriptNote(null, ENDED_MS)).toBe(false);
    expect(hasCallTranscriptNote(undefined, ENDED_MS)).toBe(false);
    expect(hasCallTranscriptNote('not-an-array', ENDED_MS)).toBe(false);
  });

  it('round-trips: a freshly built note is detected as already present', async () => {
    const { buildCallTranscriptNote, hasCallTranscriptNote, callNoteTimestamp } = await loadModule();
    const row = { direction: 'inbound', from_e164: '+1', to_e164: null, ended_at: ENDED, duration_seconds: 5 };
    const note = buildCallTranscriptNote(row, 'x');
    expect(hasCallTranscriptNote([note], callNoteTimestamp(row.ended_at))).toBe(true);
  });
});
