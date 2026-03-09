import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "node:crypto";

// ─── Environment ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRELLO_API_KEY = Deno.env.get("TRELLO_API_KEY")!;
const TRELLO_API_SECRET = Deno.env.get("TRELLO_API_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BOARD_ID = "67bbbf9a549caa8a299bb4d2"; // Caregiver Roadmap

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Signature Verification ───
function verifySignature(rawBody: string, callbackUrl: string, signature: string): boolean {
  if (!TRELLO_API_SECRET) return true; // Skip verification if secret not configured
  const expected = createHmac("sha1", TRELLO_API_SECRET)
    .update(rawBody + callbackUrl, "utf8")
    .digest("base64");
  return expected === signature;
}

// ─── Look up caregiver by Trello card ID ───
async function findCaregiverByCardId(cardId: string) {
  const { data, error } = await supabase
    .from("caregivers")
    .select("id, first_name, last_name, notes")
    .eq("trello_card_id", cardId)
    .eq("archived", false)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}

// ─── Check for duplicate note by action ID ───
function isDuplicateAction(
  notes: Array<Record<string, unknown>>,
  actionId: string
): boolean {
  return notes.some(
    (n) => (n as Record<string, string>).trello_action_id === actionId
  );
}

// ─── Handle commentCard action ───
async function handleComment(action: Record<string, unknown>): Promise<string> {
  const actionId = action.id as string;
  const actionDate = action.date as string;
  const data = action.data as Record<string, unknown>;
  const memberCreator = action.memberCreator as Record<string, string>;

  const card = data.card as Record<string, string>;
  const text = data.text as string;
  const authorName = memberCreator?.fullName || memberCreator?.username || "Unknown";
  const cardId = card?.id;

  if (!cardId || !text) {
    return "missing card ID or text";
  }

  // Find matching caregiver
  const caregiver = await findCaregiverByCardId(cardId);
  if (!caregiver) {
    return `no caregiver found for card ${cardId}`;
  }

  // Dedup check
  const existingNotes = Array.isArray(caregiver.notes) ? caregiver.notes : [];
  if (isDuplicateAction(existingNotes, actionId)) {
    return `duplicate action ${actionId} for ${caregiver.first_name} ${caregiver.last_name}`;
  }

  // Build note
  const note = {
    text,
    type: "note" as const,
    timestamp: new Date(actionDate).getTime(),
    author: `${authorName} (via Trello)`,
    trello_action_id: actionId,
  };

  // Append and save
  const updatedNotes = [...existingNotes, note];
  const { error } = await supabase
    .from("caregivers")
    .update({ notes: updatedNotes })
    .eq("id", caregiver.id);

  if (error) {
    console.error("Failed to update notes:", error);
    return `update failed for ${caregiver.first_name} ${caregiver.last_name}: ${error.message}`;
  }

  return `added note to ${caregiver.first_name} ${caregiver.last_name} from ${authorName}`;
}

// ─── Handle webhook registration (admin action) ───
async function handleRegister(boardId: string): Promise<Response> {
  const token = Deno.env.get("TRELLO_TOKEN");
  if (!TRELLO_API_KEY || !token) {
    return new Response(
      JSON.stringify({ error: "TRELLO_API_KEY and TRELLO_TOKEN must be set" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const callbackUrl = `${SUPABASE_URL}/functions/v1/trello-webhook`;

  const resp = await fetch(
    `https://api.trello.com/1/webhooks/?key=${TRELLO_API_KEY}&token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callbackURL: callbackUrl,
        idModel: boardId,
        description: "Caregiver Portal - Trello comment sync",
        active: true,
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    return new Response(
      JSON.stringify({ error: `Trello webhook registration failed: ${errText}` }),
      { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const webhookData = await resp.json();

  // Store webhook info in app_settings
  await supabase.from("app_settings").upsert(
    {
      key: "trello_webhook",
      value: {
        webhook_id: webhookData.id,
        board_id: boardId,
        callback_url: callbackUrl,
        active: webhookData.active,
        created_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  return new Response(
    JSON.stringify({ success: true, webhook_id: webhookData.id, callback_url: callbackUrl }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ─── Main Handler ───
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Trello HEAD verification (required for webhook registration)
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // Admin: register webhook
  if (action === "register") {
    const boardId = url.searchParams.get("board_id") || BOARD_ID;
    return handleRegister(boardId);
  }

  // Admin: list existing webhooks
  if (action === "list") {
    const token = Deno.env.get("TRELLO_TOKEN");
    const resp = await fetch(
      `https://api.trello.com/1/tokens/${token}/webhooks/?key=${TRELLO_API_KEY}`
    );
    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Webhook POST from Trello
  if (req.method === "POST") {
    const rawBody = await req.text();

    // Verify signature if secret is configured
    const signature = req.headers.get("x-trello-webhook") || "";
    const callbackUrl = `${SUPABASE_URL}/functions/v1/trello-webhook`;
    if (TRELLO_API_SECRET && !verifySignature(rawBody, callbackUrl, signature)) {
      console.error("Invalid Trello webhook signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trelloAction = body.action as Record<string, unknown>;
    if (!trelloAction) {
      return new Response(JSON.stringify({ skipped: true, reason: "No action in payload" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const actionType = trelloAction.type as string;

    // Only process comment actions
    if (actionType !== "commentCard") {
      return new Response(
        JSON.stringify({ skipped: true, reason: `Ignored action type: ${actionType}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      const result = await handleComment(trelloAction);
      console.log(`trello-webhook: ${result}`);
      return new Response(
        JSON.stringify({ success: true, result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error("trello-webhook error:", err);
      return new Response(
        JSON.stringify({ error: `Processing failed: ${(err as Error).message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
