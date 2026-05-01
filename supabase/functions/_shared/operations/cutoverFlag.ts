// ─── Phase 0.4 cutover flag reader ───
//
// Reads `app_settings.agent_runtime_cutover` (jsonb) and returns whether the
// requested edge function should dispatch to the new `runAgent()` shell or
// the verbatim `index_legacy.ts` path. Designed to fail closed — any read
// error, missing row, or malformed value resolves to `false` (legacy).
//
// Flag shape (seeded by migration 20260506000000_agent_platform_phase_0_4
// _cutover_flag.sql):
//   {"ai_chat": false, "ai_planner": false, "message_router": false}
//
// Owner flips per-function via SQL, no redeploy:
//   UPDATE public.app_settings
//      SET value = jsonb_set(value, '{ai_chat}', 'true'::jsonb)
//    WHERE key  = 'agent_runtime_cutover';
//
// The shell calls `readCutoverFlag(supabase, "ai_chat")` at the top of every
// invocation. Cost: one indexed PK lookup, microseconds. Trade-off: if the
// row read fails for any reason the function falls back to legacy — that's
// the safe direction during bake.

export type CutoverShellName = "ai_chat" | "ai_planner" | "message_router";

const CUTOVER_KEY = "agent_runtime_cutover";

export async function readCutoverFlag(
  supabase: any,
  shell: CutoverShellName,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", CUTOVER_KEY)
      .maybeSingle();

    if (error || !data) return false;
    const value = data.value;
    if (!value || typeof value !== "object") return false;
    return value[shell] === true;
  } catch {
    return false;
  }
}

// Test-only export: a small util that lets shell unit tests stub the read
// without faking the supabase chain themselves. Production code must use
// `readCutoverFlag()` above.
export function __resolveCutoverValue(value: any, shell: CutoverShellName): boolean {
  if (!value || typeof value !== "object") return false;
  return value[shell] === true;
}
