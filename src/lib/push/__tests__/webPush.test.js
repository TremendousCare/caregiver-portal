import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array, serializeSubscription, buildReminderPayload } from '../webPush';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to the right byte length', () => {
    // A real uncompressed P-256 public key is 65 bytes (87 base64url chars).
    const key = 'BBuc8bnZZcwambnTy_CUZ4AO_Gj7zvMD28InZfFt5bvbjc4RVTf0geKjl_ti95pw6rl_EKQokrS7iDFmNVVXmcY';
    const out = urlBase64ToUint8Array(key);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x04); // uncompressed point marker
  });

  it('throws on a missing key', () => {
    expect(() => urlBase64ToUint8Array('')).toThrow();
  });
});

describe('serializeSubscription', () => {
  it('flattens a PushSubscription.toJSON() shape', () => {
    const sub = {
      toJSON: () => ({ endpoint: 'https://push/abc', keys: { p256dh: 'PK', auth: 'AK' } }),
    };
    expect(serializeSubscription(sub)).toEqual({ endpoint: 'https://push/abc', p256dh: 'PK', auth: 'AK' });
  });

  it('accepts a plain object too', () => {
    const sub = { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } };
    expect(serializeSubscription(sub)).toEqual({ endpoint: 'https://push/x', p256dh: 'p', auth: 'a' });
  });

  it('returns null for invalid/empty input', () => {
    expect(serializeSubscription(null)).toBeNull();
    expect(serializeSubscription({ endpoint: 'x' })).toBeNull(); // missing keys
    expect(serializeSubscription({ keys: { p256dh: 'p', auth: 'a' } })).toBeNull(); // missing endpoint
  });
});

describe('buildReminderPayload', () => {
  it('uses minutesUntil when available', () => {
    const p = buildReminderPayload({ clientName: 'Jane D.', shiftId: 's1', minutesUntil: 45 });
    expect(p.title).toBe('Upcoming shift');
    expect(p.body).toBe('Shift with Jane D. in 45 min.');
    expect(p.url).toBe('/care/shifts/s1');
    expect(p.tag).toBe('shift-s1');
  });

  it('says "now" at or past start', () => {
    expect(buildReminderPayload({ clientName: 'A', minutesUntil: 0 }).body).toBe('Shift with A now.');
  });

  it('falls back to a formatted time past 60 minutes', () => {
    const p = buildReminderPayload({ clientName: 'A', startTime: '2026-05-30T14:00:00Z', minutesUntil: 120 });
    expect(p.body).toMatch(/^Shift with A at .+\.$/);
  });

  it('handles a missing client name and shift id', () => {
    const p = buildReminderPayload({});
    expect(p.body).toBe('Shift with your client.');
    expect(p.url).toBe('/care');
    expect(p.tag).toBe('shift-reminder');
  });
});
