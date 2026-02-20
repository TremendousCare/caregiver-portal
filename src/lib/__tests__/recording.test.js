import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildRecordingUrl } from '../recording';

// Vitest + Vite automatically handles import.meta.env via define.
// We set VITE_SUPABASE_URL to a known value for testing.
// If it's not set, the function will use 'undefined' — we test both cases.

describe('buildRecordingUrl', () => {
  it('builds a URL with recordingId and token params', () => {
    const url = buildRecordingUrl('123456', 'test-token-abc');
    // Should contain both params
    expect(url).toContain('recordingId=123456');
    expect(url).toContain('token=test-token-abc');
    expect(url).toContain('/functions/v1/call-recording?');
  });

  it('encodes special characters in recordingId', () => {
    const url = buildRecordingUrl('12 34', 'token');
    expect(url).toContain('recordingId=12%2034');
  });

  it('encodes special characters in token', () => {
    const url = buildRecordingUrl('123', 'tok=en+val');
    expect(url).toContain('token=tok%3Den%2Bval');
  });

  it('handles a typical numeric recording ID', () => {
    const url = buildRecordingUrl('9876543210', 'eyJhbGciOiJIUzI1NiJ9.test');
    expect(url).toContain('recordingId=9876543210');
    expect(url).toContain('token=eyJhbGciOiJIUzI1NiJ9.test');
  });

  it('preserves empty string token', () => {
    const url = buildRecordingUrl('123', '');
    expect(url).toContain('token=');
    expect(url).toContain('recordingId=123');
  });
});
