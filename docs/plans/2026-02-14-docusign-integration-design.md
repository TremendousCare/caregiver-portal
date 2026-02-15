# DocuSign Integration Design

**Date**: 2026-02-14
**Version**: v7.0 — DocuSign eSignature Integration
**Status**: Approved
**Branch**: `feature/docusign-integration` (from `main`)

---

## Overview

Add DocuSign e-signature integration to the caregiver portal. Caregivers receive onboarding documents for signature via DocuSign. Signed documents automatically flow back into the portal — uploaded to SharePoint, tasks auto-completed, automation triggers fired.

Uses DocuSign **sandbox** by default. One settings toggle switches to production when ready.

## Decisions

- **Single Edge Function** (`docusign-integration`) — handles both outbound API calls and inbound webhooks
- **Template-based only** — documents are pre-built as DocuSign templates, referenced by ID
- **Configurable templates** — admin manages template list in Settings (not hardcoded)
- **Full automation chain** — webhook → download PDF → upload SharePoint → complete task → fire trigger
- **UI location** — collapsible "DocuSign eSignatures" section inside the existing Documents tab
- **Send modes** — "Send Full Packet" (all templates as one envelope) or send individual templates

---

## 1. Edge Function: `docusign-integration`

### Authentication

JWT Grant flow (service-to-service, no user login required).

**Supabase secrets:**
- `DOCUSIGN_INTEGRATION_KEY` — app client ID
- `DOCUSIGN_USER_ID` — user ID to impersonate
- `DOCUSIGN_RSA_PRIVATE_KEY` — RSA private key for JWT signing
- `DOCUSIGN_ACCOUNT_ID` — DocuSign account ID
- `DOCUSIGN_HMAC_SECRET` — for webhook signature verification

**Base URLs:**
- Sandbox: `https://demo.docusign.net`
- Production: `https://docusign.net` (switched via `docusign_environment` app_setting)

### Actions

| Action | Auth | Description |
|--------|------|-------------|
| `send_envelope` | Supabase JWT | Send one or more templates to a caregiver as a single envelope |
| `send_packet` | Supabase JWT | Send all configured templates as one combined envelope |
| `get_envelope_status` | Supabase JWT | Check status of a specific envelope |
| `list_envelopes` | Supabase JWT | List all envelopes for a caregiver (by email) |
| `download_document` | Supabase JWT | Download signed PDF from completed envelope |
| `webhook` | HMAC verification | Receive DocuSign Connect callback on envelope events |

### Webhook Flow

```
DocuSign Connect POSTs envelope event
  → Verify HMAC signature
  → Parse status (sent/delivered/viewed/completed/declined/voided)
  → Update docusign_envelopes table
  → If completed:
      → Download signed PDF(s)
      → Upload to SharePoint (via sharepoint-docs)
      → Mark linked onboarding task(s) complete
      → Fire document_signed automation trigger
  → Log event
```

### Send Envelope Payload

```json
{
  "action": "send_envelope",
  "caregiver_id": "uuid",
  "caregiver_email": "email@example.com",
  "caregiver_name": "First Last",
  "template_ids": ["template-id-1", "template-id-2"],
  "sent_by": "admin@company.com"
}
```

### Send Packet Payload

```json
{
  "action": "send_packet",
  "caregiver_id": "uuid",
  "caregiver_email": "email@example.com",
  "caregiver_name": "First Last",
  "sent_by": "admin@company.com"
}
```

Fetches all template IDs from `docusign_templates` app_setting.

---

## 2. Database

### New Table: `docusign_envelopes`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK, default gen_random_uuid()) | Auto-generated |
| `envelope_id` | text (unique) | DocuSign envelope ID |
| `caregiver_id` | uuid (FK → caregivers.id) | Links to caregiver |
| `template_ids` | jsonb | Array of template IDs included |
| `template_names` | jsonb | Array of template display names |
| `status` | text | sent, delivered, viewed, completed, declined, voided |
| `sent_by` | text | Email of user who triggered send |
| `sent_at` | timestamptz | When envelope was sent |
| `completed_at` | timestamptz | When fully signed (null until done) |
| `status_updated_at` | timestamptz | Last status change from webhook |
| `documents_uploaded` | boolean (default false) | Whether signed PDFs pushed to SharePoint |
| `tasks_completed` | jsonb | Array of task names auto-completed |
| `error_detail` | text | Error info if something failed |

**RLS Policies:**
- All authenticated can SELECT
- Authenticated can INSERT (sending envelopes)
- Service role can UPDATE (webhook status updates)

**Indexes:**
- `caregiver_id` — for listing envelopes per caregiver
- `envelope_id` (unique) — for webhook lookups
- `status_updated_at DESC` — for recent activity queries

### New `app_settings` Keys

| Key | Value Type | Example |
|-----|-----------|---------|
| `docusign_environment` | string | `"sandbox"` |
| `docusign_templates` | jsonb array | `[{ "id": "uuid", "templateId": "abc-123", "name": "Employment Agreement", "taskName": "Employment Agreement" }]` |

---

## 3. Frontend: DocuSignSection Component

### Location

`src/components/caregiver/DocuSignSection.jsx` — rendered inside `DocumentsSection.jsx` as a collapsible section.

### UI Layout

```
┌─────────────────────────────────────────────────┐
│ DocuSign eSignatures                       ▼    │
├─────────────────────────────────────────────────┤
│                                                 │
│  [Send Full Packet]  [Send Individual ▼]        │
│                                                 │
│  ── Sent Envelopes ──────────────────────────── │
│                                                 │
│  Employment Agreement          ✅ Completed      │
│  Sent Jan 15 · Signed Jan 16                    │
│                                                 │
│  Background Check Consent      📨 Delivered      │
│  Sent Jan 15 · Awaiting signature               │
│                                                 │
│  Full Onboarding Packet        ❌ Declined       │
│  Sent Jan 12 · Declined Jan 13  [Resend]        │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Behavior

- **Send Full Packet** — sends all configured templates as one envelope
- **Send Individual** — dropdown of configured templates, select one to send
- **Confirmation toast** before sending ("Send Employment Agreement to john@email.com?")
- **Envelope list** — fetched from `docusign_envelopes` table filtered by caregiver_id
- **Resend button** — on declined/voided envelopes
- **Status badges**: Sent (gray), Delivered (blue), Viewed (amber), Completed (green), Declined (red), Voided (red)
- **Empty state**: "No envelopes sent yet. Configure DocuSign templates in Settings to get started."
- **No templates configured state**: Link to Settings page

### Styling

CSS modules, consistent with existing DocumentsSection patterns.

---

## 4. Admin Settings

### New SettingsCard in AdminSettings.jsx

**Environment setting:**
- `EditableSetting` for `docusign_environment`
- Displays "Sandbox" (amber badge) or "Production" (green badge)

**Connection test:**
- `IntegrationInfoCard` showing connection status
- Edge Function `test_connection` action authenticates and returns success/failure

**Template configuration:**
- List of configured templates with add/edit/remove
- Each template has:
  - **Name** — display label (e.g., "Employment Agreement")
  - **Template ID** — DocuSign template ID (copied from DocuSign UI)
  - **Linked Task** — optional dropdown of onboarding task names (auto-complete on signature)
- Stored as `docusign_templates` jsonb array in `app_settings`

---

## 5. Automation Engine

### New Trigger

| Trigger | Fires When | Context |
|---------|-----------|---------|
| `document_signed` | Webhook receives completed status | `envelope_id`, `template_names`, `signer_email` |

Added to `TRIGGER_OPTIONS` in AutomationSettings.jsx and handled in `fireEventTriggers()`.

### New Merge Field

`{{signed_documents}}` — comma-separated list of template names in the completed envelope.

### New Action

| Action | Description | Config |
|--------|-------------|--------|
| `send_docusign_envelope` | Send templates for signature | `template_ids` (array, or `"all"` for full packet) |

Example rule: "When phase changes to Phase 2 → Send full onboarding packet."

---

## 6. AI Chat Tools

Added to `ai-chat` Edge Function.

| Tool | Risk | Description |
|------|------|-------------|
| `send_docusign_envelope` | medium | Send template(s) for signature. Confirmation card required. |
| `get_envelope_status` | low | Check signing status for a caregiver's envelopes |
| `list_docusign_envelopes` | low | List all sent envelopes for a caregiver |

---

## 7. DocuSign Setup Requirements

Before the integration works, these steps must be done in DocuSign's UI:

1. **Create a DocuSign developer account** at developers.docusign.com (free)
2. **Create an app** → get Integration Key
3. **Generate RSA keypair** → save private key
4. **Grant consent** → one-time admin consent for JWT impersonation
5. **Create templates** in DocuSign for each onboarding document
6. **Configure Connect webhook** → point to Edge Function URL
7. **Add secrets to Supabase** → DOCUSIGN_INTEGRATION_KEY, etc.
8. **Configure templates in portal Settings** → map template IDs to names and tasks

---

## 8. File Changes Summary

| File | Change |
|------|--------|
| **NEW** `docusign-integration` Edge Function | Full Edge Function (Supabase deploy) |
| **NEW** `src/components/caregiver/DocuSignSection.jsx` | DocuSign UI in Documents tab |
| **NEW** `src/styles/docusign.module.css` | Styles for DocuSign section |
| **MODIFY** `src/components/caregiver/DocumentsSection.jsx` | Import and render DocuSignSection |
| **MODIFY** `src/components/AdminSettings.jsx` | Add DocuSign settings card |
| **MODIFY** `src/components/AutomationSettings.jsx` | Add document_signed trigger, send_docusign_envelope action |
| **MODIFY** `src/lib/automations.js` | Handle document_signed trigger firing |
| **MODIFY** `src/lib/constants.js` | Add DOCUSIGN_STATUSES constant |
| **MODIFY** `ai-chat` Edge Function | Add 3 DocuSign tools |
| **MODIFY** `execute-automation` Edge Function | Handle send_docusign_envelope action |
| **MIGRATION** | CREATE TABLE docusign_envelopes + RLS + indexes |
