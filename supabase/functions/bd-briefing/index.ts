// bd-briefing — Phase 1 PR #3.
//
// Returns the BD rep's briefing for the Today screen:
//   - structured stats (account count, cold count, weekly counters),
//   - alerts (cold-account list, top suggested visits),
//   - an AI-generated 2-3 sentence narrative summarising what's
//     happening in HER territory.
//
// Called once when the Today screen mounts. The front-end forwards the
// signed-in supabase JWT in the Authorization header AND the *effective*
// rep identity in the POST body:
//
//   { name, userId, createdBy[], localHour, localDateLabel }
//
//   - userId        → the effective rep (self normally, or the rep an
//                     owner is auditing while viewing-as). Used to look
//                     up that rep's territory cities via the
//                     bd_territory_cities_for_user SECURITY DEFINER RPC,
//                     which fail-closes (returns []) unless the caller is
//                     the target or an owner. Account totals / cold count
//                     / suggested visits are scoped to those cities.
//   - createdBy[]   → the strings bd_activities.created_by may hold for
//                     this rep (full_name AND email). The week counters
//                     are filtered to these so they count the rep's own
//                     work, including out-of-territory activity.
//   - localHour     → the client's local hour, so the greeting stem is
//                     correct in the rep's timezone (the edge runtime is
//                     UTC).
//   - localDateLabel→ e.g. "Sunday, May 31" — fed to the prompt so the
//                     narrative knows what day it's being read.
//
// The function uses the user-scoped supabase client so RLS still
// enforces org isolation on every read.
//
// Failure modes:
//   - Claude unreachable / over budget → return the structured payload
//     with an empty narrative. The front-end gracefully degrades.
//   - Supabase query error → 500. Front-end shows the briefing stub.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY  = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY  = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const CLAUDE_MODEL  = "claude-sonnet-4-6";
const CLAUDE_TOKENS = 400;
const CLAUDE_TEMP   = 0.3; // factual briefing — keep it close to the data.
const COLD_DAYS     = 21;
const SUGGEST_LIMIT = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface AccountRow {
  id: string;
  name: string;
  facility_subtype: string | null;
  professional_subtype: string | null;
  account_type: string | null;
  city: string | null;
  is_strategic_shared: boolean | null;
  last_activity_at: string | null;
}

interface ActivityRow {
  account_id: string;
  activity_type: string;
  occurred_at: string;
  notes: string | null;
}

interface BriefingInput {
  displayName: string;
  userId: string | null;
  createdByCandidates: string[];
  localHour: number | null;
  localDateLabel: string;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (1000 * 60 * 60 * 24));
}

// Mirror of the front-end filterToTerritory (src/features/bd-portal/lib/
// bdQueries.js): a rep sees accounts in their territory cities ∪ any
// strategic-shared account. An empty cities list means "no territory
// configured" → show everything (never silently hide the whole org).
function normalizeCity(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

function filterToTerritory(accounts: AccountRow[], cities: string[]): AccountRow[] {
  if (!cities || cities.length === 0) return accounts;
  const set = new Set(cities.map(normalizeCity));
  return accounts.filter((a) => a.is_strategic_shared === true || set.has(normalizeCity(a.city)));
}

function summarizeWeek(activities: ActivityRow[], now: number): {
  visits: number; calls: number; drop_offs: number; other: number; total: number;
} {
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let visits = 0, calls = 0, drop_offs = 0, other = 0;
  for (const a of activities) {
    const t = new Date(a.occurred_at).getTime();
    if (Number.isNaN(t) || t < weekAgo) continue;
    if (a.activity_type === "visit") visits++;
    else if (a.activity_type === "call") calls++;
    else if (a.activity_type === "drop_off") drop_offs++;
    else other++;
  }
  return { visits, calls, drop_offs, other, total: visits + calls + drop_offs + other };
}

function rankSuggested(accounts: AccountRow[], now: number): Array<AccountRow & { _days: number | null; _cold: boolean }> {
  return [...accounts]
    .map((a) => {
      const d = daysSince(a.last_activity_at, now);
      const cold = d === null || d >= COLD_DAYS;
      const score = (d === null ? 365 : d) + (cold ? 50 : 0);
      return { ...a, _days: d, _cold: cold, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, SUGGEST_LIMIT);
}

function timeOfDayGreeting(displayName: string, localHour: number | null, now: Date): string {
  const h = localHour ?? now.getHours();
  const stem = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return displayName ? `${stem}, ${displayName}` : stem;
}

async function fetchClaudeNarrative(input: {
  name: string;
  dateLabel: string;
  total_accounts: number;
  cold_count: number;
  week: ReturnType<typeof summarizeWeek>;
  topSuggestions: Array<{ name: string; days: number | null }>;
  recentNotes: string[];
}): Promise<string> {
  if (!ANTHROPIC_API_KEY) return "";

  const repName = input.name && input.name !== "there" ? input.name : "the rep";

  const systemPrompt =
    `You are the AI co-pilot for ${repName}, a home-care business development rep. ` +
    "Write a tight, useful briefing in 2-3 sentences of flowing prose. " +
    "Lead with the single most important thing for them right now. " +
    "Do not greet the user (the front-end already does) and do not use bullet points. " +
    "Be specific: cite real account names and the actual numbers from the facts. " +
    "These numbers describe THIS rep's own territory and their own activity — " +
    "never describe them as the whole company's. " +
    "Avoid generic encouragement; frame everything as a concrete next action they can take today.";

  const facts =
    `Today is ${input.dateLabel}. ` +
    `Territory: ${input.total_accounts} active accounts, ${input.cold_count} cold (>${COLD_DAYS} days no contact). ` +
    `This rep's last 7 days: ${input.week.visits} visits, ${input.week.calls} calls, ${input.week.drop_offs} drop-offs. ` +
    `Top suggested visits today: ${input.topSuggestions.map((s) =>
      `${s.name} (${s.days === null ? "never" : `${s.days}d`})`
    ).join(", ") || "none"}. ` +
    (input.recentNotes.length
      ? `This rep's recent timeline notes (verbatim): ${input.recentNotes.map((n) => `"${n}"`).join("; ")}.`
      : "");

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_TOKENS,
    temperature: CLAUDE_TEMP,
    system: systemPrompt,
    messages: [{ role: "user", content: facts }],
  };

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[bd-briefing] Claude unreachable:", e);
    return "";
  }

  if (!resp.ok) {
    const text = await resp.text();
    console.warn(`[bd-briefing] Claude ${resp.status}: ${text.slice(0, 300)}`);
    return "";
  }

  try {
    const j = await resp.json() as { content?: Array<{ type?: string; text?: string }> };
    const block = (j.content ?? []).find((b) => b.type === "text");
    return block?.text?.trim() ?? "";
  } catch {
    return "";
  }
}

// Looks up the effective rep's territory cities via the parameterized
// SECURITY DEFINER RPC. The RPC fail-closes: it returns the target's
// cities only when the caller is the target or an owner, else []. We
// treat any error or empty result as "no territory" → org-wide view.
async function fetchTerritoryCities(supabase: SupabaseClient, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const res = await supabase.rpc("bd_territory_cities_for_user", { p_user_id: userId });
  if (res.error) {
    console.warn("[bd-briefing] territory RPC failed:", res.error.message);
    return [];
  }
  return Array.isArray(res.data) ? res.data : [];
}

async function buildBriefing(supabase: SupabaseClient, input: BriefingInput): Promise<unknown> {
  const now = Date.now();

  const accountsRes = await supabase
    .from("bd_accounts")
    .select("id, name, account_type, facility_subtype, professional_subtype, city, is_strategic_shared, last_activity_at")
    .eq("is_active", true);
  if (accountsRes.error) throw new Error(`Accounts query failed: ${accountsRes.error.message}`);
  const allAccounts = (accountsRes.data ?? []) as AccountRow[];

  // Scope accounts to the effective rep's territory (∪ strategic). When
  // the rep has no territory configured this no-ops to the org-wide list.
  const cities = await fetchTerritoryCities(supabase, input.userId);
  const accounts = filterToTerritory(allAccounts, cities);

  // Activities. When we know who the rep is, count THEIR work (by
  // created_by) over the last 14 days — including out-of-territory
  // activity — which is what a personal briefing should reflect. Without
  // candidate strings we fall back to activity on the scoped accounts so
  // the briefing still degrades to something sensible.
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
  let activities: ActivityRow[] = [];
  if (input.createdByCandidates.length > 0) {
    const actRes = await supabase
      .from("bd_activities")
      .select("account_id, activity_type, occurred_at, notes")
      .in("created_by", input.createdByCandidates)
      .gte("occurred_at", fourteenDaysAgo)
      .order("occurred_at", { ascending: false })
      .limit(50);
    if (actRes.error) throw new Error(`Activities query failed: ${actRes.error.message}`);
    activities = (actRes.data ?? []) as ActivityRow[];
  } else {
    const ids = accounts.map((a) => a.id);
    if (ids.length > 0) {
      const actRes = await supabase
        .from("bd_activities")
        .select("account_id, activity_type, occurred_at, notes")
        .in("account_id", ids)
        .gte("occurred_at", fourteenDaysAgo)
        .order("occurred_at", { ascending: false })
        .limit(50);
      if (actRes.error) throw new Error(`Activities query failed: ${actRes.error.message}`);
      activities = (actRes.data ?? []) as ActivityRow[];
    }
  }

  const cold = accounts.filter((a) => {
    const d = daysSince(a.last_activity_at, now);
    return d === null || d >= COLD_DAYS;
  });

  const week = summarizeWeek(activities, now);
  const ranked = rankSuggested(accounts, now);

  const recentNotes = activities
    .filter((a) => a.notes)
    .slice(0, 3)
    .map((a) => (a.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 140));

  const topSuggestions = ranked.map((r) => ({ name: r.name, days: r._days }));

  const narrative = await fetchClaudeNarrative({
    name: input.displayName,
    dateLabel: input.localDateLabel || new Date(now).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    }),
    total_accounts: accounts.length,
    cold_count: cold.length,
    week,
    topSuggestions,
    recentNotes,
  });

  return {
    ok: true,
    greeting: timeOfDayGreeting(input.displayName, input.localHour, new Date(now)),
    narrative,
    stats: {
      total_accounts: accounts.length,
      cold_count: cold.length,
      week,
    },
    suggested_visits: ranked.map((r) => ({
      account_id: r.id,
      name: r.name,
      city: r.city,
      days_since_activity: r._days,
      cold: r._cold,
    })),
    cold_alerts: cold.slice(0, 10).map((a) => ({
      account_id: a.id,
      name: a.name,
      days_since_activity: daysSince(a.last_activity_at, now),
    })),
    generated_at: new Date(now).toISOString(),
  };
}

// Parses the effective-rep identity from the POST body, tolerating a
// missing/!JSON body and the legacy `?name=` query param so an old
// front-end keeps working (org-wide briefing, just unscoped).
async function parseInput(req: Request): Promise<BriefingInput> {
  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* no/!JSON body — fall through to defaults */ }

  let queryName = "";
  try { queryName = new URL(req.url).searchParams.get("name") ?? ""; } catch { /* ignore */ }

  const createdBy = Array.isArray(body.createdBy)
    ? (body.createdBy as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  return {
    displayName: typeof body.name === "string" && body.name ? body.name : queryName,
    userId: typeof body.userId === "string" && body.userId ? body.userId : null,
    createdByCandidates: createdBy,
    localHour: typeof body.localHour === "number" ? body.localHour : null,
    localDateLabel: typeof body.localDateLabel === "string" ? body.localDateLabel : "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer .+/.test(auth)) {
    return json(401, { error: "Bearer token required" });
  }

  // Use the user-scoped client so RLS applies. The portal already
  // org-scopes every BD table by RLS policy; we forward the JWT so the
  // territory RPC also resolves the caller's identity correctly.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });

  try {
    const input = await parseInput(req);
    const body = await buildBriefing(supabase, input);
    return json(200, body);
  } catch (e) {
    console.error("[bd-briefing] failed:", e);
    return json(500, { ok: false, error: (e as Error).message });
  }
});
