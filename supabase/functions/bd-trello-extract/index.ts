// bd-trello-extract — Phase 1 part A.2 (card extraction).
//
// Reads card rows from bd_trello_import_staging that haven't been
// extracted yet, sends each to Claude Haiku 4.5 with a structured-
// output tool definition, and writes the extracted account/contact
// proposals back to staging.extracted_payload + staging.proposed_tier.
//
// No writes to live tables. The CSV review (next PR) and the loader
// (PR after that) gate the live-table writes on owner approval.
//
// Trigger:
//   curl -X POST \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     "$SUPABASE_URL/functions/v1/bd-trello-extract"
//
// Response: { ok, processed, skipped, errors: [...] }
//
// Idempotent: only processes rows where extracted_payload IS NULL.
// Re-running picks up new cards added by a later bd-trello-import
// fetch. To force re-extraction on a row, clear extracted_payload
// via SQL before invoking.
//
// Cost: ~$0.10–$0.15 in Haiku tokens for 100 cards. Negligible.
//
// See docs/BD_MODULE.md → "Trello import strategy" for context.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment ────────────────────────────────────────────────
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY         = Deno.env.get("ANTHROPIC_API_KEY")!;

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Concurrency limit — process N cards in parallel. Anthropic's
// per-account RPM is comfortably above 10 for tier-1 accounts.
const PARALLELISM = 10;

// Recent comments included in the prompt per card. More = better
// extraction quality, more = more tokens. 5 is a reasonable
// balance for cards with 30–50 actions.
const COMMENTS_PER_CARD = 5;

// Recency window (days) within which a Leads/Follow Up card with
// dense comment activity gets promoted to Tier A.
const TIER_A_RECENCY_DAYS = 90;
const TIER_A_MIN_ACTIONS  = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Auth (same pattern as bd-trello-import) ─────────────────────
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function requireAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) {
    return new Response(
      JSON.stringify({ error: "Unauthorized — Bearer token required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const token = match[1];
  const isServiceRole = token === SUPABASE_SERVICE_ROLE_KEY;
  const looksLikeJwt  = JWT_SHAPE.test(token);
  if (!isServiceRole && !looksLikeJwt) {
    return new Response(
      JSON.stringify({ error: "Unauthorized — invalid token shape" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  return null;
}

// ─── Anthropic API ──────────────────────────────────────────────
//
// Uses tool-use to force clean structured JSON output. The tool
// schema is the contract: Haiku must return arguments matching it
// exactly, which removes the "model returned malformed JSON" class
// of failure entirely.
const EXTRACT_TOOL = {
  name: "extract_account",
  description: "Extract structured account and contact data from a Trello card representing a home-care referral source.",
  input_schema: {
    type: "object",
    properties: {
      account_name: {
        type: "string",
        description: "Canonical name of the facility or professional. For pipe-delimited titles like 'Saddleback/Memorial Care | Laguna Hills | Hospital', take the first segment ('Saddleback/Memorial Care').",
      },
      account_type: {
        type: "string",
        enum: ["facility", "professional"],
        description: "facility = hospital, SNF, ALF, IL, memory care, rehab, hospice, home health agency. professional = individual MD, attorney, GCM, financial planner, social worker.",
      },
      facility_subtype: {
        type: ["string", "null"],
        enum: ["hospital", "snf", "alf", "independent_living", "memory_care", "rehab", "hospice", "home_health", "other", null],
        description: "Required when account_type=facility, null when professional. SNF = skilled nursing facility. ALF = assisted living facility.",
      },
      professional_subtype: {
        type: ["string", "null"],
        enum: ["gcm", "attorney", "financial_planner", "physician", "social_worker", "other", null],
        description: "Required when account_type=professional, null when facility. GCM = geriatric care manager.",
      },
      city: {
        type: ["string", "null"],
        description: "City. Pipe-delimited titles have it as the second segment. Common abbreviations: MV=Mission Viejo, RMV=Rancho Mission Viejo, AV=Aliso Viejo, NB=Newport Beach. Null only if completely unguessable.",
      },
      state: {
        type: "string",
        description: "Two-letter state code. Default 'CA' for Orange County.",
      },
      contacts: {
        type: "array",
        description: "People mentioned by first name or full name in description or comments. De-duplicate (same person, different mentions = one entry). Skip generic references ('the team', 'they').",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Best-guess full name or first name as it appears." },
            role: {
              type: ["string", "null"],
              enum: ["discharge_planner", "case_manager", "social_worker", "admissions", "ed_director", "administrator", "principal", "physician", "gcm", "attorney", "financial_planner", "office_manager", "other", null],
              description: "Inferred role. null if unclear.",
            },
            mentions_count: { type: "integer", description: "Approximate number of times this person appears across the card." },
          },
          required: ["name", "mentions_count"],
        },
      },
      key_notes: {
        type: "string",
        description: "1-2 sentence summary of the relationship status and most recent activity. Include any in-flight commitments or pending actions.",
      },
      spend_signals: {
        type: "integer",
        description: "Approximate count of gift/meal/drop-off mentions in the visible content (coffee, lunch, cake, gift card, hand-written note, etc.). Used as a rough Anti-Kickback compliance signal.",
      },
      out_of_territory_guess: {
        type: "boolean",
        description: "True if the city appears to be South Orange County (Laguna Hills, Aliso Viejo, Newport Beach, Irvine, Mission Viejo, Costa Mesa, San Juan Capistrano, etc.). False if North OC (Anaheim, Fullerton, Brea, Buena Park, etc.) or unknown.",
      },
    },
    required: ["account_name", "account_type", "state", "contacts", "key_notes", "spend_signals", "out_of_territory_guess"],
  },
};

interface ExtractedPayload {
  account_name: string;
  account_type: "facility" | "professional";
  facility_subtype?: string | null;
  professional_subtype?: string | null;
  city?: string | null;
  state: string;
  contacts: Array<{ name: string; role?: string | null; mentions_count: number }>;
  key_notes: string;
  spend_signals: number;
  out_of_territory_guess: boolean;
}

async function extractCard(
  listName: string,
  title: string,
  description: string,
  recentComments: Array<{ date: string; text: string }>,
): Promise<ExtractedPayload> {
  const userContent = [
    `List (pipeline stage): ${listName}`,
    `Card title: ${title}`,
    `Description:`,
    description.trim() || "(none)",
    "",
    `Recent comments (newest first):`,
    ...recentComments.map((c) => `[${c.date}] ${c.text}`),
  ].join("\n");

  const body = {
    model: HAIKU_MODEL,
    max_tokens: 1500,
    system: [
      {
        type: "text",
        text:
          "You extract structured account and contact data from Trello cards used by a home-care business development representative. Each card represents a referral source — either a healthcare facility or an individual professional. Be conservative on inferences: if you genuinely cannot tell, prefer null over guessing. Always call the extract_account tool to return your answer; never reply in plain text.",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_account" },
    messages: [{ role: "user", content: userContent }],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json() as { content: Array<{ type: string; name?: string; input?: ExtractedPayload }> };
  const toolUse = json.content.find((b) => b.type === "tool_use" && b.name === "extract_account");
  if (!toolUse || !toolUse.input) {
    throw new Error(`No tool_use block in Haiku response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return toolUse.input;
}

// ─── Tier stratification ────────────────────────────────────────
//
// First-pass tier from the Trello list name. Second pass promotes
// the warmest Leads/Follow Up cards into A based on recency and
// comment density (signal-rich relationships even though they're
// not yet "Trial Client").
function tierFromListName(listName: string): "A" | "B" | "C" {
  switch (listName.toLowerCase()) {
    case "active referral partner":
    case "trial client":
    case "meeting set":
      return "A";
    case "leads":
    case "follow up":
      return "B";
    case "wash or loss":
      return "C";
    default:
      return "B";
  }
}

function isWarmEnoughForA(
  listName: string,
  lastActivityAt: string | null,
  actionCount: number,
): boolean {
  const ln = listName.toLowerCase();
  if (ln !== "leads" && ln !== "follow up") return false;
  if (actionCount < TIER_A_MIN_ACTIONS) return false;
  if (!lastActivityAt) return false;
  const daysSince = (Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000;
  return daysSince <= TIER_A_RECENCY_DAYS;
}

// ─── Main extraction loop ───────────────────────────────────────
interface CardRow {
  id: string;
  trello_id: string;
  raw_payload: {
    name?: string;
    desc?: string;
    idList?: string;
    dateLastActivity?: string;
  };
}

interface ListRow {
  trello_id: string;
  raw_payload: { name?: string };
}

interface ActionRow {
  raw_payload: {
    type?: string;
    date?: string;
    data?: { card?: { id?: string }; text?: string };
  };
}

async function loadInputs(orgId: string) {
  // Cards needing extraction
  const { data: cards, error: cardsErr } = await supabase
    .from("bd_trello_import_staging")
    .select("id, trello_id, raw_payload")
    .eq("org_id", orgId)
    .eq("kind", "card")
    .is("extracted_payload", null);
  if (cardsErr) throw new Error(`Load cards: ${cardsErr.message}`);

  const { data: lists, error: listsErr } = await supabase
    .from("bd_trello_import_staging")
    .select("trello_id, raw_payload")
    .eq("org_id", orgId)
    .eq("kind", "list");
  if (listsErr) throw new Error(`Load lists: ${listsErr.message}`);

  const { data: actions, error: actionsErr } = await supabase
    .from("bd_trello_import_staging")
    .select("raw_payload")
    .eq("org_id", orgId)
    .eq("kind", "action");
  if (actionsErr) throw new Error(`Load actions: ${actionsErr.message}`);

  return {
    cards:   (cards   ?? []) as CardRow[],
    lists:   (lists   ?? []) as ListRow[],
    actions: (actions ?? []) as ActionRow[],
  };
}

function buildActionIndex(actions: ActionRow[]): Map<string, Array<{ date: string; text: string }>> {
  const index = new Map<string, Array<{ date: string; text: string }>>();
  for (const a of actions) {
    if (a.raw_payload?.type !== "commentCard") continue;
    const cardId = a.raw_payload?.data?.card?.id;
    const text   = a.raw_payload?.data?.text;
    const date   = a.raw_payload?.date;
    if (!cardId || !text || !date) continue;
    if (!index.has(cardId)) index.set(cardId, []);
    index.get(cardId)!.push({ date, text });
  }
  // Sort each card's comments newest-first so we can take the top N.
  for (const arr of index.values()) {
    arr.sort((a, b) => b.date.localeCompare(a.date));
  }
  return index;
}

async function processBatch(
  cards: CardRow[],
  listById: Map<string, string>,
  actionIndex: Map<string, Array<{ date: string; text: string }>>,
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  return Promise.all(cards.map(async (card) => {
    try {
      const listName = listById.get(card.raw_payload?.idList ?? "") ?? "Unknown";
      const title    = card.raw_payload?.name ?? "";
      const desc     = card.raw_payload?.desc ?? "";
      const allComments = actionIndex.get(card.trello_id) ?? [];
      const recent = allComments.slice(0, COMMENTS_PER_CARD);

      const extracted = await extractCard(listName, title, desc, recent);

      // Tier: list-mapping first, then promote warm Leads/Follow Up
      // into A if they cross the recency + density threshold.
      let tier = tierFromListName(listName);
      if (tier === "B") {
        if (isWarmEnoughForA(listName, card.raw_payload?.dateLastActivity ?? null, allComments.length)) {
          tier = "A";
        }
      }

      const { error } = await supabase
        .from("bd_trello_import_staging")
        .update({
          extracted_payload: extracted,
          proposed_tier: tier,
          updated_at: new Date().toISOString(),
        })
        .eq("id", card.id);
      if (error) throw new Error(error.message);

      return { id: card.id, ok: true };
    } catch (err) {
      return { id: card.id, ok: false, error: (err as Error).message };
    }
  }));
}

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

  const authError = requireAuth(req);
  if (authError) return authError;

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const url     = new URL(req.url);
  const orgSlug = url.searchParams.get("org_slug") ?? "tremendous-care";

  try {
    const orgId = await resolveOrgId(orgSlug);
    const { cards, lists, actions } = await loadInputs(orgId);

    if (cards.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0, skipped: 0, errors: [], note: "No unprocessed cards." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const listById = new Map<string, string>(
      lists.map((l) => [l.trello_id, l.raw_payload?.name ?? "Unknown"]),
    );
    const actionIndex = buildActionIndex(actions);

    // Process in chunks of PARALLELISM. Each chunk waits for all
    // cards in it to settle before starting the next chunk — keeps
    // total in-flight Anthropic calls bounded.
    let processed = 0;
    const errors: Array<{ id: string; error: string }> = [];
    for (let i = 0; i < cards.length; i += PARALLELISM) {
      const batch = cards.slice(i, i + PARALLELISM);
      const results = await processBatch(batch, listById, actionIndex);
      for (const r of results) {
        if (r.ok) processed++;
        else errors.push({ id: r.id, error: r.error ?? "unknown" });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        org_id: orgId,
        processed,
        skipped: cards.length - processed - errors.length,
        errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("bd-trello-extract error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
