import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_MIME_TYPES,
  MAX_RECORDING_SECONDS,
  pickSupportedMimeType,
  formatDuration,
  isRecordingSupported,
} from '../../features/bd-portal/lib/voiceRecorder';

describe('SUPPORTED_MIME_TYPES', () => {
  it('lists webm/opus first, then mp4 for Safari', () => {
    expect(SUPPORTED_MIME_TYPES[0]).toBe('audio/webm;codecs=opus');
    expect(SUPPORTED_MIME_TYPES).toContain('audio/mp4');
  });
});

describe('MAX_RECORDING_SECONDS', () => {
  it('caps recordings at 5 minutes', () => {
    expect(MAX_RECORDING_SECONDS).toBe(300);
  });
});

describe('formatDuration', () => {
  it('formats m:ss with zero-padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(3661)).toBe('61:01');
  });
  it('handles fractional seconds by flooring', () => {
    expect(formatDuration(7.9)).toBe('0:07');
  });
  it('returns 0:00 for negative or non-finite input', () => {
    expect(formatDuration(-1)).toBe('0:00');
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
  });
});

describe('pickSupportedMimeType', () => {
  it('returns the empty string when MediaRecorder is unavailable', () => {
    expect(pickSupportedMimeType({})).toBe('');
    expect(pickSupportedMimeType({ MediaRecorder: undefined })).toBe('');
  });

  it('returns the empty string when isTypeSupported is missing', () => {
    expect(pickSupportedMimeType({ MediaRecorder: function FakeMR() {} })).toBe('');
  });

  it('chooses webm/opus when supported (Chrome/Firefox)', () => {
    const env = {
      MediaRecorder: { isTypeSupported: (t) => t === 'audio/webm;codecs=opus' },
    };
    expect(pickSupportedMimeType(env)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to mp4 when only mp4 is supported (iOS Safari)', () => {
    const env = {
      MediaRecorder: { isTypeSupported: (t) => t === 'audio/mp4' },
    };
    expect(pickSupportedMimeType(env)).toBe('audio/mp4');
  });

  it('returns the empty string when nothing matches', () => {
    const env = { MediaRecorder: { isTypeSupported: () => false } };
    expect(pickSupportedMimeType(env)).toBe('');
  });
});

describe('isRecordingSupported', () => {
  it('false when MediaRecorder is missing', () => {
    expect(isRecordingSupported({})).toBe(false);
  });

  it('false when getUserMedia is missing', () => {
    expect(isRecordingSupported({
      MediaRecorder: function () {},
      navigator: { mediaDevices: {} },
    })).toBe(false);
  });

  it('true when both are present', () => {
    expect(isRecordingSupported({
      MediaRecorder: function () {},
      navigator: { mediaDevices: { getUserMedia: () => {} } },
    })).toBe(true);
  });
});
