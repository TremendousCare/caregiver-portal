import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── Helpers ───

function resolveMergeFields(
  template: string,
  client: {
    first_name: string;
    last_name: string;
    phone?: string;
    email?: string;
    care_recipient_name?: string;
    contact_name?: string;
    phase?: string;
  },
): string {
  return template
    .replace(/\{\{firstName\}\}/gi, client.first_name || "")
    .replace(/\{\{lastName\}\}/gi, client.last_name || "")
    .replace(/\{\{phone\}\}/gi, client.phone || "")
    .replace(/\{\{email\}\}/gi, client.email || "")
    .replace(/\{\{careRecipientName\}\}/gi, client.care_recipient_name || "")
    .replace(/\{\{contactName\}\}/gi, client.contact_name || "")
    .replace(/\{\{phase\}\}/gi, client.phase || "");
}

function fullName(client: { first_name: string; last_name: string }): string {
  return `${client.first_name || ""} ${client.last_name || ""}`.trim();
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { client_ids, subject, body, current_user } = await req.json();

    if (!client_ids?.length) {
      return new Response(
        JSON.stringify({ error: "client_ids is required and must be non-empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!subject?.trim()) {
      return new Response(
        JSON.stringify({ error: "subject is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!body?.trim()) {
      return new Response(
        JSON.stringify({ error: "body is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch clients in one query
    const { data: clients, error: fetchErr } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, care_recipient_name, contact_name, phase")
      .in("id", client_ids);

    if (fetchErr) {
      return new Response(
        JSON.stringify({ error: `Failed to fetch clients: ${fetchErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!clients || clients.length === 0) {
      return new Response(
        JSON.stringify({ error: "No clients found for the given IDs" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Process each client sequentially
    const results: Array<{
      id: string;
      name: string;
      status: "sent" | "skipped" | "failed";
      reason?: string;
    }> = [];

    for (const client of clients) {
      // Skip: no email
      if (!client.email || !client.email.trim()) {
        results.push({ id: client.id, name: fullName(client), status: "skipped", reason: "no email address" });
        continue;
      }

      // Resolve merge fields in both subject and body
      const resolvedSubject = resolveMergeFields(subject, client);
      const resolvedBody = resolveMergeFields(body, client);

      try {
        // Call outlook-integration Edge Function
        const response = await fetch(`${SUPABASE_URL}/functions/v1/outlook-integration`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            action: "send_email",
            to_email: client.email,
            to_name: fullName(client),
            subject: resolvedSubject,
            body: resolvedBody,
          }),
        });

        const result = await response.json();
        if (result.error) {
          throw new Error(result.error);
        }

        // Per user preference: do NOT log a note on client records
        results.push({ id: client.id, name: fullName(client), status: "sent" });
      } catch (err) {
        console.error(`[bulk-email] Failed for ${fullName(client)}:`, err);
        results.push({ id: client.id, name: fullName(client), status: "failed", reason: (err as Error).message });
      }

      // Rate limiting: 300ms between sends
      await new Promise((r) => setTimeout(r, 300));
    }

    const summary = {
      sent: results.filter((r) => r.status === "sent").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    };

    console.log(`[bulk-email] Complete: ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed`);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[bulk-email] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: `Unexpected error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
