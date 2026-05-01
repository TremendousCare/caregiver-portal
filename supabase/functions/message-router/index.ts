// ─── message-router edge function entry point (Phase 0.4 dispatcher) ───
//
// Reads `app_settings.agent_runtime_cutover.message_router` and dispatches:
//   - false → `legacyHandler` (verbatim pre-0.4 implementation; default)
//   - true  → `runMessageRouterShell` (calls `runAgent("inbound_router")`)
//
// Owner flips with no redeploy:
//   UPDATE app_settings
//      SET value = jsonb_set(value, '{message_router}', 'true'::jsonb)
//    WHERE key  = 'agent_runtime_cutover';
//
// Flag-read failure → legacy. Cleanup PR removes both this file's
// dispatch logic and `index_legacy.ts` after the post-0.4 bake.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { legacyHandler } from "./index_legacy.ts";
import { runMessageRouterShell } from "./shell.ts";
import { readCutoverFlag } from "../_shared/operations/cutoverFlag.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const useRuntime = await readCutoverFlag(supabase, "message_router");

  if (!useRuntime) {
    return await legacyHandler(req);
  }

  return await runMessageRouterShell(req, {
    supabase,
    apiKey: ANTHROPIC_API_KEY,
  });
});
