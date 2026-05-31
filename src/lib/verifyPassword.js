// ─── verifyCurrentPassword ───
// Confirms a caregiver's current password WITHOUT disturbing their live
// session. We spin up a throwaway Supabase client configured to neither
// persist nor auto-refresh a session, sign in with it, then discard it.
//
// Why not supabase.auth.signInWithPassword on the main client: that emits
// a SIGNED_IN auth-state change on the live session and churns the GoTrue
// lock — on the caregiver PWA that can wedge the very updateUser() call we
// make next. An isolated client sidesteps all of that.

import { createClient } from '@supabase/supabase-js';

// Bounded so a network stall surfaces as a normal error instead of an
// indefinite "Saving…".
const VERIFY_TIMEOUT_MS = 15_000;

export async function verifyCurrentPassword(
  email,
  password,
  {
    url = import.meta.env.VITE_SUPABASE_URL,
    anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY,
    createClientImpl = createClient,
    timeoutMs = VERIFY_TIMEOUT_MS,
  } = {},
) {
  if (!email || !password) return false;
  if (!url || !anonKey) throw new Error('Sign-in is not configured on this device.');

  const probe = createClientImpl(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const signIn = probe.auth.signInWithPassword({ email, password });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Verification timed out. Check your connection and try again.')), timeoutMs),
  );

  try {
    const { error } = await Promise.race([signIn, timeout]);
    if (error) return false;
    return true;
  } finally {
    // Best-effort cleanup of the throwaway server session. Fire-and-forget
    // — NEVER await it: probe.auth.signOut() acquires the GoTrue lock and
    // calls /logout, which can stall on a flaky connection. Awaiting it
    // here would block verifyCurrentPassword from returning even after the
    // sign-in race resolved, hanging handleSubmit on "Saving…" before it
    // ever reaches updateUser(). The probe uses persistSession:false, so
    // there's no local session to clean up anyway.
    try {
      probe.auth.signOut().catch(() => {});
    } catch (_) { /* ignore */ }
  }
}
