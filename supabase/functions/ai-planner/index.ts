// ─── ai-planner edge function ───
//
// Deno entry point. All testable logic lives in `./shell.ts` so unit tests
// can import it without dragging in `jsr:` URLs or `Deno.serve`.
//
// Phase 0.4 closeout: the cutover flag and `index_legacy.ts` rollback
// sibling have been removed after 7 days of clean stamping.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { runAiPlannerShell } from "./shell.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

Deno.serve(async (req: Request): Promise<Response> => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return await runAiPlannerShell(req, {
    supabase,
    apiKey: ANTHROPIC_API_KEY,
  });
});
