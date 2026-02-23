# Unified Intake Queue — Design Document

**Date:** 2026-02-23
**Status:** Approved
**Approach:** Queue + Cron Worker (Approach A)

## Problem

The WordPress client intake form intermittently fails (~70% failure rate) because
Forminator blocks form submission while waiting for the webhook response. The Edge
Function takes 2-5 seconds (cold start + 3-4 DB round trips), exceeding Forminator's
timeout. Additionally, there's no intake pipeline for caregiver applicants from Indeed
or the WordPress caregiver application form.

## Solution

A unified intake queue that decouples form submission from record processing. All
intake sources feed into one queue table. A slim webhook stores raw payloads instantly.
A cron-driven processor handles validation, dedup, record creation, and automations
on a 2-minute cycle.

## Architecture

```
INTAKE SOURCES                          WEBHOOK              QUEUE              PROCESSOR
                                        (~100ms)             (DB table)         (every 2 min)

WordPress Client Form ─────┐
WordPress Caregiver Form ──┤
Indeed Custom Apply Page ──┤──→ intake-webhook ──→ intake_queue ──→ intake-processor
(Future: Indeed email,     │    - validate key     - raw_payload    - map fields
 Google Ads, Meta)  ───────┘    - INSERT raw        - status         - deduplicate
                                - return 200        - entity_type    - create record
                                                                     - fire automations
                                                                     - mark processed
```

## Components

### 1. `intake_queue` Table (migration)

```sql
intake_queue (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        TEXT NOT NULL,          -- 'wordpress_client', 'wordpress_caregiver',
                                        -- 'indeed_apply', 'indeed_email', etc.
  entity_type   TEXT NOT NULL,          -- 'client' or 'caregiver'
  raw_payload   JSONB NOT NULL,         -- exact data from form
  api_key_label TEXT,                   -- which API key was used
  status        TEXT DEFAULT 'pending', -- 'pending', 'processed', 'error', 'duplicate'
  error_detail  TEXT,                   -- failure reason if status='error'
  result_id     TEXT,                   -- created client/caregiver ID
  attempts      INTEGER DEFAULT 0,     -- retry counter (max 3)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);
```

Indexes: `(status) WHERE status = 'pending'`, `(created_at DESC)`.
RLS: service_role only (no browser access needed).

### 2. Slim `intake-webhook` Edge Function (replaces `client-intake-webhook`)

~50 lines. Three steps:
1. Validate API key against `app_settings.intake_webhook_keys`
2. INSERT raw payload into `intake_queue`
3. Return 200

API keys extended with `entity_type`:
```json
[
  { "key": "wh_79d21...", "source": "wordpress", "label": "Client Multi-Step Form", "entity_type": "client", "enabled": true },
  { "key": "wh_abc12...", "source": "wordpress", "label": "Caregiver Application", "entity_type": "caregiver", "enabled": true },
  { "key": "wh_def34...", "source": "indeed", "label": "Indeed Apply Page", "entity_type": "caregiver", "enabled": true }
]
```

Same URL as current webhook — Forminator config doesn't change. Just re-enable.

### 3. `intake-processor` Edge Function (new)

Called by pg_cron every 2 minutes. Processes up to 20 pending entries per cycle.

For each entry:
1. Map fields (entity_type determines which mapping to use)
2. Deduplicate by email + phone
3. If duplicate: mark as 'duplicate', add note to existing record
4. If new: INSERT into clients/caregivers, fire automations + sequences
5. On failure: increment attempts, log error_detail, retry next cycle
6. After 3 failures: set status='error' (stops retrying)

Reuses field mapping logic from current `client-intake-webhook` for clients.
New caregiver mapping:

| Form Field     | Caregivers Column |
|---------------|-------------------|
| First Name     | first_name        |
| Last Name      | last_name         |
| Email          | email             |
| Phone          | phone             |
| Subject        | initial note      |
| Message        | initial note      |
| Address fields | address/city/state/zip |

### 4. pg_cron Job (migration)

```sql
SELECT cron.schedule(
  'process-intake-queue',
  '*/2 * * * *',
  $$SELECT net.http_post(
    url := 'https://zocrnurvazyxdpyqimgj.supabase.co/functions/v1/intake-processor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);
```

### 5. `/apply` Page (React, public route)

Public caregiver application page at `/apply`. No authentication required.

Fields: First Name, Last Name, Phone, Email, Address, City, State, Zip, Message (optional).

Submits directly to intake webhook with Indeed-specific API key.
Shows confirmation on success. Linked from Indeed "Apply on Company Website" postings.

### 6. New API Keys

Generate and store in `app_settings.intake_webhook_keys`:
- WordPress caregiver form key (entity_type: 'caregiver')
- Indeed apply page key (entity_type: 'caregiver')
- Existing client form key updated with entity_type: 'client'

## What Changes for Existing Setup

- WordPress client form: same webhook URL, re-enable in Forminator, works faster
- WordPress caregiver form: add Forminator webhook with new API key
- Indeed postings: link to /apply page

## Not In Scope (Future)

- Indeed email notification parsing (separate PR, involves Outlook cron)
- Admin UI for queue monitoring (AI chatbot can query queue)
- Google Ads / Meta lead form integration (same pattern, add API keys later)

## Estimated Scope

- 1 migration (table + cron job)
- 2 Edge Functions (intake-webhook, intake-processor)
- 1 React page (/apply)
- ~6-8 files total
