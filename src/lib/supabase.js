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
