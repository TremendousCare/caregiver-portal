// ─── Caregiver Document Upload (Token-Based) ───
// Public edge function for caregivers to upload documents via a secure link.
// Two actions:
//   1. validate_token — returns caregiver name, requested doc types, already-uploaded docs
//   2. upload — validates token, uploads file to SharePoint via sharepoint-docs, inserts into caregiver_documents

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".heic"];

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Token Validation Helper ───
async function validateToken(supabase: ReturnType<typeof createClient>, token: string) {
  const { data, error } = await supabase
    .from("document_upload_tokens")
    .select("*")
    .eq("token", token)
    .single();

  if (error || !data) return { valid: false, error: "Invalid or expired link." };
  if (new Date(data.expires_at) < new Date()) return { valid: false, error: "This upload link has expired. Please request a new one from your coordinator." };

  return { valid: true, tokenRow: data };
}

// ─── Action: Validate Token ───
async function handleValidateToken(supabase: ReturnType<typeof createClient>, token: string) {
  const result = await validateToken(supabase, token);
  if (!result.valid) return jsonResponse({ error: result.error }, 400);

  const { tokenRow } = result;

  // Fetch caregiver name
  const { data: cg } = await supabase
    .from("caregivers")
    .select("first_name, last_name")
    .eq("id", tokenRow.caregiver_id)
    .single();

  // Fetch already-uploaded documents for this caregiver
  const { data: existingDocs } = await supabase
    .from("caregiver_documents")
    .select("document_type, file_name, uploaded_at")
    .eq("caregiver_id", tokenRow.caregiver_id);

  return jsonResponse({
    caregiver_first_name: cg?.first_name || "",
    caregiver_last_name: cg?.last_name || "",
    requested_types: tokenRow.requested_types || [],
    uploaded_docs: existingDocs || [],
    expires_at: tokenRow.expires_at,
  });
}

// ─── Action: Upload Document ───
async function handleUpload(
  supabase: ReturnType<typeof createClient>,
  token: string,
  documentType: string,
  fileName: string,
  fileContentBase64: string,
) {
  // Validate token
  const result = await validateToken(supabase, token);
  if (!result.valid) return jsonResponse({ error: result.error }, 400);

  const { tokenRow } = result;

  // Validate document type is in requested list
  const requestedTypes: string[] = tokenRow.requested_types || [];
  if (requestedTypes.length > 0 && !requestedTypes.includes(documentType)) {
    return jsonResponse({ error: "This document type was not requested." }, 400);
  }

  // Validate file extension
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return jsonResponse({
      error: `File type not allowed. Accepted: ${ALLOWED_EXTENSIONS.join(", ")}`,
    }, 400);
  }

  // Validate file size (base64 is ~4/3 of original)
  const estimatedSizeBytes = (fileContentBase64.length * 3) / 4;
  if (estimatedSizeBytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return jsonResponse({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` }, 400);
  }

  // Upload to SharePoint via existing sharepoint-docs edge function
  try {
    const spResponse = await fetch(`${SUPABASE_URL}/functions/v1/sharepoint-docs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        action: "upload_file",
        caregiver_id: tokenRow.caregiver_id,
        document_type: documentType,
        file_name: fileName,
        file_content_base64: fileContentBase64,
        uploaded_by: "caregiver-self-upload",
      }),
    });

    const spResult = await spResponse.json();
    if (spResult.error) {
      console.error("[caregiver-doc-upload] SharePoint upload error:", spResult.error);
      return jsonResponse({ error: "Upload failed. Please try again." }, 500);
    }

    // Update token used_at timestamp
    await supabase
      .from("document_upload_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("id", tokenRow.id);

    // Log event
    try {
      await supabase.from("events").insert({
        event_type: "document_uploaded",
        entity_type: "caregiver",
        entity_id: tokenRow.caregiver_id,
        actor: "caregiver:self-upload",
        payload: { document_type: documentType, file_name: fileName, via: "upload_link" },
      });
    } catch (_) {
      // Fire-and-forget — don't block on event logging
    }

    return jsonResponse({ success: true, message: "Document uploaded successfully." });
  } catch (err) {
    console.error("[caregiver-doc-upload] error:", err);
    return jsonResponse({ error: "Upload failed. Please try again." }, 500);
  }
}

// ─── Main Handler ───
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const { action, token } = body;

    if (!token) return jsonResponse({ error: "Missing token." }, 400);

    switch (action) {
      case "validate_token":
        return await handleValidateToken(supabase, token);

      case "upload":
        if (!body.document_type || !body.file_name || !body.file_content_base64) {
          return jsonResponse({ error: "Missing required fields: document_type, file_name, file_content_base64" }, 400);
        }
        return await handleUpload(supabase, token, body.document_type, body.file_name, body.file_content_base64);

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("[caregiver-doc-upload] unhandled error:", err);
    return jsonResponse({ error: "Internal server error." }, 500);
  }
});
