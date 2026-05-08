// bd-trello-import — Phase 1 part A (fetch-only).
//
// Pulls a Trello board into the bd_trello_import_staging table. No AI
// extraction, no loading into live tables — that's the next PR. This
// function just stages raw payloads so we can both inspect what's
// actually on the BD board before writing extraction prompts.
//
// Reuses the existing TRELLO_API_KEY / TRELLO_TOKEN credentials from
// the trello-webhook function (Supabase secrets, already provisioned).
//
// Usage (manual trigger from a trusted environment):
//   curl -X POST \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     "$SUPABASE_URL/functions/v1/bd-trello-import?board_id=iykstkqZ&org_slug=tremendous-care"
//
// Response: { ok: true, summary: { board, lists, cards, members, actions } }
//
// Idempotent: re-running upserts by (org_id, kind, trello_id). Safe to
// repeat if Trello adds new comments or the script fails partway.
//
// Tenant isolation: writes via service-role client, but every row
// carries the resolved org_id so the rep's UI queries (Phase 1 part B)
// stay clean under RLS.
//
// See docs/BD_MODULE.md → "Trello import strategy" for the full plan.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment ────────────────────────────────────────────────
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRELLO_API_KEY            = Deno.env.get("TRELLO_API_KEY")!;
const TRELLO_TOKEN              = Deno.env.get("TRELLO_TOKEN")!;

const DEFAULT_BOARD_ID = "iykstkqZ"; // Business Development board
const DEFAULT_ORG_SLUG = "tremendous-care";

// Trello caps per-call results at 1000. We page through actions
// using ?before=<earliest_action_id> until the response is empty.
const ACTION_PAGE_SIZE = 1000;

// Action types we care about for BD context. Card creation, edits,
// comments, attachments, and member assignments. Trello has dozens of
// other action types (label changes, position moves, etc.) that are
// noise for our purposes.
const ACTION_FILTER = [
  "commentCard",
  "createCard",
  "updateCard",
  "addAttachmentToCard",
  "deleteAttachmentFromCard",
  "addMemberToCard",
  "removeMemberFromCard",
  "copyCard",
  "moveCardToBoard",
  "moveCardFromBoard",
].join(",");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Trello API client ──────────────────────────────────────────
function trelloUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set("key", TRELLO_API_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function trelloGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const resp = await fetch(trelloUrl(path, params));
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Trello GET ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// Fetch all actions on a board, paging via ?before until empty.
async function fetchAllActions(boardId: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let before: string | undefined = undefined;
  // Hard cap to prevent runaway loops if Trello returns inconsistent
  // pagination. 50 pages * 1000 actions = 50k; the BD board is well
  // under that.
  const MAX_PAGES = 50;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params: Record<string, string> = {
      limit: String(ACTION_PAGE_SIZE),
      filter: ACTION_FILTER,
    };
    if (before) params.before = before;
    const page = (await trelloGet(`/boards/${boardId}/actions`, params)) as Array<Record<string, unknown>>;
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < ACTION_PAGE_SIZE) break;
    // Trello returns actions newest-first. Continue with the id of
    // the last (oldest) action in this page.
    before = page[page.length - 1].id as string;
  }
  return all;
}

// ─── Staging upserts ────────────────────────────────────────────
type Kind = "board" | "list" | "card" | "action" | "member";

async function upsertStaging(
  orgId: string,
  kind: Kind,
  trelloId: string,
  rawPayload: unknown,
  trelloBoardId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("bd_trello_import_staging")
    .upsert(
      {
        org_id: orgId,
        kind,
        trello_id: trelloId,
        trello_board_id: trelloBoardId,
        raw_payload: rawPayload,
        // Reset extraction fields on re-fetch so the next PR's
        // extractor re-processes any updated card content.
        extracted_payload: null,
        proposed_tier: null,
        processed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,kind,trello_id" },
    );
  if (error) {
    throw new Error(`Staging upsert failed (${kind} ${trelloId}): ${error.message}`);
  }
}

// ─── Org lookup ─────────────────────────────────────────────────
async function resolveOrgId(slug: string): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .single();
  if (error || !data) {
    throw new Error(`Could not resolve org slug "${slug}": ${error?.message ?? "not found"}`);
  }
  return data.id as string;
}

// ─── Auth ───────────────────────────────────────────────────────
// Require the caller to present the service-role key as a Bearer
// token. This function is deployed with --no-verify-jwt (matching
// the trello-webhook convention) so we enforce the check ourselves.
function requireServiceRole(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  if (auth !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized — service role bearer token required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  return null;
}

// ─── Main handler ───────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authError = requireServiceRole(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const boardId = url.searchParams.get("board_id") ?? DEFAULT_BOARD_ID;
  const orgSlug = url.searchParams.get("org_slug") ?? DEFAULT_ORG_SLUG;

  try {
    const orgId = await resolveOrgId(orgSlug);

    // 1. Board metadata + lists + members + cards (with attachments).
    //    Single API call returns the full snapshot. Cards include
    //    descriptions; attachments come along when card_attachments=true.
    const board = (await trelloGet(`/boards/${boardId}`, {
      lists: "all",
      members: "all",
      cards: "all",
      card_attachments: "true",
      labels: "all",
    })) as Record<string, unknown>;

    const lists   = (board.lists   ?? []) as Array<Record<string, unknown>>;
    const members = (board.members ?? []) as Array<Record<string, unknown>>;
    const cards   = (board.cards   ?? []) as Array<Record<string, unknown>>;

    // Strip the heavy nested arrays from the board payload before
    // staging it — they're staged separately by kind.
    const boardCore = { ...board };
    delete (boardCore as Record<string, unknown>).lists;
    delete (boardCore as Record<string, unknown>).members;
    delete (boardCore as Record<string, unknown>).cards;
    await upsertStaging(orgId, "board", board.id as string, boardCore, board.id as string);

    for (const list of lists) {
      await upsertStaging(orgId, "list", list.id as string, list, board.id as string);
    }
    for (const member of members) {
      await upsertStaging(orgId, "member", member.id as string, member, board.id as string);
    }
    for (const card of cards) {
      await upsertStaging(orgId, "card", card.id as string, card, board.id as string);
    }

    // 2. All actions on the board, paged.
    const actions = await fetchAllActions(boardId);
    for (const action of actions) {
      const a = action as Record<string, unknown>;
      await upsertStaging(orgId, "action", a.id as string, a, board.id as string);
    }

    const summary = {
      board:   1,
      lists:   lists.length,
      members: members.length,
      cards:   cards.length,
      actions: actions.length,
    };

    return new Response(
      JSON.stringify({ ok: true, org_id: orgId, board_id: boardId, summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("bd-trello-import error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
