import { describe, it, expect } from 'vitest';
import {
  VIEW_AS_READONLY_MESSAGE,
  VIEW_AS_STORAGE_KEY,
  ViewAsReadOnlyError,
  sanitizeViewAsUserId,
  deriveEffectiveUserId,
  isViewingAs,
  findRep,
  repDisplayName,
} from '../../features/bd-portal/lib/bdViewAs';

const SELF = '00000000-0000-0000-0000-000000000001';
const AMY  = '9228e867-30ca-4294-985b-871a994cc5fc';
const BOB  = '00000000-0000-0000-0000-000000000002';

const REPS = [
  { user_id: AMY, email: 'amy.dutton@tremendouscareca.com', full_name: 'Amy Dutton' },
  { user_id: BOB, email: 'bob@example.com', full_name: '' },
];

describe('VIEW_AS constants', () => {
  it('exposes a stable sessionStorage key', () => {
    expect(VIEW_AS_STORAGE_KEY).toBe('bd:viewAsUserId');
  });
});

describe('ViewAsReadOnlyError', () => {
  it('is an Error carrying the read-only flag and default message', () => {
    const e = new ViewAsReadOnlyError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ViewAsReadOnlyError');
    expect(e.readOnly).toBe(true);
    expect(e.message).toBe(VIEW_AS_READONLY_MESSAGE);
  });
  it('accepts a custom message', () => {
    expect(new ViewAsReadOnlyError('nope').message).toBe('nope');
  });
});

describe('sanitizeViewAsUserId', () => {
  it('returns the id when it matches a real rep', () => {
    expect(sanitizeViewAsUserId(AMY, REPS)).toBe(AMY);
  });
  it('drops a stale / unknown id', () => {
    expect(sanitizeViewAsUserId('not-a-rep', REPS)).toBe(null);
  });
  it('returns null for empty input or empty rep list', () => {
    expect(sanitizeViewAsUserId(null, REPS)).toBe(null);
    expect(sanitizeViewAsUserId(AMY, [])).toBe(null);
    expect(sanitizeViewAsUserId(AMY, undefined)).toBe(null);
  });
});

describe('deriveEffectiveUserId', () => {
  it('returns the audited rep when a valid view-as is active', () => {
    expect(deriveEffectiveUserId({ selfUserId: SELF, viewAsUserId: AMY, reps: REPS })).toBe(AMY);
  });
  it('falls back to self when no view-as is set', () => {
    expect(deriveEffectiveUserId({ selfUserId: SELF, viewAsUserId: null, reps: REPS })).toBe(SELF);
  });
  it('falls back to self when the view-as id is stale', () => {
    expect(deriveEffectiveUserId({ selfUserId: SELF, viewAsUserId: 'ghost', reps: REPS })).toBe(SELF);
  });
  it('returns null before the session resolves (no self yet)', () => {
    expect(deriveEffectiveUserId({ selfUserId: null, viewAsUserId: null, reps: [] })).toBe(null);
  });
});

describe('isViewingAs', () => {
  it('is true only when mirroring a different, valid rep', () => {
    expect(isViewingAs({ selfUserId: SELF, viewAsUserId: AMY, reps: REPS })).toBe(true);
  });
  it('is false when no selection is active', () => {
    expect(isViewingAs({ selfUserId: SELF, viewAsUserId: null, reps: REPS })).toBe(false);
  });
  it('is false when the selection resolves to yourself', () => {
    const repsWithSelf = [...REPS, { user_id: SELF, email: 'me@x.com', full_name: 'Me' }];
    expect(isViewingAs({ selfUserId: SELF, viewAsUserId: SELF, reps: repsWithSelf })).toBe(false);
  });
  it('is false when the selection is stale', () => {
    expect(isViewingAs({ selfUserId: SELF, viewAsUserId: 'ghost', reps: REPS })).toBe(false);
  });
});

describe('findRep', () => {
  it('finds a rep by id', () => {
    expect(findRep(REPS, AMY)?.email).toBe('amy.dutton@tremendouscareca.com');
  });
  it('returns null for unknown id or empty input', () => {
    expect(findRep(REPS, 'ghost')).toBe(null);
    expect(findRep(REPS, null)).toBe(null);
    expect(findRep(undefined, AMY)).toBe(null);
  });
});

describe('repDisplayName', () => {
  it('prefers the full name', () => {
    expect(repDisplayName(REPS[0])).toBe('Amy Dutton');
  });
  it('falls back to the email local-part when no name', () => {
    expect(repDisplayName(REPS[1])).toBe('bob');
  });
  it('falls back to a generic label for empty input', () => {
    expect(repDisplayName(null)).toBe('rep');
    expect(repDisplayName({})).toBe('rep');
  });
});
