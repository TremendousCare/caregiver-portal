import { createClient } from '@supabase/supabase-js';

// ─── Supabase Configuration ─────────────────────────────────
// These values come from your Supabase project dashboard.
// In production, use environment variables (VITE_ prefix for Vite).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Only create the client if credentials are configured
export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

// Helper to check if Supabase is connected
export const isSupabaseConfigured = () => !!supabase;

// ─── JWT claim helpers (Phase A — SaaS retrofit) ──────────────
// Parses org_id / org_slug / org_role from a Supabase session's
// access token. Returns an object with null fields on any failure —
// callers must treat missing claims as "not in an org yet" rather
// than erroring. Scaffolding only in Phase A; no other code reads
// these claims until Phase B.
export function getOrgClaims(session) {
  const empty = { orgId: null, orgSlug: null, orgRole: null };
  const token = session?.access_token;
  if (!token || typeof token !== 'string') return empty;

  const parts = token.split('.');
  if (parts.length !== 3) return empty;

  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf-8');
    const payload = JSON.parse(json);
    return {
      orgId:   payload.org_id   ?? null,
      orgSlug: payload.org_slug ?? null,
      orgRole: payload.org_role ?? null,
    };
  } catch {
    return empty;
  }
}
