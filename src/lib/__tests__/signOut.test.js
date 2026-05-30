import { describe, it, expect, vi } from 'vitest';
import { signOutAndReload } from '../signOut';

describe('signOutAndReload', () => {
  it('signs out with local scope and then reloads', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const reload = vi.fn();
    await signOutAndReload({ client: { auth: { signOut } }, reload });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads even if signOut rejects', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('boom'));
    const reload = vi.fn();
    await signOutAndReload({ client: { auth: { signOut } }, reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads even if signOut hangs (timeout wins)', async () => {
    // signOut never resolves; the timeout must still trigger the reload.
    const signOut = vi.fn(() => new Promise(() => {}));
    const reload = vi.fn();
    await signOutAndReload({ client: { auth: { signOut } }, reload, timeoutMs: 5 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads even when there is no client/auth', async () => {
    const reload = vi.fn();
    await signOutAndReload({ client: null, reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
