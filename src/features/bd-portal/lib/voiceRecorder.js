// Voice memo recording helpers.
//
// Wraps the browser's MediaRecorder API into a small, testable
// surface. The QuickCapture component holds an instance, calls
// start() / stop(), and gets a Blob back from stop().
//
// Two pure helpers are exported separately so they can be unit
// tested without faking a MediaRecorder:
//
//   - pickSupportedMimeType(env)    — chooses the best audio mime
//                                      type the browser will record
//   - formatDuration(secs)          — pretty "0:07" / "1:23" string
//
// Recording to webm/opus is the default on Chrome and Firefox.
// iOS Safari (16.4+) supports MediaRecorder but only with `audio/mp4`
// — pickSupportedMimeType handles the difference.

export const SUPPORTED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Returns the first mime type from SUPPORTED_MIME_TYPES that the env
// reports support for, or '' if nothing matches (caller falls back
// to the browser default).
export function pickSupportedMimeType(env = (typeof window !== 'undefined' ? window : {})) {
  const MR = env?.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const t of SUPPORTED_MIME_TYPES) {
    if (MR.isTypeSupported(t)) return t;
  }
  return '';
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Cap recordings at 5 minutes to prevent runaway memos that would
// also blow past Whisper's per-request size budget.
export const MAX_RECORDING_SECONDS = 300;

export function isRecordingSupported(env = (typeof window !== 'undefined' ? window : {})) {
  return Boolean(
    env?.MediaRecorder
    && env?.navigator?.mediaDevices?.getUserMedia,
  );
}

// Tiny class around MediaRecorder. Not React-specific so the
// QuickCapture screen can hold one in a ref and not worry about
// re-renders triggering teardown.
export class VoiceRecorder {
  constructor() {
    this._stream = null;
    this._recorder = null;
    this._chunks = [];
    this._mimeType = '';
    this._startedAt = 0;
    this._stopPromise = null;
    this._stopResolve = null;
    this._stopReject = null;
  }

  isRecording() {
    return this._recorder?.state === 'recording';
  }

  async start() {
    if (this.isRecording()) throw new Error('Already recording');
    if (!isRecordingSupported()) throw new Error('Voice recording is not supported on this device.');

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw new Error(
        e?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Enable it in your browser settings to record memos.'
          : `Could not access the microphone: ${e?.message ?? e}`,
      );
    }
    this._stream = stream;
    this._mimeType = pickSupportedMimeType();
    this._chunks = [];

    const opts = this._mimeType ? { mimeType: this._mimeType } : undefined;
    this._recorder = new MediaRecorder(stream, opts);
    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    this._recorder.onstop = () => {
      const blob = new Blob(this._chunks, { type: this._mimeType || 'audio/webm' });
      try { this._stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      this._stream = null;
      this._stopResolve?.(blob);
    };
    this._recorder.onerror = (e) => {
      this._stopReject?.(e?.error ?? new Error('Recorder failed'));
    };
    this._recorder.start();
    this._startedAt = Date.now();
  }

  // Stops recording. Resolves with a Blob containing the audio.
  // Idempotent — calling stop() twice returns the same promise.
  stop() {
    if (!this._recorder) return Promise.resolve(null);
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = new Promise((resolve, reject) => {
      this._stopResolve = resolve;
      this._stopReject  = reject;
      try {
        if (this._recorder.state === 'recording') this._recorder.stop();
        else resolve(new Blob(this._chunks, { type: this._mimeType || 'audio/webm' }));
      } catch (e) {
        reject(e);
      }
    });
    return this._stopPromise;
  }

  // Best-effort cancel. Used when the user closes the form without
  // saving — drops the audio, releases the microphone.
  cancel() {
    try {
      if (this._recorder?.state === 'recording') this._recorder.stop();
      this._stream?.getTracks().forEach((t) => t.stop());
    } catch { /* noop */ }
    this._stream = null;
    this._recorder = null;
    this._chunks = [];
    this._stopPromise = null;
    this._stopResolve = null;
    this._stopReject = null;
  }

  elapsedSeconds() {
    if (!this._startedAt) return 0;
    return (Date.now() - this._startedAt) / 1000;
  }

  mimeType() {
    return this._mimeType;
  }
}
