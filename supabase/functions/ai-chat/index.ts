// ─── ai-chat edge function entry point (Phase 0.4 dispatcher) ───
//
// Reads the `app_settings.agent_runtime_cutover.ai_chat` flag at the top
// of every invocation and dispatches to either:
//
//   - `legacyHandler`  (verbatim pre-0.4 implementation; default)
//   - `runAiChatShell` (Phase 0.4 shell that calls `runAgent("recruiting")`)
//
// Owner flips the flag without redeploy:
//   UPDATE app_settings
//      SET value = jsonb_set(value, '{ai_chat}', 'true'::jsonb)
//    WHERE key  = 'agent_runtime_cutover';
//
// On any flag-read error this falls back to legacy — safety over visibility.
// After the post-0.4 ≥ 7-day bake completes clean, the cleanup PR removes
// `index_legacy.ts` + the dispatcher logic and inlines `runAiChatShell`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  getCorsHeaders,
} from "./config.ts";

// Tool side-effect imports. The legacy file performs these too, so during
// the bake they're already triggered transitively via `index_legacy.ts`.
// Listed explicitly here so the post-bake cleanup PR can drop the legacy
// file without losing tool registrations on the runtime path.
import "./tools/caregiver-read.ts";
import "./tools/caregiver-write.ts";
import "./tools/communication.ts";
import "./tools/email.ts";
import "./tools/calendar.ts";
import "./tools/docusign.ts";
import "./tools/esign.ts";
import "./tools/client.ts";
import "./tools/awareness.ts";

import { legacyHandler } from "./index_legacy.ts";
import { runAiChatShell } from "./shell.ts";
import { readCutoverFlag } from "../_shared/operations/cutoverFlag.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = getCorsHeaders(req);

  // Only the chat path is gated by the flag — OPTIONS preflight always
  // succeeds, regardless of which path runs.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  // The flag read needs a service-role client. We construct one here
  // (cheap; reused below only on the cutover path so the legacy file's
  // own client construction is untouched).
  const flagSupabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
  const useRuntime = await readCutoverFlag(flagSupabase, "ai_chat");

  if (!useRuntime) {
    return await legacyHandler(req);
  }

  // Cutover path. The shell receives both clients — service-role for data
  // operations, anon-keyed user client for JWT verification (matches the
  // legacy file's split exactly).
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const supabaseAuth = createClient(
    SUPABASE_URL!,
    SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY!,
    { global: { headers: { Authorization: token ? `Bearer ${token}` : "" } } },
  );

  return await runAiChatShell(req, {
    supabase: flagSupabase,
    supabaseAuth,
    apiKey: ANTHROPIC_API_KEY,
    corsHeaders: cors,
  });
});
