/**
 * Tests for src/lib/voice/embeddableMessages.js — the postMessage
 * payload shapers for the RingCentral Embeddable widget.
 */

import { describe, it, expect } from 'vitest';
import { buildNewCallMessage, isEmbeddableEvent } from '../embeddableMessages';

describe('buildNewCallMessage', () => {
  it('produces the rc-adapter-new-call shape with toCall=true by default', () => {
    expect(buildNewCallMessage('+15551234567')).toEqual({
      type: 'rc-adapter-new-call',
      phoneNumber: '+15551234567',
      toCall: true,
    });
  });

  it('honours toCall=false (prefill, no auto-dial)', () => {
    expect(buildNewCallMessage('+15551234567', { toCall: false })).toEqual({
      type: 'rc-adapter-new-call',
      phoneNumber: '+15551234567',
      toCall: false,
    });
  });

  it('trims whitespace from the phone number', () => {
    expect(buildNewCallMessage('  +15551234567  ')).toEqual({
      type: 'rc-adapter-new-call',
      phoneNumber: '+15551234567',
      toCall: true,
    });
  });

  it('returns null for falsy / empty inputs (PhoneCallButton uses this to skip the postMessage)', () => {
    expect(buildNewCallMessage(null)).toBe(null);
    expect(buildNewCallMessage(undefined)).toBe(null);
    expect(buildNewCallMessage('')).toBe(null);
    expect(buildNewCallMessage('   ')).toBe(null);
  });

  it('coerces non-string phone numbers without throwing', () => {
    expect(buildNewCallMessage(5551234567)).toEqual({
      type: 'rc-adapter-new-call',
      phoneNumber: '5551234567',
      toCall: true,
    });
  });
});

describe('isEmbeddableEvent', () => {
  it('recognises rc-prefixed event payloads', () => {
    expect(isEmbeddableEvent({ type: 'rc-call-ring-notify' })).toBe(true);
    expect(isEmbeddableEvent({ type: 'rc-login-status-notify' })).toBe(true);
    expect(isEmbeddableEvent({ type: 'rc-call-end-notify', data: {} })).toBe(true);
  });

  it('rejects non-RC and malformed payloads', () => {
    expect(isEmbeddableEvent({ type: 'something-else' })).toBe(false);
    expect(isEmbeddableEvent({})).toBe(false);
    expect(isEmbeddableEvent(null)).toBe(false);
    expect(isEmbeddableEvent(undefined)).toBe(false);
    expect(isEmbeddableEvent('rc-call-ring-notify')).toBe(false);
  });
});
