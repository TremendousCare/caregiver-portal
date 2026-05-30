// ─── signOutAndReload ───
// Signs the caregiver out and reloads to the login screen. The reload is
// guaranteed: we bound supabase.auth.signOut() with a timeout so a slow
// (or briefly wedged) auth call can never leave the button doing nothing.
// Worst case we drop the local session and reload anyway — the next load
// reads no session and shows the login screen.

import { supabase } from './supabase';

const SIGN_OUT_TIMEOUT_MS = 4_000;

export async function signOutAndReload({
  client = supabase,
  reload = () => window.location.reload(),
  timeoutMs = SIGN_OUT_TIMEOUT_MS,
} = {}) {
  try {
    // 'local' scope clears this device's session without a network call to
    // revoke other sessions — fast and reliable on a flaky connection.
    const signOut = client?.auth?.signOut?.({ scope: 'local' })
      ?? Promise.resolve();
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([signOut, timeout]);
  } catch (e) {
    console.error('Sign out failed (reloading anyway):', e);
  } finally {
    reload();
  }
}
