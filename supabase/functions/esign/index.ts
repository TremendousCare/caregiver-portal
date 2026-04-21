// ─── Custom E-Signature Edge Function ───
// Handles the full signing lifecycle: create envelope, validate token,
// record views, accept signatures, embed into PDF, upload to SharePoint.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { decode as base64Decode, encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://portal.tremendouscareca.com";

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

// Mirror of src/lib/esignCheckboxGroups.js — keep in sync.
// Supabase only bundles code under supabase/functions/, so we can't import
// the client helper directly.
function groupCheckboxFields(fields: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const f of fields || []) {
    if (!f || f.type !== "checkbox") continue;
    const name = typeof f.group === "string" ? f.group.trim() : "";
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(f);
  }
  return groups;
}

function getRequiredGroupViolations(fields: any[], values: Record<string, any>) {
  const violations: Array<{ groupName: string; page: number; fieldId: string }> = [];
  for (const [groupName, members] of groupCheckboxFields(fields)) {
    const required = members.some((m) => m.required === true);
    if (!required) continue;
    const anyChecked = members.some((m) => values?.[m.id] === true || values?.[m.id] === "true");
    if (!anyChecked) {
      const first = members[0];
      violations.push({ groupName, page: first.page || 1, fieldId: first.id });
    }
  }
  return violations;
}

function normalizeCheckboxGroups(fields: any[], values: Record<string, any>) {
  const out = { ...(values || {}) };
  const corrections: Array<{ groupName: string; keptFieldId: string; clearedFieldIds: string[] }> = [];
  for (const [groupName, members] of groupCheckboxFields(fields)) {
    const truthy = members.filter((m) => out[m.id] === true || out[m.id] === "true");
    if (truthy.length <= 1) continue;
    const [keep, ...clear] = truthy;
    for (const m of clear) out[m.id] = false;
    corrections.push({
      groupName,
      keptFieldId: keep.id,
      clearedFieldIds: clear.map((m) => m.id),
    });
  }
  return { values: out, corrections };
}

async function hashDocument(pdfBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", pdfBytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Certificate of Completion PDF Generator ───
// Generates a standalone PDF proving who signed, when, from where, with document hashes.
async function generateCertificateOfCompletion(
  envelope: any,
  signerName: string,
  documentHashes: Record<string, string>,
  ip: string,
  ua: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // Letter size
  const { width, height } = page.getSize();

  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const darkBlue = rgb(0.18, 0.31, 0.55);

  let y = height - 60;

  // Header
  page.drawText("CERTIFICATE OF COMPLETION", { x: 140, y, size: 20, color: darkBlue });
  y -= 25;
  page.drawText("Electronic Signature Verification", { x: 190, y, size: 12, color: gray });
  y -= 10;
  // Divider line
  page.drawRectangle({ x: 50, y, width: width - 100, height: 1, color: darkBlue });
  y -= 30;

  // Envelope info
  page.drawText("Envelope ID:", { x: 50, y, size: 10, color: gray });
  page.drawText(envelope.id, { x: 160, y, size: 10, color: black });
  y -= 18;
  page.drawText("Status:", { x: 50, y, size: 10, color: gray });
  page.drawText("COMPLETED", { x: 160, y, size: 10, color: darkBlue });
  y -= 18;
  page.drawText("Sent By:", { x: 50, y, size: 10, color: gray });
  page.drawText(envelope.sent_by || "system", { x: 160, y, size: 10, color: black });
  y -= 18;
  page.drawText("Sent At:", { x: 50, y, size: 10, color: gray });
  page.drawText(new Date(envelope.sent_at).toLocaleString("en-US"), { x: 160, y, size: 10, color: black });
  y -= 30;

  // Signer info
  page.drawText("SIGNER DETAILS", { x: 50, y, size: 12, color: darkBlue });
  y -= 5;
  page.drawRectangle({ x: 50, y, width: width - 100, height: 1, color: gray });
  y -= 18;
  page.drawText("Name:", { x: 50, y, size: 10, color: gray });
  page.drawText(signerName, { x: 160, y, size: 10, color: black });
  y -= 18;
  page.drawText("IP Address:", { x: 50, y, size: 10, color: gray });
  page.drawText(ip, { x: 160, y, size: 10, color: black });
  y -= 18;
  page.drawText("User Agent:", { x: 50, y, size: 10, color: gray });
  const uaDisplay = ua.length > 70 ? ua.substring(0, 70) + "..." : ua;
  page.drawText(uaDisplay, { x: 160, y, size: 8, color: black });
  y -= 18;
  page.drawText("Signed At:", { x: 50, y, size: 10, color: gray });
  page.drawText(new Date().toLocaleString("en-US"), { x: 160, y, size: 10, color: black });
  y -= 18;
  if (envelope.consent_timestamp) {
    page.drawText("Consent Given:", { x: 50, y, size: 10, color: gray });
    page.drawText(new Date(envelope.consent_timestamp).toLocaleString("en-US"), { x: 160, y, size: 10, color: black });
    y -= 18;
  }
  y -= 15;

  // Document hashes
  page.drawText("DOCUMENT INTEGRITY (SHA-256)", { x: 50, y, size: 12, color: darkBlue });
  y -= 5;
  page.drawRectangle({ x: 50, y, width: width - 100, height: 1, color: gray });
  y -= 18;

  for (const [docName, hash] of Object.entries(documentHashes)) {
    page.drawText(docName, { x: 50, y, size: 10, color: black });
    y -= 14;
    page.drawText(hash, { x: 60, y, size: 7, color: gray });
    y -= 18;
  }
  y -= 10;

  // Audit trail
  const auditTrail = envelope.audit_trail || [];
  if (auditTrail.length > 0) {
    page.drawText("AUDIT TRAIL", { x: 50, y, size: 12, color: darkBlue });
    y -= 5;
    page.drawRectangle({ x: 50, y, width: width - 100, height: 1, color: gray });
    y -= 18;

    for (const entry of auditTrail) {
      if (y < 100) break; // Don't overflow past footer
      const time = entry.at ? new Date(entry.at).toLocaleString("en-US") : "—";
      const action = entry.action || "unknown";
      const detail = entry.ip ? ` (IP: ${entry.ip})` : "";
      page.drawText(`${time}  —  ${action}${detail}`, { x: 60, y, size: 8, color: gray });
      y -= 14;
    }
  }

  // Footer with ESIGN Act attestation
  const footerY = 60;
  page.drawRectangle({ x: 50, y: footerY + 15, width: width - 100, height: 1, color: gray });
  page.drawText(
    "This document was signed electronically in accordance with the ESIGN Act (15 U.S.C. § 7001).",
    { x: 50, y: footerY, size: 8, color: gray },
  );
  page.drawText(
    "The signer affirmatively consented to conduct this transaction electronically.",
    { x: 50, y: footerY - 12, size: 8, color: gray },
  );
  page.drawText(
    `Certificate generated by Tremendous Care eSign on ${new Date().toISOString()}`,
    { x: 50, y: footerY - 24, size: 8, color: gray },
  );

  return await pdfDoc.save();
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

  // Defense in depth: enforce required checkbox groups server-side (client
  // already validates, but we don't trust the client). Fail fast before
  // any PDF work so the user gets a clean error.
  const allViolations: Array<{ template: string; groupName: string; page: number }> = [];
  for (const tpl of templates) {
    const tplValues = (field_values as Record<string, any>)[tpl.id] || {};
    for (const v of getRequiredGroupViolations(tpl.fields || [], tplValues)) {
      allViolations.push({ template: tpl.name, groupName: v.groupName, page: v.page });
    }
  }
  if (allViolations.length > 0) {
    const details = allViolations.map((v) => `"${v.template}" group "${v.groupName}" (page ${v.page})`).join("; ");
    return jsonResponse({
      error: `Required selection missing in ${allViolations.length} group(s): ${details}`,
      violations: allViolations,
    }, 400);
  }

  // Pre-normalize radio exclusivity per template. At most one truthy value
  // per checkbox group ends up in the PDF and in signature_data — if the
  // client submitted multiple (shouldn't happen under normal flow), keep
  // the first in field-declaration order and clear the rest.
  const normalizedFieldValues: Record<string, any> = {};
  const groupCorrections: Array<{ template: string; corrections: any[] }> = [];
  for (const tpl of templates) {
    const tplValues = (field_values as Record<string, any>)[tpl.id] || {};
    const { values, corrections } = normalizeCheckboxGroups(tpl.fields || [], tplValues);
    normalizedFieldValues[tpl.id] = values;
    if (corrections.length > 0) {
      groupCorrections.push({ template: tpl.name, corrections });
    }
  }

  // Fetch caregiver info for SharePoint
  const { data: cg } = await supabase
    .from("caregivers")
    .select("*")
    .eq("id", envelope.caregiver_id)
    .single();

  const documentHashes: Record<string, string> = {};
  const uploadedDocIds: string[] = [];
  const completedTasks: string[] = [];
  const failedUploads: string[] = [];
  const processingLog: Record<string, any>[] = [];  // DB-level diagnostics

  // Helper: upload to SharePoint with one retry after 2s delay
  async function uploadToSharePoint(
    caregiverId: string, docType: string, fileName: string, base64Content: string,
  ): Promise<{ doc_id?: string; error?: string }> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[esign] Retry attempt ${attempt} for ${fileName}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        const spResponse = await fetch(`${SUPABASE_URL}/functions/v1/sharepoint-docs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            action: "upload_file",
            caregiver_id: caregiverId,
            document_type: docType,
            file_name: fileName,
            file_content_base64: base64Content,
            uploaded_by: "esign-system",
          }),
        });
        const result = await spResponse.json();
        if (!result.error) return result;
        console.error(`[esign] SharePoint returned error for ${fileName} (attempt ${attempt}):`, result.error);
      } catch (err) {
        console.error(`[esign] SharePoint fetch threw for ${fileName} (attempt ${attempt}):`, err);
      }
    }
    return { error: "All upload attempts failed" };
  }

  // Process each template: embed signature, upload to SharePoint
  for (let tIdx = 0; tIdx < templates.length; tIdx++) {
    const template = templates[tIdx];
    const tLog: Record<string, any> = { name: template.name, id: template.id, document_type: template.document_type || null, steps: {} };
    processingLog.push(tLog);
    console.log(`[esign] Processing template ${tIdx + 1}/${templates.length}: ${template.name} (${template.id})`);

    // Add delay between documents to avoid rapid sequential SharePoint calls
    if (tIdx > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Step 1: Download template PDF
    let pdfBytes: Uint8Array;
    try {
      const { data: pdfData, error: dlErr } = await supabase.storage
        .from("esign-templates")
        .download(template.file_storage_path);
      if (dlErr || !pdfData) {
        tLog.steps["1_download"] = { ok: false, error: String(dlErr) };
        failedUploads.push(template.name);
        continue;
      }
      pdfBytes = new Uint8Array(await pdfData.arrayBuffer());
      tLog.steps["1_download"] = { ok: true, bytes: pdfBytes.length };
    } catch (dlErr) {
      tLog.steps["1_download"] = { ok: false, threw: String(dlErr) };
      failedUploads.push(template.name);
      continue;
    }

    // Step 2: Load PDF and embed fields
    let signedPdfBytes: Uint8Array;
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      const templateFields = normalizedFieldValues[template.id] || {};

      for (const fieldDef of (template.fields || [])) {
        const value = templateFields[fieldDef.id];
        if (!value) continue;

        const pageIdx = (fieldDef.page || 1) - 1;
        if (pageIdx >= pages.length) continue;
        const page = pages[pageIdx];
        const { height: pageHeight } = page.getSize();
        const pdfY = pageHeight - fieldDef.y - (fieldDef.h || 20);

        if (fieldDef.type === "signature" || fieldDef.type === "initials") {
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
            console.error(`[esign] Failed to embed signature for field ${fieldDef.id}:`, imgErr);
          }
        } else if (fieldDef.type === "date" || fieldDef.type === "text") {
          page.drawText(value, {
            x: fieldDef.x,
            y: pdfY + 4,
            size: 11,
            color: rgb(0, 0, 0),
          });
        } else if (fieldDef.type === "checkbox") {
          if (value === true || value === "true") {
            try {
              page.drawText("\u2713", {
                x: fieldDef.x + 3,
                y: pdfY + 3,
                size: 14,
                color: rgb(0, 0, 0),
              });
            } catch {
              // WinAnsi-encoded PDFs can't render Unicode checkmark — fall back to X
              page.drawText("X", {
                x: fieldDef.x + 3,
                y: pdfY + 3,
                size: 14,
                color: rgb(0, 0, 0),
              });
            }
          }
        }
      }

      // Add signing footer to last page
      const lastPage = pages[pages.length - 1];
      const footerText = `Electronically signed via Tremendous Care on ${new Date().toISOString().split("T")[0]} | IP: ${ip}`;
      lastPage.drawText(footerText, {
        x: 36,
        y: 20,
        size: 7,
        color: rgb(0.45, 0.45, 0.45),
      });

      signedPdfBytes = await pdfDoc.save();
      tLog.steps["2_embed_save"] = { ok: true, originalBytes: pdfBytes.length, signedBytes: signedPdfBytes.length, inflation: `${((signedPdfBytes.length / pdfBytes.length) * 100).toFixed(0)}%` };
    } catch (embedErr) {
      tLog.steps["2_embed_save"] = { ok: false, threw: String(embedErr) };
      failedUploads.push(template.name);
      continue;
    }

    // Step 3: Hash the signed PDF
    try {
      const docHash = await hashDocument(signedPdfBytes);
      documentHashes[template.name] = docHash;
      tLog.steps["3_hash"] = { ok: true, hash: docHash.slice(0, 12) };
    } catch (hashErr) {
      tLog.steps["3_hash"] = { ok: false, threw: String(hashErr) };
      // Non-fatal: continue with upload even if hash fails
    }

    // Step 4: Base64 encode and upload to SharePoint
    try {
      const signedBase64 = base64Encode(signedPdfBytes);
      tLog.steps["4_encode"] = { ok: true, base64Chars: signedBase64.length };
      const signedFileName = `${template.name.replace(/[^a-zA-Z0-9 _-]/g, "")}_Signed_${new Date().toISOString().split("T")[0]}.pdf`;

      const spResult = await uploadToSharePoint(
        envelope.caregiver_id,
        template.document_type || "esign_document",
        signedFileName,
        signedBase64,
      );

      if (spResult.error) {
        tLog.steps["4_upload"] = { ok: false, error: String(spResult.error), docType: template.document_type || "esign_document" };
        failedUploads.push(template.name);
      } else {
        uploadedDocIds.push(spResult.doc_id || template.name);
        tLog.steps["4_upload"] = { ok: true, doc_id: spResult.doc_id || "fallback", docType: template.document_type || "esign_document" };
      }
    } catch (encodeErr) {
      tLog.steps["4_encode_upload"] = { ok: false, threw: String(encodeErr) };
      failedUploads.push(template.name);
    }

    // Step 5: Auto-complete linked task
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
        cg.tasks = updatedTasks;
      } catch (taskErr) {
        console.error(`[esign] Task completion error for ${template.task_name}:`, taskErr);
      }
    }
  }

  if (failedUploads.length > 0) {
    console.error(`[esign] WARNING: ${failedUploads.length} document(s) failed: ${failedUploads.join(", ")}`);
  }

  // documentHashes is already a { "Doc Name": "sha256hash" } map
  const docHashMap = documentHashes;

  // Generate Certificate of Completion PDF
  // Delay before certificate upload to avoid rapid SharePoint calls
  await new Promise((r) => setTimeout(r, 1500));
  const signerName = cg ? `${cg.first_name} ${cg.last_name}` : "Unknown";
  let certificateDocId: string | null = null;
  try {
    const certBytes = await generateCertificateOfCompletion(
      envelope, signerName, docHashMap, ip, ua,
    );
    const certBase64 = base64Encode(certBytes);
    const certFileName = `Certificate_of_Completion_${new Date().toISOString().split("T")[0]}.pdf`;
    console.log(`[esign] Uploading Certificate of Completion (${certBase64.length} chars base64)`);

    const spResult = await uploadToSharePoint(
      envelope.caregiver_id,
      "esign_certificate",
      certFileName,
      certBase64,
    );
    if (!spResult.error) {
      certificateDocId = spResult.doc_id || null;
      console.log(`[esign] Certificate uploaded → doc_id=${certificateDocId}`);
    } else {
      console.error("[esign] Certificate upload failed after retries:", spResult.error);
    }
  } catch (certErr) {
    console.error("[esign] Certificate generation error:", certErr);
  }

  // Update envelope status with all compliance fields
  const combinedHash = Object.values(documentHashes).join("|");
  await supabase
    .from("esign_envelopes")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      signer_ip: ip,
      signer_user_agent: ua,
      document_hash: combinedHash,
      document_hashes: docHashMap,
      signature_data: normalizedFieldValues,
      documents_uploaded: uploadedDocIds.length > 0,
      uploaded_doc_ids: uploadedDocIds,
      tasks_completed: completedTasks,
      completion_certificate_doc_id: certificateDocId,
      audit_trail: appendAudit(envelope.audit_trail, "signed", {
        ip,
        ua,
        hash: combinedHash,
        document_hashes: docHashMap,
        documents_uploaded: uploadedDocIds.length,
        tasks_completed: completedTasks,
        certificate_generated: !!certificateDocId,
        failed_uploads: failedUploads,
        processing_log: processingLog,
        ...(groupCorrections.length > 0 ? { checkbox_group_corrections: groupCorrections } : {}),
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
        document_hashes: docHashMap,
        documents_uploaded: uploadedDocIds.length,
        tasks_completed: completedTasks,
        certificate_doc_id: certificateDocId,
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

  // Send completion notification to sender
  if (envelope.sent_by) {
    try {
      const docList = templates.map((t: any) => t.name).join(", ");
      await fetch(`${SUPABASE_URL}/functions/v1/bulk-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          to: [envelope.sent_by],
          subject: `eSignature Complete — ${signerName}`,
          body: `<p><strong>${signerName}</strong> has completed signing the following documents:</p><ul>${templates.map((t: any) => `<li>${t.name}</li>`).join("")}</ul><p><strong>Signed at:</strong> ${new Date().toLocaleString("en-US")}</p><p>Signed documents and a Certificate of Completion have been uploaded to SharePoint.</p><p>— Tremendous Care eSign</p>`,
          sent_by: "esign-system",
        }),
      });
      // Mark sender as notified
      await supabase
        .from("esign_envelopes")
        .update({ sender_notified: true })
        .eq("id", envelope.id);
    } catch (_) { /* fire-and-forget */ }
  }

  return jsonResponse({
    success: true,
    envelope_id: envelope.id,
    documents_signed: templates.length,
    documents_uploaded: uploadedDocIds.length,
    tasks_completed: completedTasks,
    certificate_generated: !!certificateDocId,
  });
}

// ─── Action: Record Consent ───
// Persists ESIGN Act consent: timestamp, IP, user-agent.
// Called when signer clicks "Continue to Sign" on the consent page.
async function handleRecordConsent(
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
  if (envelope.status === "signed") return jsonResponse({ error: "Already signed" }, 400);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";
  const now = new Date().toISOString();

  await supabase
    .from("esign_envelopes")
    .update({
      consent_timestamp: now,
      consent_ip: ip,
      consent_user_agent: ua,
      audit_trail: appendAudit(envelope.audit_trail, "consent_recorded", { ip, ua }),
    })
    .eq("id", envelope.id);

  return jsonResponse({ success: true, consent_timestamp: now });
}

// ─── Action: Decline ───
// Signer formally declines to sign, with optional reason.
// Notifies the sender via email and logs event + note on the caregiver.
async function handleDecline(
  supabase: ReturnType<typeof createClient>,
  body: any,
  req: Request,
) {
  const { token, reason } = body;
  if (!token) return jsonResponse({ error: "Missing token" }, 400);

  const { data: envelope } = await supabase
    .from("esign_envelopes")
    .select("*")
    .eq("signing_token", token)
    .single();

  if (!envelope) return jsonResponse({ error: "Invalid token" }, 404);
  if (envelope.status === "signed") return jsonResponse({ error: "Cannot decline — already signed." }, 400);
  if (envelope.status === "declined") return jsonResponse({ error: "Already declined." }, 400);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";
  const now = new Date().toISOString();

  // Update envelope
  await supabase
    .from("esign_envelopes")
    .update({
      status: "declined",
      declined_at: now,
      decline_reason: reason || null,
      signer_ip: ip,
      signer_user_agent: ua,
      audit_trail: appendAudit(envelope.audit_trail, "declined", {
        ip, ua,
        reason: reason || "No reason provided",
      }),
    })
    .eq("id", envelope.id);

  // Fetch caregiver for notes + sender notification
  const { data: cg } = await supabase
    .from("caregivers")
    .select("first_name, last_name, notes")
    .eq("id", envelope.caregiver_id)
    .single();

  const signerName = cg ? `${cg.first_name} ${cg.last_name}` : "Caregiver";
  const docNames = envelope.template_names?.join(", ") || "documents";

  // Add note to caregiver record
  if (cg) {
    try {
      const note = {
        text: `eSignature declined — ${docNames}${reason ? `. Reason: ${reason}` : ""}`,
        type: "esign",
        timestamp: Date.now(),
        author: "eSign System",
        outcome: "declined",
        direction: "inbound",
      };
      await supabase
        .from("caregivers")
        .update({ notes: [...(cg.notes || []), note] })
        .eq("id", envelope.caregiver_id);
    } catch (_) { /* fire-and-forget */ }
  }

  // Notify sender via email
  if (envelope.sent_by) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/bulk-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          to: [envelope.sent_by],
          subject: `eSignature Declined — ${signerName}`,
          body: `<p><strong>${signerName}</strong> has declined to sign: <em>${docNames}</em></p>${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}<p>You may resend the documents or follow up with the caregiver.</p><p>— Tremendous Care eSign</p>`,
          sent_by: "esign-system",
        }),
      });
    } catch (_) { /* fire-and-forget */ }
  }

  // Log event
  try {
    await supabase.from("events").insert({
      event_type: "esign_declined",
      entity_type: "caregiver",
      entity_id: envelope.caregiver_id,
      actor: "caregiver:self",
      payload: {
        envelope_id: envelope.id,
        template_names: envelope.template_names,
        reason: reason || null,
        ip,
      },
    });
  } catch (_) { /* fire-and-forget */ }

  return jsonResponse({ success: true });
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

      case "record_consent":
        return await handleRecordConsent(supabase, body, req);

      case "decline":
        return await handleDecline(supabase, body, req);

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
