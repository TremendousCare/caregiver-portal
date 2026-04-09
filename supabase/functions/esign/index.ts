// ─── Custom E-Signature Edge Function ───
// Handles the full signing lifecycle: create envelope, validate token,
// record views, accept signatures, embed into PDF, upload to SharePoint.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { decode as base64Decode, encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://caregiver-portal.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function appendAudit(existing: any[], action: string, extra: Record<string, any> = {}): any[] {
  return [...(existing || []), { action, at: new Date().toISOString(), ...extra }];
}

async function hashDocument(pdfBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", pdfBytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Action: Create Envelope ───
// Creates an esign envelope, generates a signing token, optionally sends via SMS/email.
async function handleCreateEnvelope(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const {
    caregiver_id,
    caregiver_name,
    caregiver_email,
    caregiver_phone,
    template_ids,
    sent_by,
    send_via = "sms",
    is_packet = false,
  } = body;

  if (!caregiver_id) return jsonResponse({ error: "Missing caregiver_id" }, 400);
  if (!template_ids?.length && !is_packet) return jsonResponse({ error: "Missing template_ids" }, 400);

  // Resolve templates
  let templateQuery = supabase.from("esign_templates").select("*").eq("active", true);
  if (!is_packet && template_ids?.length) {
    templateQuery = templateQuery.in("id", template_ids);
  }
  const { data: templates, error: tplErr } = await templateQuery.order("sort_order");
  if (tplErr) return jsonResponse({ error: `Failed to fetch templates: ${tplErr.message}` }, 500);
  if (!templates?.length) return jsonResponse({ error: "No active templates found." }, 404);

  const token = generateToken();
  const signingUrl = `${PORTAL_URL}/sign/${token}`;

  const envelopeData = {
    caregiver_id,
    template_ids: templates.map((t: any) => t.id),
    template_names: templates.map((t: any) => t.name),
    status: "sent",
    signing_token: token,
    sent_via: send_via,
    sent_by: sent_by || "system",
    expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    audit_trail: [{ action: "created", at: new Date().toISOString(), by: sent_by || "system" }],
  };

  const { data: envelope, error: insertErr } = await supabase
    .from("esign_envelopes")
    .insert(envelopeData)
    .select()
    .single();

  if (insertErr) return jsonResponse({ error: `Failed to create envelope: ${insertErr.message}` }, 500);

  // Send signing link via SMS and/or email
  const displayName = caregiver_name || "Caregiver";
  const docNames = templates.length > 1
    ? `${templates.length} onboarding documents`
    : templates[0].name;

  if (send_via === "sms" || send_via === "both") {
    if (caregiver_phone) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/bulk-sms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            caregiver_ids: [caregiver_id],
            message: `Hi ${displayName.split(" ")[0]}, please review and sign your ${docNames} for Tremendous Care: ${signingUrl}\n\nThis link expires in 14 days.`,
            sent_by: sent_by || "system",
          }),
        });
      } catch (err) {
        console.error("[esign] SMS send error:", err);
      }
    }
  }

  if (send_via === "email" || send_via === "both") {
    if (caregiver_email) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/bulk-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            to: [caregiver_email],
            subject: `Tremendous Care — Please sign your ${docNames}`,
            body: `<p>Hi ${displayName.split(" ")[0]},</p><p>Please review and sign your ${docNames} for Tremendous Care.</p><p><a href="${signingUrl}" style="display:inline-block;padding:12px 24px;background:#2E4E8D;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Review & Sign Documents</a></p><p>This link expires in 14 days.</p><p>Thank you,<br/>Tremendous Care</p>`,
            sent_by: sent_by || "system",
          }),
        });
      } catch (err) {
        console.error("[esign] Email send error:", err);
      }
    }
  }

  // Log event
  try {
    await supabase.from("events").insert({
      event_type: "esign_sent",
      entity_type: "caregiver",
      entity_id: caregiver_id,
      actor: `user:${sent_by || "system"}`,
      payload: {
        envelope_id: envelope.id,
        template_names: templates.map((t: any) => t.name),
        sent_via: send_via,
        is_packet,
      },
    });
  } catch (_) { /* fire-and-forget */ }

  return jsonResponse({
    success: true,
    envelope_id: envelope.id,
    signing_url: signingUrl,
    signing_token: token,
    templates_sent: templates.map((t: any) => t.name),
  });
}

// ─── Action: Validate Signing Token ───
// Public — used by the signing page to load documents.
async function handleValidateSigning(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const { token } = body;
  if (!token) return jsonResponse({ error: "Missing token" }, 400);

  const { data: envelope, error } = await supabase
    .from("esign_envelopes")
    .select("*")
    .eq("signing_token", token)
    .single();

  if (error || !envelope) return jsonResponse({ error: "Invalid signing link." }, 404);
  if (envelope.status === "signed") return jsonResponse({ error: "already_signed", envelope_id: envelope.id }, 400);
  if (envelope.status === "voided") return jsonResponse({ error: "This signing request has been cancelled." }, 400);
  if (envelope.status === "declined") return jsonResponse({ error: "This signing request was declined." }, 400);
  if (new Date(envelope.expires_at) < new Date()) {
    await supabase.from("esign_envelopes").update({ status: "expired" }).eq("id", envelope.id);
    return jsonResponse({ error: "This signing link has expired. Please contact your coordinator for a new one." }, 400);
  }

  // Fetch caregiver info
  const { data: cg } = await supabase
    .from("caregivers")
    .select("first_name, last_name, email")
    .eq("id", envelope.caregiver_id)
    .single();

  // Fetch templates with their storage paths
  const { data: templates } = await supabase
    .from("esign_templates")
    .select("id, name, fields, file_storage_path, file_page_count")
    .in("id", envelope.template_ids || [])
    .order("sort_order");

  // Generate signed URLs for each template PDF
  const templatesWithUrls = await Promise.all(
    (templates || []).map(async (t: any) => {
      const { data: signedUrl } = await supabase.storage
        .from("esign-templates")
        .createSignedUrl(t.file_storage_path, 3600); // 1 hour

      return {
        id: t.id,
        name: t.name,
        fields: t.fields || [],
        page_count: t.file_page_count || 1,
        pdf_url: signedUrl?.signedUrl || null,
      };
    }),
  );

  return jsonResponse({
    envelope_id: envelope.id,
    caregiver_name: cg ? `${cg.first_name} ${cg.last_name}` : "",
    templates: templatesWithUrls,
    expires_at: envelope.expires_at,
  });
}

// ─── Action: Record View ───
// Records that the signer opened the document.
async function handleRecordView(
  supabase: ReturnType<typeof createClient>,
  body: any,
  req: Request,
) {
  const { token } = body;
  if (!token) return jsonResponse({ error: "Missing token" }, 400);

  const { data: envelope } = await supabase
    .from("esign_envelopes")
    .select("id, status, audit_trail")
    .eq("signing_token", token)
    .single();

  if (!envelope) return jsonResponse({ error: "Invalid token" }, 404);
  if (envelope.status === "signed") return jsonResponse({ success: true }); // already signed

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  const updates: any = {
    audit_trail: appendAudit(envelope.audit_trail, "viewed", { ip, ua }),
  };

  // Only update status + viewed_at on first view
  if (envelope.status === "sent") {
    updates.status = "viewed";
    updates.viewed_at = new Date().toISOString();
  }

  await supabase.from("esign_envelopes").update(updates).eq("id", envelope.id);

  return jsonResponse({ success: true });
}

// ─── Action: Submit Signature ───
// Accepts signature data, embeds into PDFs, uploads to SharePoint, completes tasks.
async function handleSubmitSignature(
  supabase: ReturnType<typeof createClient>,
  body: any,
  req: Request,
) {
  const { token, field_values, consent_agreed } = body;
  if (!token) return jsonResponse({ error: "Missing token" }, 400);
  if (!consent_agreed) return jsonResponse({ error: "Electronic signature consent is required." }, 400);
  if (!field_values || typeof field_values !== "object") return jsonResponse({ error: "Missing field_values" }, 400);

  // Fetch envelope
  const { data: envelope, error: envErr } = await supabase
    .from("esign_envelopes")
    .select("*")
    .eq("signing_token", token)
    .single();

  if (envErr || !envelope) return jsonResponse({ error: "Invalid signing link." }, 404);
  if (envelope.status === "signed") return jsonResponse({ error: "already_signed" }, 400);
  if (envelope.status === "voided") return jsonResponse({ error: "This signing request has been cancelled." }, 400);
  if (new Date(envelope.expires_at) < new Date()) return jsonResponse({ error: "This signing link has expired." }, 400);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  // Fetch templates
  const { data: templates } = await supabase
    .from("esign_templates")
    .select("*")
    .in("id", envelope.template_ids || []);

  if (!templates?.length) return jsonResponse({ error: "Templates not found." }, 500);

  // Fetch caregiver info for SharePoint
  const { data: cg } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", envelope.caregiver_id)
    .single();

  const documentHashes: string[] = [];
  const uploadedDocIds: string[] = [];
  const completedTasks: string[] = [];

  // Process each template: embed signature, upload to SharePoint
  for (const template of templates) {
    try {
      // Download the template PDF from storage
      const { data: pdfData, error: dlErr } = await supabase.storage
        .from("esign-templates")
        .download(template.file_storage_path);

      if (dlErr || !pdfData) {
        console.error(`[esign] Failed to download template ${template.name}:`, dlErr);
        continue;
      }

      const pdfBytes = new Uint8Array(await pdfData.arrayBuffer());
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      // Get fields for this template from field_values
      const templateFields = field_values[template.id] || {};

      // Embed each field value into the PDF
      for (const fieldDef of (template.fields || [])) {
        const value = templateFields[fieldDef.id];
        if (!value) continue;

        const pageIdx = (fieldDef.page || 1) - 1;
        if (pageIdx >= pages.length) continue;
        const page = pages[pageIdx];
        const { height: pageHeight } = page.getSize();

        // Convert from top-left origin (CSS) to bottom-left origin (PDF)
        const pdfY = pageHeight - fieldDef.y - (fieldDef.h || 20);

        if (fieldDef.type === "signature" || fieldDef.type === "initials") {
          // Value is a base64 PNG data URL
          try {
            const imgData = value.replace(/^data:image\/png;base64,/, "");
            const imgBytes = base64Decode(imgData);
            const pngImage = await pdfDoc.embedPng(imgBytes);
            const dims = pngImage.scaleToFit(fieldDef.w || 200, fieldDef.h || 50);
            page.drawImage(pngImage, {
              x: fieldDef.x,
              y: pdfY,
              width: dims.width,
              height: dims.height,
            });
          } catch (imgErr) {
            console.error(`[esign] Failed to embed signature image for field ${fieldDef.id}:`, imgErr);
          }
        } else if (fieldDef.type === "date") {
          page.drawText(value, {
            x: fieldDef.x,
            y: pdfY + 4,
            size: 11,
            color: rgb(0, 0, 0),
          });
        } else if (fieldDef.type === "text") {
          page.drawText(value, {
            x: fieldDef.x,
            y: pdfY + 4,
            size: 11,
            color: rgb(0, 0, 0),
          });
        } else if (fieldDef.type === "checkbox") {
          if (value === true || value === "true") {
            page.drawText("\u2713", {
              x: fieldDef.x + 3,
              y: pdfY + 3,
              size: 14,
              color: rgb(0, 0, 0),
            });
          }
        }
      }

      // Add signing footer to last page
      const lastPage = pages[pages.length - 1];
      const { width: pw, height: ph } = lastPage.getSize();
      const footerText = `Electronically signed via Tremendous Care on ${new Date().toISOString().split("T")[0]} | IP: ${ip}`;
      lastPage.drawText(footerText, {
        x: 36,
        y: 20,
        size: 7,
        color: rgb(0.45, 0.45, 0.45),
      });

      // Save signed PDF
      const signedPdfBytes = await pdfDoc.save();
      const docHash = await hashDocument(signedPdfBytes);
      documentHashes.push(docHash);

      // Upload to SharePoint via existing sharepoint-docs edge function
      const signedBase64 = base64Encode(signedPdfBytes);
      const signedFileName = `${template.name.replace(/[^a-zA-Z0-9 _-]/g, "")}_Signed_${new Date().toISOString().split("T")[0]}.pdf`;

      try {
        const spResponse = await fetch(`${SUPABASE_URL}/functions/v1/sharepoint-docs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            action: "upload_file",
            caregiver_id: envelope.caregiver_id,
            document_type: template.document_type || "esign_document",
            file_name: signedFileName,
            file_content_base64: signedBase64,
            uploaded_by: "esign-system",
          }),
        });

        const spResult = await spResponse.json();
        if (spResult.error) {
          console.error(`[esign] SharePoint upload error for ${template.name}:`, spResult.error);
        } else {
          uploadedDocIds.push(spResult.doc_id || template.name);
        }
      } catch (spErr) {
        console.error(`[esign] SharePoint upload failed for ${template.name}:`, spErr);
      }

      // Auto-complete linked task on the caregiver
      if (template.task_name && cg?.tasks) {
        try {
          const updatedTasks = {
            ...cg.tasks,
            [template.task_name]: {
              completed: true,
              completedAt: Date.now(),
              completedBy: "eSign",
            },
          };
          await supabase
            .from("caregivers")
            .update({ tasks: updatedTasks })
            .eq("id", envelope.caregiver_id);
          completedTasks.push(template.task_name);
          // Update local ref for subsequent templates
          cg.tasks = updatedTasks;
        } catch (taskErr) {
          console.error(`[esign] Task completion error for ${template.task_name}:`, taskErr);
        }
      }
    } catch (err) {
      console.error(`[esign] Error processing template ${template.name}:`, err);
    }
  }

  // Update envelope status
  const combinedHash = documentHashes.join("|");
  await supabase
    .from("esign_envelopes")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      signer_ip: ip,
      signer_user_agent: ua,
      document_hash: combinedHash,
      signature_data: field_values,
      documents_uploaded: uploadedDocIds.length > 0,
      tasks_completed: completedTasks,
      audit_trail: appendAudit(envelope.audit_trail, "signed", {
        ip,
        ua,
        hash: combinedHash,
        documents_uploaded: uploadedDocIds.length,
        tasks_completed: completedTasks,
      }),
    })
    .eq("id", envelope.id);

  // Log event
  try {
    await supabase.from("events").insert({
      event_type: "document_signed",
      entity_type: "caregiver",
      entity_id: envelope.caregiver_id,
      actor: "caregiver:self",
      payload: {
        envelope_id: envelope.id,
        template_names: envelope.template_names,
        document_hash: combinedHash,
        documents_uploaded: uploadedDocIds.length,
        tasks_completed: completedTasks,
        ip,
        source: "esign",
      },
    });
  } catch (_) { /* fire-and-forget */ }

  // Add note to caregiver record
  if (cg) {
    try {
      const docDesc = templates.length > 1
        ? `${templates.length} documents (${templates.map((t: any) => t.name).join(", ")})`
        : templates[0]?.name || "document";
      const note = {
        text: `eSignature completed \u2014 ${docDesc} signed electronically`,
        type: "esign",
        timestamp: Date.now(),
        author: "eSign System",
        outcome: "documents signed",
        direction: "inbound",
      };
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), note] })
        .eq("id", envelope.caregiver_id);
    } catch (_) { /* fire-and-forget */ }
  }

  return jsonResponse({
    success: true,
    envelope_id: envelope.id,
    documents_signed: templates.length,
    documents_uploaded: uploadedDocIds.length,
    tasks_completed: completedTasks,
  });
}

// ─── Action: Void Envelope ───
async function handleVoidEnvelope(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const { envelope_id, voided_by } = body;
  if (!envelope_id) return jsonResponse({ error: "Missing envelope_id" }, 400);

  const { data: envelope } = await supabase
    .from("esign_envelopes")
    .select("id, status, audit_trail")
    .eq("id", envelope_id)
    .single();

  if (!envelope) return jsonResponse({ error: "Envelope not found" }, 404);
  if (envelope.status === "signed") return jsonResponse({ error: "Cannot void a signed envelope." }, 400);

  await supabase
    .from("esign_envelopes")
    .update({
      status: "voided",
      audit_trail: appendAudit(envelope.audit_trail, "voided", { by: voided_by || "system" }),
    })
    .eq("id", envelope_id);

  return jsonResponse({ success: true });
}

// ─── Action: Resend ───
async function handleResend(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const { envelope_id, resent_by } = body;
  if (!envelope_id) return jsonResponse({ error: "Missing envelope_id" }, 400);

  const { data: envelope } = await supabase
    .from("esign_envelopes")
    .select("*")
    .eq("id", envelope_id)
    .single();

  if (!envelope) return jsonResponse({ error: "Envelope not found" }, 404);
  if (envelope.status === "signed") return jsonResponse({ error: "Envelope already signed." }, 400);

  // Fetch caregiver for phone/email
  const { data: cg } = await supabase
    .from("caregivers")
    .select("first_name, last_name, phone, email")
    .eq("id", envelope.caregiver_id)
    .single();

  if (!cg) return jsonResponse({ error: "Caregiver not found." }, 404);

  // Extend expiration if it was expired
  const newExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const signingUrl = `${PORTAL_URL}/sign/${envelope.signing_token}`;
  const docNames = envelope.template_names?.length > 1
    ? `${envelope.template_names.length} onboarding documents`
    : (envelope.template_names?.[0] || "document");

  // Resend via original channel
  const sendVia = envelope.sent_via || "sms";
  if ((sendVia === "sms" || sendVia === "both") && cg.phone) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/bulk-sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          caregiver_ids: [envelope.caregiver_id],
          message: `Hi ${cg.first_name}, a reminder to please review and sign your ${docNames} for Tremendous Care: ${signingUrl}\n\nThis link expires in 14 days.`,
          sent_by: resent_by || "system",
        }),
      });
    } catch (err) {
      console.error("[esign] Resend SMS error:", err);
    }
  }

  if ((sendVia === "email" || sendVia === "both") && cg.email) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/bulk-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          to: [cg.email],
          subject: `Reminder: Please sign your ${docNames} — Tremendous Care`,
          body: `<p>Hi ${cg.first_name},</p><p>This is a reminder to review and sign your ${docNames}.</p><p><a href="${signingUrl}" style="display:inline-block;padding:12px 24px;background:#2E4E8D;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Review & Sign Documents</a></p><p>This link expires in 14 days.</p><p>Thank you,<br/>Tremendous Care</p>`,
          sent_by: resent_by || "system",
        }),
      });
    } catch (err) {
      console.error("[esign] Resend email error:", err);
    }
  }

  // Update envelope
  await supabase
    .from("esign_envelopes")
    .update({
      status: envelope.status === "expired" || envelope.status === "declined" ? "sent" : envelope.status,
      expires_at: newExpiry,
      audit_trail: appendAudit(envelope.audit_trail, "resent", { by: resent_by || "system", via: sendVia }),
    })
    .eq("id", envelope_id);

  return jsonResponse({ success: true, signing_url: signingUrl });
}

// ─── Main Handler ───
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "create_envelope":
        return await handleCreateEnvelope(supabase, body);

      case "validate_signing":
        return await handleValidateSigning(supabase, body);

      case "record_view":
        return await handleRecordView(supabase, body, req);

      case "submit_signature":
        return await handleSubmitSignature(supabase, body, req);

      case "void_envelope":
        return await handleVoidEnvelope(supabase, body);

      case "resend":
        return await handleResend(supabase, body);

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("[esign] Unhandled error:", err);
    return jsonResponse({ error: "Internal server error." }, 500);
  }
});
