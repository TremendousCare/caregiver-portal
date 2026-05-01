// ─── ai-planner edge function entry point (Phase 0.4 dispatcher) ───
//
// Reads `app_settings.agent_runtime_cutover.ai_planner` and dispatches:
//   - false → `legacyHandler` (verbatim pre-0.4 implementation; default)
//   - true  → `runAiPlannerShell` (calls `runAgent("proactive_planner")`)
//
// Owner flips with no redeploy:
//   UPDATE app_settings
//      SET value = jsonb_set(value, '{ai_planner}', 'true'::jsonb)
//    WHERE key  = 'agent_runtime_cutover';
//
// Flag-read failure → legacy. Cleanup PR removes both this file's
// dispatch logic and `index_legacy.ts` after the post-0.4 bake.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { legacyHandler } from "./index_legacy.ts";
import { runAiPlannerShell } from "./shell.ts";
import { readCutoverFlag } from "../_shared/operations/cutoverFlag.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const useRuntime = await readCutoverFlag(supabase, "ai_planner");

  if (!useRuntime) {
    return await legacyHandler(req);
  }

  return await runAiPlannerShell(req, {
    supabase,
    apiKey: ANTHROPIC_API_KEY,
  });
});
