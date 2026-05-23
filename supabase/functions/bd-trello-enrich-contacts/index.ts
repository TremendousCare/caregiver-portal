// bd-trello-enrich-contacts — re-parse staged Trello card descriptions
// to fill in contact title / phone / email that the original
// bd-trello-load AI extractor dropped.
//
// The original loader only extracted name + role (see bd-trello-load
// PR #274 commentary). The card descriptions on the BD board contain a
// structured contact section the AI never read:
//
//   **Name, Title | Phone | Email | LinkedIn**
//   - Ashley Kroslin, RSD | (949)854-9500 (c) | ...
//
// This function re-parses those descriptions deterministically (no
// LLM call) and:
//   1. Fills NULL fields (title, email, phone_mobile, phone_office)
//      on existing bd_account_contacts rows that came from Trello.
//      Never overwrites manually-edited values.
//   2. Inserts new contacts that appear in the description but were
//      missed by the original AI extractor — using the same per-account
//      name dedup as bd-trello-load so re-runs are safe.
//
// Trigger:
//   curl -X POST \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     "$SUPABASE_URL/functions/v1/bd-trello-enrich-contacts?org_slug=tremendous-care"
//
// Optional ?dry_run=true returns the planned changes without writing.
//
// Response: {
//   ok, accounts_processed, contacts_enriched, contacts_inserted,
//   skipped_no_match, errors
// }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  parseTrelloCardContacts,
  matchContactByName,
  buildEnrichmentPatch,
  normalizeContactName,
} from "../../../src/lib/bd/trelloContactParser.js";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
  if (token === SUPABASE_SERVICE_ROLE_KEY) return null;
  if (JWT_SHAPE.test(token)) return null;
  return new Response(
    JSON.stringify({ error: "Unauthorized — invalid token shape" }),
    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
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

interface DbContact {
  id: string;
  account_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone_mobile: string | null;
  phone_office: string | null;
}

interface ParsedContact {
  name: string;
  title: string | null;
  phone: string | null;
  phoneKind: "mobile" | "office" | null;
  email: string | null;
}

interface EnrichmentSummary {
  accounts_processed: number;
  contacts_enriched: number;
  contacts_inserted: number;
  skipped_no_changes: number;
  enriched_examples: Array<{ id: string; name: string; patch: Record<string, string> }>;
  inserted_examples: Array<{ account_id: string; name: string }>;
}

async function loadAccountsWithDescriptions(
  orgId: string,
): Promise<Array<{ id: string; trello_card_id: string; description: string }>> {
  const { data: accounts, error: accErr } = await supabase
    .from("bd_accounts")
    .select("id, trello_card_id")
    .eq("org_id", orgId)
    .not("trello_card_id", "is", null);
  if (accErr) throw new Error(`Load accounts: ${accErr.message}`);

  const rows = (accounts ?? []) as Array<{ id: string; trello_card_id: string }>;
  if (rows.length === 0) return [];

  // Fetch staging card payloads in chunks (PostgREST `.in()` accepts
  // long lists but stays well under the URL cap at this batch size).
  const CHUNK = 200;
  const cardIdToDesc = new Map<string, string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => r.trello_card_id);
    const { data: stagingRows, error: stErr } = await supabase
      .from("bd_trello_import_staging")
      .select("trello_id, raw_payload")
      .eq("org_id", orgId)
      .eq("kind", "card")
      .in("trello_id", chunk);
    if (stErr) throw new Error(`Load staging cards: ${stErr.message}`);
    for (const s of (stagingRows ?? []) as Array<{ trello_id: string; raw_payload: { desc?: string } }>) {
      const desc = s.raw_payload?.desc ?? "";
      if (desc) cardIdToDesc.set(s.trello_id, desc);
    }
  }

  return rows
    .map((r) => ({
      id: r.id,
      trello_card_id: r.trello_card_id,
      description: cardIdToDesc.get(r.trello_card_id) ?? "",
    }))
    .filter((r) => r.description.length > 0);
}

async function loadContactsForAccounts(accountIds: string[]): Promise<Map<string, DbContact[]>> {
  const map = new Map<string, DbContact[]>();
  if (accountIds.length === 0) return map;

  const CHUNK = 200;
  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("bd_account_contacts")
      .select("id, account_id, name, title, email, phone_mobile, phone_office")
      .in("account_id", chunk);
    if (error) throw new Error(`Load contacts: ${error.message}`);
    for (const row of (data ?? []) as DbContact[]) {
      const list = map.get(row.account_id) ?? [];
      list.push(row);
      map.set(row.account_id, list);
    }
  }
  return map;
}

async function enrichOneAccount(
  orgId: string,
  account: { id: string; description: string },
  existing: DbContact[],
  dryRun: boolean,
  summary: EnrichmentSummary,
): Promise<void> {
  const parsed = parseTrelloCardContacts(account.description) as ParsedContact[];
  if (parsed.length === 0) return;

  // Track which existing contacts we've already touched so a single
  // parsed contact can't update the same row twice within one card.
  const touchedExisting = new Set<string>();
  // Also track names we've inserted so dupes within a card don't fight.
  const insertedNames = new Set<string>(
    existing.map((c) => normalizeContactName(c.name)),
  );

  for (const p of parsed) {
    const match = matchContactByName(p.name, existing);

    if (match && !touchedExisting.has(match.id)) {
      const patch = buildEnrichmentPatch(match, p);
      if (patch) {
        if (!dryRun) {
          const { error } = await supabase
            .from("bd_account_contacts")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", match.id);
          if (error) throw new Error(`Enrich contact ${match.id}: ${error.message}`);
        }
        summary.contacts_enriched += 1;
        touchedExisting.add(match.id);
        if (summary.enriched_examples.length < 10) {
          summary.enriched_examples.push({
            id: match.id,
            name: match.name,
            patch: patch as Record<string, string>,
          });
        }
      } else {
        summary.skipped_no_changes += 1;
      }
      continue;
    }

    if (match) {
      // Already touched — skip duplicate parsed entry.
      continue;
    }

    // No existing contact for this name — insert it (per the
    // user-approved enrichment scope: also create missed contacts).
    const key = normalizeContactName(p.name);
    if (!key || insertedNames.has(key)) continue;
    insertedNames.add(key);

    const insertRow: Record<string, unknown> = {
      org_id: orgId,
      account_id: account.id,
      name: p.name,
      title: p.title,
      email: p.email,
      phone_mobile: null,
      phone_office: null,
      notes: "Imported from Trello card description (enrichment pass)",
      is_primary: false,
      created_by: "system:trello-enrich",
    };
    if (p.phone) {
      const target = p.phoneKind === "office" ? "phone_office" : "phone_mobile";
      insertRow[target] = p.phone;
    }

    if (!dryRun) {
      const { error } = await supabase.from("bd_account_contacts").insert(insertRow);
      if (error) throw new Error(`Insert contact for account ${account.id}: ${error.message}`);
    }
    summary.contacts_inserted += 1;
    if (summary.inserted_examples.length < 10) {
      summary.inserted_examples.push({ account_id: account.id, name: p.name });
    }
  }
}

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
  const dryRun  = url.searchParams.get("dry_run") === "true";

  try {
    const orgId = await resolveOrgId(orgSlug);
    const accounts = await loadAccountsWithDescriptions(orgId);
    const contactsByAccount = await loadContactsForAccounts(accounts.map((a) => a.id));

    const summary: EnrichmentSummary = {
      accounts_processed: 0,
      contacts_enriched: 0,
      contacts_inserted: 0,
      skipped_no_changes: 0,
      enriched_examples: [],
      inserted_examples: [],
    };

    for (const acc of accounts) {
      const existing = contactsByAccount.get(acc.id) ?? [];
      await enrichOneAccount(orgId, acc, existing, dryRun, summary);
      summary.accounts_processed += 1;
    }

    return new Response(
      JSON.stringify({ ok: true, org_id: orgId, dry_run: dryRun, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("bd-trello-enrich-contacts error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
