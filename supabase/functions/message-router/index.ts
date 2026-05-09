// ─── message-router edge function ───
//
// Deno entry point. All testable logic lives in `./shell.ts` so unit tests
// can import it without dragging in `https://esm.sh/...` URLs or `Deno.serve`.
//
// Phase 0.4 closeout: the cutover flag and `index_legacy.ts` rollback
// sibling have been removed after 7 days of clean stamping.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { runMessageRouterShell } from "./shell.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

Deno.serve(async (req: Request): Promise<Response> => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return await runMessageRouterShell(req, {
    supabase,
    apiKey: ANTHROPIC_API_KEY,
  });
});
