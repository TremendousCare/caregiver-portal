// bd-trello-load — Phase 1 part A.3 (load extracted Trello data into live tables).
//
// Reads extracted cards from bd_trello_import_staging (where
// extracted_payload IS NOT NULL AND processed_at IS NULL) and writes
// them into the live BD tables:
//   - bd_accounts: one row per card, keyed by (org_id, trello_card_id)
//     for idempotency. Re-runs upsert without duplicating.
//   - bd_account_contacts: one row per (account, contact_name).
//     Per-account dedup avoids piling up duplicates on re-run.
//   - bd_activities: one row per Trello commentCard action, keyed by
//     trello_action_id (UNIQUE). Activity_type heuristically inferred
//     from the comment text (visit / call / email / drop_off / note).
//
// On success, the staging row's processed_at is stamped so subsequent
// invocations skip it. Cards with extracted_payload.account_name =
// "<UNKNOWN>" are skipped and reported in the response so the owner
// can backfill them manually.
//
// Trigger:
//   curl -X POST \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     "$SUPABASE_URL/functions/v1/bd-trello-load"
//
// Response: {
//   ok, accounts_upserted, contacts_inserted, activities_inserted,
//   skipped_unknown, errors
// }
//
// See docs/BD_MODULE.md → "Trello import strategy" for context.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment ────────────────────────────────────────────────
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Activity batch size for inserts. Postgres handles single-statement
// inserts of a few hundred rows comfortably; this caps memory and
// keeps per-batch errors small.
const ACTIVITY_BATCH_SIZE = 200;
const CONTACT_BATCH_SIZE  = 200;

// ─── Auth (same pattern as bd-trello-import / bd-trello-extract) ─
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

// ─── Activity-type inference ─────────────────────────────────────
//
// Heuristic mapping from a comment's text to one of the bd_activities
// activity_type values. Trello comments are free-form prose so this
// is best-effort; the rep can re-classify in the UI later. We err on
// the side of 'note' rather than misclassifying.
const VISIT_KEYWORDS    = /\b(stopped in|stopped by|dropped in|dropped by|in person|visited|swung by|popped in|onsite|on site|met with|meeting with|saw|in service|inservice|in-service)\b/i;
const CALL_KEYWORDS     = /\b(called|phone call|spoke with on the phone|left a (voice)?(mail|message)|vm)\b/i;
const EMAIL_KEYWORDS    = /\b(emailed|sent an email|email to|reply to .* email)\b/i;
const DROP_OFF_KEYWORDS = /\b(brought|dropped off|left (a )?(card|note|brochure|treat|cake|coffee|lunch|gift|swag)|gave .* (card|cake|coffee|lunch|gift|treat|brochure))\b/i;

function inferActivityType(
  text: string,
): "visit" | "call" | "email" | "drop_off" | "note" {
  if (DROP_OFF_KEYWORDS.test(text)) return "drop_off";
  if (VISIT_KEYWORDS.test(text))    return "visit";
  if (CALL_KEYWORDS.test(text))     return "call";
  if (EMAIL_KEYWORDS.test(text))    return "email";
  return "note";
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

// ─── Types ───────────────────────────────────────────────────────
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

interface CardStaging {
  id: string;            // staging row id
  trello_id: string;     // Trello card id
  trello_board_id: string | null;
  raw_payload: { name?: string };
  extracted_payload: ExtractedPayload;
  proposed_tier: "A" | "B" | "C" | null;
}

interface ActionRow {
  id: string;            // staging row id
  trello_id: string;     // Trello action id
  raw_payload: {
    type?: string;
    date?: string;
    data?: { card?: { id?: string }; text?: string };
    memberCreator?: { fullName?: string; username?: string };
  };
}

// ─── Load workflow ──────────────────────────────────────────────

/**
 * Upsert bd_accounts from a list of extracted cards. Returns a map
 * from Trello card id → bd_accounts.id so the caller can link
 * contacts and activities. Skips cards with account_name "<UNKNOWN>".
 */
async function upsertAccounts(
  orgId: string,
  cards: CardStaging[],
): Promise<{
  cardIdToAccountId: Map<string, string>;
  upserted: number;
  skippedUnknown: string[];
}> {
  const skippedUnknown: string[] = [];
  const accountRows = cards
    .filter((c) => {
      const name = c.extracted_payload.account_name?.trim();
      if (!name || name === "<UNKNOWN>" || name.toLowerCase() === "unknown") {
        skippedUnknown.push(c.trello_id);
        return false;
      }
      return true;
    })
    .map((c) => ({
      org_id: orgId,
      trello_card_id: c.trello_id,
      name: c.extracted_payload.account_name,
      account_type: c.extracted_payload.account_type,
      facility_subtype: c.extracted_payload.facility_subtype ?? null,
      professional_subtype: c.extracted_payload.professional_subtype ?? null,
      city: c.extracted_payload.city ?? null,
      state: c.extracted_payload.state ?? "CA",
      notes: c.extracted_payload.key_notes ?? null,
      out_of_territory: c.extracted_payload.out_of_territory_guess ?? false,
      tier_override: null,                    // owner can set later
      created_by: "system:trello-import",
      updated_at: new Date().toISOString(),
    }));

  if (accountRows.length === 0) {
    return { cardIdToAccountId: new Map(), upserted: 0, skippedUnknown };
  }

  const { data, error } = await supabase
    .from("bd_accounts")
    .upsert(accountRows, { onConflict: "org_id,trello_card_id" })
    .select("id, trello_card_id");
  if (error) throw new Error(`Account upsert failed: ${error.message}`);

  const cardIdToAccountId = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; trello_card_id: string }>) {
    cardIdToAccountId.set(row.trello_card_id, row.id);
  }
  return { cardIdToAccountId, upserted: cardIdToAccountId.size, skippedUnknown };
}

/**
 * Insert contacts for every card, skipping (account, name) pairs
 * that already exist. Per-account dedup keeps re-runs safe without
 * a DB unique constraint (different Lisas at different facilities
 * are intentionally not merged).
 */
async function insertContacts(
  orgId: string,
  cards: CardStaging[],
  cardIdToAccountId: Map<string, string>,
): Promise<number> {
  // Build candidate rows from the extracted payloads.
  const candidates: Array<{
    org_id: string;
    account_id: string;
    name: string;
    role: string | null;
    mentions_count: number;
  }> = [];
  for (const card of cards) {
    const accountId = cardIdToAccountId.get(card.trello_id);
    if (!accountId) continue;
    for (const c of card.extracted_payload.contacts ?? []) {
      const name = c.name?.trim();
      if (!name) continue;
      candidates.push({
        org_id: orgId,
        account_id: accountId,
        name,
        role: c.role ?? null,
        mentions_count: c.mentions_count ?? 1,
      });
    }
  }
  if (candidates.length === 0) return 0;

  // Pull existing contacts for the affected accounts so we can dedup
  // by (account_id, lower(name)).
  const accountIds = [...new Set(candidates.map((c) => c.account_id))];
  const { data: existing, error: existingErr } = await supabase
    .from("bd_account_contacts")
    .select("account_id, name")
    .in("account_id", accountIds);
  if (existingErr) throw new Error(`Existing contacts lookup: ${existingErr.message}`);
  const existingKey = new Set<string>(
    (existing ?? []).map((r: { account_id: string; name: string }) => `${r.account_id}|${r.name.toLowerCase()}`),
  );

  // Filter out rows that already exist; also dedup the candidates
  // themselves in case the same name was extracted twice from a single
  // card (rare but harmless).
  const toInsert: Array<{
    org_id: string;
    account_id: string;
    name: string;
    title: string | null;
    role: string | null;
    notes: string | null;
    is_primary: boolean;
    created_by: string;
  }> = [];
  const seen = new Set<string>(existingKey);
  for (const c of candidates) {
    const key = `${c.account_id}|${c.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push({
      org_id: c.org_id,
      account_id: c.account_id,
      name: c.name,
      title: null,
      role: c.role,
      notes: `Imported from Trello (mentions: ${c.mentions_count})`,
      is_primary: false,
      created_by: "system:trello-import",
    });
  }
  if (toInsert.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CONTACT_BATCH_SIZE) {
    const batch = toInsert.slice(i, i + CONTACT_BATCH_SIZE);
    const { error } = await supabase.from("bd_account_contacts").insert(batch);
    if (error) throw new Error(`Contact insert (batch ${i}): ${error.message}`);
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Insert one bd_activities row per Trello commentCard action.
 * Idempotent via the UNIQUE index on trello_action_id (existing rows
 * are skipped on conflict).
 */
async function insertActivities(
  orgId: string,
  cardIdToAccountId: Map<string, string>,
  actions: ActionRow[],
): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const a of actions) {
    if (a.raw_payload?.type !== "commentCard") continue;
    const cardId = a.raw_payload?.data?.card?.id;
    const text   = a.raw_payload?.data?.text;
    const date   = a.raw_payload?.date;
    if (!cardId || !text || !date) continue;
    const accountId = cardIdToAccountId.get(cardId);
    if (!accountId) continue;          // card was unknown / skipped
    const author = a.raw_payload?.memberCreator?.fullName
                ?? a.raw_payload?.memberCreator?.username
                ?? "Trello user";
    rows.push({
      org_id: orgId,
      account_id: accountId,
      contact_id: null,                  // manual link later
      activity_type: inferActivityType(text),
      occurred_at: date,
      duration_minutes: null,
      spend_cents: 0,                    // not parsed in v1
      spend_category: null,
      notes: text,
      source: "trello_import",
      trello_action_id: a.trello_id,
      created_by: `${author} (via Trello)`,
    });
  }
  if (rows.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += ACTIVITY_BATCH_SIZE) {
    const batch = rows.slice(i, i + ACTIVITY_BATCH_SIZE);
    // ON CONFLICT DO NOTHING via ignoreDuplicates — re-runs skip
    // activities already loaded under their trello_action_id.
    const { error } = await supabase
      .from("bd_activities")
      .upsert(batch, { onConflict: "trello_action_id", ignoreDuplicates: true });
    if (error) throw new Error(`Activity insert (batch ${i}): ${error.message}`);
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Stamp processed_at on staging rows that have been successfully
 * loaded. Only marks rows whose Trello id is in `processedTrelloIds`
 * — actions for unknown/skipped cards stay unprocessed so a future
 * reload can pick them up after the owner backfills the card.
 */
async function markProcessed(
  orgId: string,
  cardStagingIds: string[],
  actionStagingIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  if (cardStagingIds.length > 0) {
    const { error } = await supabase
      .from("bd_trello_import_staging")
      .update({ processed_at: now, updated_at: now })
      .eq("org_id", orgId)
      .in("id", cardStagingIds);
    if (error) throw new Error(`Mark cards processed: ${error.message}`);
  }
  if (actionStagingIds.length > 0) {
    // Update in chunks to avoid IN-list size limits.
    const CHUNK = 500;
    for (let i = 0; i < actionStagingIds.length; i += CHUNK) {
      const chunk = actionStagingIds.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("bd_trello_import_staging")
        .update({ processed_at: now, updated_at: now })
        .eq("org_id", orgId)
        .in("id", chunk);
      if (error) throw new Error(`Mark actions processed: ${error.message}`);
    }
  }
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

  const url     = new URL(req.url);
  const orgSlug = url.searchParams.get("org_slug") ?? "tremendous-care";

  try {
    const orgId = await resolveOrgId(orgSlug);

    // 1. Pull all extracted-but-not-loaded cards.
    const { data: cardRows, error: cardsErr } = await supabase
      .from("bd_trello_import_staging")
      .select("id, trello_id, trello_board_id, raw_payload, extracted_payload, proposed_tier")
      .eq("org_id", orgId)
      .eq("kind", "card")
      .not("extracted_payload", "is", null)
      .is("processed_at", null);
    if (cardsErr) throw new Error(`Load cards: ${cardsErr.message}`);
    const cards = (cardRows ?? []) as CardStaging[];

    if (cards.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          accounts_upserted: 0,
          contacts_inserted: 0,
          activities_inserted: 0,
          skipped_unknown: [],
          note: "No extracted cards waiting to be loaded.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Pull all comment actions for the org. We filter to the loaded
    //    cards in code so a single query covers everything.
    const { data: actionRows, error: actionsErr } = await supabase
      .from("bd_trello_import_staging")
      .select("id, trello_id, raw_payload")
      .eq("org_id", orgId)
      .eq("kind", "action")
      .is("processed_at", null);
    if (actionsErr) throw new Error(`Load actions: ${actionsErr.message}`);
    const actions = (actionRows ?? []) as ActionRow[];

    // 3. Upsert accounts.
    const { cardIdToAccountId, upserted, skippedUnknown } = await upsertAccounts(orgId, cards);

    // 4. Insert contacts.
    const contactsInserted = await insertContacts(orgId, cards, cardIdToAccountId);

    // 5. Insert activities (only for cards we actually loaded).
    const relevantActions = actions.filter((a) => {
      const cardId = a.raw_payload?.data?.card?.id;
      return cardId !== undefined && cardIdToAccountId.has(cardId);
    });
    const activitiesInserted = await insertActivities(orgId, cardIdToAccountId, relevantActions);

    // 6. Stamp processed_at on the staging rows we successfully
    //    handled. Skip the unknown cards so they remain visible for
    //    manual fix-up.
    const loadedCardIds = cards
      .filter((c) => cardIdToAccountId.has(c.trello_id))
      .map((c) => c.id);
    const loadedActionStagingIds = relevantActions.map((a) => a.id);
    await markProcessed(orgId, loadedCardIds, loadedActionStagingIds);

    return new Response(
      JSON.stringify({
        ok: true,
        org_id: orgId,
        accounts_upserted: upserted,
        contacts_inserted: contactsInserted,
        activities_inserted: activitiesInserted,
        skipped_unknown: skippedUnknown,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("bd-trello-load error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
