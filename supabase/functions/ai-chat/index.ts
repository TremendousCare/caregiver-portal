// ─── ai-chat edge function ───
//
// Deno entry point. Tool side-effect imports populate the registry on cold
// start; all testable logic lives in `./shell.ts` so unit tests can import
// it without dragging in `jsr:` URLs or `Deno.serve`.
//
// Phase 0.4 closeout: the cutover flag and `index_legacy.ts` rollback
// sibling have been removed after 7 days of clean stamping.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  getCorsHeaders,
} from "./config.ts";

// Tool side-effect imports. These populate the registry that the shell
// reads from before the chat loop starts. Must be loaded before the first
// runAiChatShell call.
import "./tools/caregiver-read.ts";
import "./tools/caregiver-write.ts";
import "./tools/communication.ts";
import "./tools/email.ts";
import "./tools/calendar.ts";
import "./tools/docusign.ts";
import "./tools/esign.ts";
import "./tools/client.ts";
import "./tools/awareness.ts";

import { runAiChatShell } from "./shell.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

  // The user-context client is built from the request's Bearer token so
  // supabaseAuth.auth.getUser() can verify the JWT against the `auth.users`
  // table. Anon key is the public-side identity for that verify call.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const supabaseAuth = createClient(
    SUPABASE_URL!,
    SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY!,
    { global: { headers: { Authorization: token ? `Bearer ${token}` : "" } } },
  );

  return await runAiChatShell(req, {
    supabase,
    supabaseAuth,
    apiKey: ANTHROPIC_API_KEY,
    corsHeaders: cors,
  });
});
