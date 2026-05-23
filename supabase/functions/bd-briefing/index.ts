// bd-briefing — Phase 1 PR #3.
//
// Returns the BD rep's morning briefing for the Today screen:
//   - structured stats (account count, cold count, weekly counters),
//   - alerts (cold-account list, top suggested visits),
//   - an AI-generated 2-3 sentence narrative summarising what's
//     happening in her territory.
//
// Called once when the Today screen mounts. Owner reuses her existing
// portal session — the front-end forwards her supabase JWT in the
// Authorization header. The function uses the user-scoped supabase
// client so RLS still enforces org isolation.
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
  last_activity_at: string | null;
}

interface ActivityRow {
  account_id: string;
  activity_type: string;
  occurred_at: string;
  notes: string | null;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (1000 * 60 * 60 * 24));
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

function timeOfDayGreeting(displayName: string, now: Date): string {
  const h = now.getHours();
  const stem = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return displayName ? `${stem}, ${displayName}` : stem;
}

async function fetchClaudeNarrative(input: {
  total_accounts: number;
  cold_count: number;
  week: ReturnType<typeof summarizeWeek>;
  topSuggestions: Array<{ name: string; days: number | null }>;
  recentNotes: string[];
}): Promise<string> {
  if (!ANTHROPIC_API_KEY) return "";

  const systemPrompt =
    "You are the AI co-pilot for a home-care business development rep. " +
    "Write a tight, useful morning briefing in 2-3 sentences. Be specific, " +
    "warm, and actionable. Do not greet the user (the front-end already does). " +
    "Do not list bullet points — write flowing prose. " +
    "Reference specific account names when relevant. " +
    "Avoid generic encouragement; focus on what the rep should know right now.";

  const facts =
    `Territory: ${input.total_accounts} active accounts, ${input.cold_count} cold (>21 days no contact). ` +
    `Last 7 days: ${input.week.visits} visits, ${input.week.calls} calls, ${input.week.drop_offs} drop-offs. ` +
    `Top suggested visits today: ${input.topSuggestions.map((s) =>
      `${s.name} (${s.days === null ? "never" : `${s.days}d`})`
    ).join(", ") || "none"}. ` +
    (input.recentNotes.length
      ? `Recent timeline notes (verbatim): ${input.recentNotes.map((n) => `"${n}"`).join("; ")}.`
      : "");

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_TOKENS,
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

async function buildBriefing(supabase: SupabaseClient, displayName: string): Promise<unknown> {
  const now = Date.now();

  const accountsRes = await supabase
    .from("bd_accounts")
    .select("id, name, account_type, facility_subtype, professional_subtype, city, last_activity_at")
    .eq("is_active", true);
  if (accountsRes.error) throw new Error(`Accounts query failed: ${accountsRes.error.message}`);
  const accounts = (accountsRes.data ?? []) as AccountRow[];

  const ids = accounts.map((a) => a.id);
  let activities: ActivityRow[] = [];
  if (ids.length > 0) {
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
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
    total_accounts: accounts.length,
    cold_count: cold.length,
    week,
    topSuggestions,
    recentNotes,
  });

  return {
    ok: true,
    greeting: timeOfDayGreeting(displayName, new Date(now)),
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
  // org-scopes every BD table by RLS policy; we just forward the JWT.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });

  let displayName = "";
  try {
    const url = new URL(req.url);
    displayName = url.searchParams.get("name") ?? "";
  } catch { /* ignore */ }

  try {
    const body = await buildBriefing(supabase, displayName);
    return json(200, body);
  } catch (e) {
    console.error("[bd-briefing] failed:", e);
    return json(500, { ok: false, error: (e as Error).message });
  }
});
