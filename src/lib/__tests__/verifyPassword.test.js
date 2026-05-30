import { describe, it, expect, vi } from 'vitest';
import { verifyCurrentPassword } from '../verifyPassword';

function fakeClientFactory(signInResult, { signInImpl } = {}) {
  const signOut = vi.fn().mockResolvedValue({});
  const signInWithPassword = signInImpl || vi.fn().mockResolvedValue(signInResult);
  const createClientImpl = vi.fn(() => ({ auth: { signInWithPassword, signOut } }));
  return { createClientImpl, signOut, signInWithPassword };
}

const opts = (extra) => ({ url: 'https://x.supabase.co', anonKey: 'anon', ...extra });

describe('verifyCurrentPassword', () => {
  it('returns true when the throwaway sign-in succeeds', async () => {
    const { createClientImpl, signOut } = fakeClientFactory({ error: null });
    const ok = await verifyCurrentPassword('a@b.com', 'rightpassword', opts({ createClientImpl }));
    expect(ok).toBe(true);
    // cleans up the throwaway session
    expect(signOut).toHaveBeenCalled();
  });

  it('returns false on a wrong password (auth error)', async () => {
    const { createClientImpl } = fakeClientFactory({ error: { message: 'Invalid login credentials' } });
    const ok = await verifyCurrentPassword('a@b.com', 'wrong', opts({ createClientImpl }));
    expect(ok).toBe(false);
  });

  it('returns false for empty inputs without creating a client', async () => {
    const { createClientImpl } = fakeClientFactory({ error: null });
    expect(await verifyCurrentPassword('', 'x', opts({ createClientImpl }))).toBe(false);
    expect(await verifyCurrentPassword('a@b.com', '', opts({ createClientImpl }))).toBe(false);
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  it('uses an isolated client that does not persist a session', async () => {
    const { createClientImpl } = fakeClientFactory({ error: null });
    await verifyCurrentPassword('a@b.com', 'pw', opts({ createClientImpl }));
    const cfg = createClientImpl.mock.calls[0][2];
    expect(cfg.auth.persistSession).toBe(false);
    expect(cfg.auth.autoRefreshToken).toBe(false);
  });

  it('rejects (does not hang) when sign-in stalls past the timeout', async () => {
    const signInImpl = vi.fn(() => new Promise(() => {})); // never resolves
    const { createClientImpl } = fakeClientFactory(null, { signInImpl });
    await expect(
      verifyCurrentPassword('a@b.com', 'pw', opts({ createClientImpl, timeoutMs: 5 })),
    ).rejects.toThrow(/timed out/i);
  });

  it('throws a clear error when not configured', async () => {
    await expect(
      verifyCurrentPassword('a@b.com', 'pw', { url: '', anonKey: '' }),
    ).rejects.toThrow(/not configured/i);
  });
});
