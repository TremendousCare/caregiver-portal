// Pure helpers for the In-Home Assessment panel (capture + transcript
// display). Kept free of React / Supabase so they can be unit-tested in
// isolation — see src/lib/__tests__/assessmentTranscript.test.js.

// Map an assessment lifecycle status to a display label + a tone the UI
// uses to pick a badge color. Tones: pending | active | success | error.
const STATUS_META = {
  recording:   { label: 'Recording',     tone: 'pending' },
  uploaded:    { label: 'Queued',        tone: 'active' },
  transcribing:{ label: 'Transcribing…', tone: 'active' },
  transcribed: { label: 'Transcribed',   tone: 'success' },
  failed:      { label: 'Failed',         tone: 'error' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', tone: 'pending' };
}

// Only failed transcriptions offer a manual retry; in-flight rows are
// handled by the reconcile cron, and transcribed rows are done.
export function canRetry(status) {
  return status === 'failed';
}

// A 0-based Deepgram speaker index → a human label. Null/absent speaker
// (e.g. a flat transcript with no diarization) gets a generic label.
export function speakerLabel(speaker) {
  if (typeof speaker !== 'number' || !Number.isFinite(speaker)) return 'Speaker';
  return `Speaker ${speaker + 1}`;
}

// Turn Deepgram's per-utterance array into display "turns": consecutive
// utterances from the same speaker are merged into one block. Falls back
// to a single untagged turn from the flat transcript when there are no
// diarized utterances, and to [] when there's nothing to show.
export function buildSpeakerTurns(transcriptJson, flatTranscript) {
  const utterances = Array.isArray(transcriptJson?.utterances) ? transcriptJson.utterances : [];

  if (utterances.length > 0) {
    const turns = [];
    for (const u of utterances) {
      const text = (u?.text ?? '').trim();
      if (!text) continue;
      const speaker = typeof u?.speaker === 'number' ? u.speaker : null;
      const last = turns[turns.length - 1];
      if (last && last.speaker === speaker) {
        last.text = `${last.text} ${text}`.trim();
      } else {
        turns.push({ speaker, label: speakerLabel(speaker), text });
      }
    }
    if (turns.length > 0) return turns;
  }

  const flat = (flatTranscript ?? '').trim();
  if (flat) return [{ speaker: null, label: null, text: flat }];
  return [];
}

// File-extension chooser for the stored audio object, derived from the
// recorder/upload MIME type. Mirrors the extension logic in bd-transcribe.
export function extFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4'))  return 'mp4';
  if (m.includes('ogg'))  return 'ogg';
  if (m.includes('wav'))  return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

// Storage object key for an assessment's audio. The leading <org_id>/
// segment is what the assessment-audio bucket's RLS path-prefix check
// gates on, so it MUST come first.
export function assessmentAudioPath(orgId, assessmentId, mime) {
  return `${orgId}/${assessmentId}.${extFromMime(mime)}`;
}

// Accept a file as assessment audio if the browser tagged it audio/* or
// the name carries a known audio extension (some browsers report an
// empty type for, e.g., .m4a).
export function isLikelyAudio(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('audio/')) return true;
  return /\.(webm|mp3|m4a|mp4|wav|ogg|aac|flac)$/i.test(file.name || '');
}

// Generous cap for uploaded assessment audio (a full visit can run an
// hour). Deepgram accepts far larger; this just guards accidental
// non-audio / runaway uploads.
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// "May 29, 2026 · 2:14 PM" style stamp; tolerant of bad input.
export function formatAssessmentTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
