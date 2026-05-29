import { describe, it, expect } from 'vitest';
import {
  statusMeta,
  canRetry,
  speakerLabel,
  buildSpeakerTurns,
  extFromMime,
  assessmentAudioPath,
  isLikelyAudio,
  formatAssessmentTimestamp,
  pickEmbeddedTranscription,
} from '../assessmentTranscript';

describe('statusMeta', () => {
  it('maps known statuses to label + tone', () => {
    expect(statusMeta('transcribed')).toEqual({ label: 'Transcribed', tone: 'success' });
    expect(statusMeta('transcribing').tone).toBe('active');
    expect(statusMeta('failed').tone).toBe('error');
    expect(statusMeta('uploaded').tone).toBe('active');
  });
  it('falls back gracefully for unknown status', () => {
    expect(statusMeta('weird')).toEqual({ label: 'weird', tone: 'pending' });
    expect(statusMeta(undefined).label).toBe('Unknown');
  });
});

describe('canRetry', () => {
  it('only failed rows can be retried', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('transcribing')).toBe(false);
    expect(canRetry('transcribed')).toBe(false);
    expect(canRetry('uploaded')).toBe(false);
  });
});

describe('speakerLabel', () => {
  it('1-indexes numeric speakers', () => {
    expect(speakerLabel(0)).toBe('Speaker 1');
    expect(speakerLabel(2)).toBe('Speaker 3');
  });
  it('generic label for non-numeric speaker', () => {
    expect(speakerLabel(null)).toBe('Speaker');
    expect(speakerLabel(undefined)).toBe('Speaker');
  });
});

describe('buildSpeakerTurns', () => {
  it('merges consecutive same-speaker utterances into one turn', () => {
    const json = {
      utterances: [
        { speaker: 0, text: 'Hello.' },
        { speaker: 0, text: 'How are you?' },
        { speaker: 1, text: 'I am well.' },
        { speaker: 0, text: 'Good.' },
      ],
    };
    const turns = buildSpeakerTurns(json, '');
    expect(turns).toEqual([
      { speaker: 0, label: 'Speaker 1', text: 'Hello. How are you?' },
      { speaker: 1, label: 'Speaker 2', text: 'I am well.' },
      { speaker: 0, label: 'Speaker 1', text: 'Good.' },
    ]);
  });

  it('skips empty utterances', () => {
    const json = { utterances: [{ speaker: 0, text: '  ' }, { speaker: 0, text: 'Real.' }] };
    expect(buildSpeakerTurns(json, '')).toEqual([
      { speaker: 0, label: 'Speaker 1', text: 'Real.' },
    ]);
  });

  it('falls back to a single untagged turn from flat transcript', () => {
    expect(buildSpeakerTurns(null, 'Just the flat text.')).toEqual([
      { speaker: null, label: null, text: 'Just the flat text.' },
    ]);
    expect(buildSpeakerTurns({ utterances: [] }, 'Flat only.')).toEqual([
      { speaker: null, label: null, text: 'Flat only.' },
    ]);
  });

  it('returns [] when there is nothing to show', () => {
    expect(buildSpeakerTurns(null, '')).toEqual([]);
    expect(buildSpeakerTurns({ utterances: [] }, '   ')).toEqual([]);
  });
});

describe('extFromMime', () => {
  it('maps common recorder/upload mimes', () => {
    expect(extFromMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extFromMime('audio/mp4')).toBe('mp4');
    expect(extFromMime('audio/ogg')).toBe('ogg');
    expect(extFromMime('audio/wav')).toBe('wav');
    expect(extFromMime('audio/mpeg')).toBe('mp3');
    expect(extFromMime('')).toBe('webm');
    expect(extFromMime(undefined)).toBe('webm');
  });
});

describe('assessmentAudioPath', () => {
  it('puts org_id first (RLS path-prefix gate)', () => {
    expect(assessmentAudioPath('org-1', 'asmt-9', 'audio/webm')).toBe('org-1/asmt-9.webm');
    expect(assessmentAudioPath('org-1', 'asmt-9', 'audio/mp4')).toBe('org-1/asmt-9.mp4');
  });
});

describe('isLikelyAudio', () => {
  it('accepts audio/* mime types', () => {
    expect(isLikelyAudio({ type: 'audio/webm', name: 'x.webm' })).toBe(true);
  });
  it('accepts known extensions when type is empty', () => {
    expect(isLikelyAudio({ type: '', name: 'visit.m4a' })).toBe(true);
  });
  it('rejects non-audio', () => {
    expect(isLikelyAudio({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false);
    expect(isLikelyAudio(null)).toBe(false);
  });
});

describe('pickEmbeddedTranscription', () => {
  const row = { transcript: 'hi', transcript_json: { utterances: [] }, confidence: 0.9 };
  it('returns the object when PostgREST embeds a to-one relation as an object', () => {
    expect(pickEmbeddedTranscription(row)).toBe(row);
  });
  it('returns the first element when embedded as an array', () => {
    expect(pickEmbeddedTranscription([row])).toBe(row);
  });
  it('returns null for empty array / null / undefined', () => {
    expect(pickEmbeddedTranscription([])).toBeNull();
    expect(pickEmbeddedTranscription(null)).toBeNull();
    expect(pickEmbeddedTranscription(undefined)).toBeNull();
  });
});

describe('formatAssessmentTimestamp', () => {
  it('formats an ISO date', () => {
    const out = formatAssessmentTimestamp('2026-05-29T21:14:00Z');
    expect(out).toContain('2026');
    expect(out).toMatch(/May/);
  });
  it('tolerates bad input', () => {
    expect(formatAssessmentTimestamp('')).toBe('');
    expect(formatAssessmentTimestamp('not-a-date')).toBe('');
    expect(formatAssessmentTimestamp(null)).toBe('');
  });
});
