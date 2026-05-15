# In-Home Assessment Recording — Design Contract

**Status**: Draft for owner review. No code written. This document is the contract; once signed off, implementation follows it line by line.

**Prerequisites read**: `CLAUDE.md`, `docs/SAAS_RETROFIT.md`, `docs/SAAS_RETROFIT_STATUS.md`, `src/features/care-plans/sections.js`.

---

## Purpose of this document

The Business Development reps and Care Coordinators perform in-home assessments with prospective clients. Today they take handwritten or laptop notes and later transcribe those into the care plan section forms (`src/features/care-plans/sections.js`). The transcription step is slow, error-prone, and discards 80% of the conversational signal — tone, family dynamics, off-hand mentions of pets or hobbies — that would make a stronger care plan and a faster client conversion.

This project records the assessment audio, auto-generates a draft care plan with field-level citations back to the transcript, presents it to the Care Coordinator for review, and produces a narrative paragraph version once the draft is approved. The Care Coordinator remains the human in the loop. The AI is a typist with good listening comprehension, not a clinician.

This document is the durable source of truth for the build. If you are about to write recording code, transcription code, extraction prompts, the review UI, or any related migration, read this first and amend it before deviating.

---

## Vision in one paragraph

A BD rep or Care Coordinator walks into a client's home with the iPad they already use for intake. They open the client record, hit "Start Assessment Recording," speak a 10-second consent script with the client and any family present, and conduct the assessment as a normal conversation. Audio uploads in chunks during the visit so a network drop never costs more than a few seconds. Within minutes of "Stop Recording," the system returns a diarized transcript, a draft care plan with every proposed field linked to the transcript snippet that supports it, and queues it for Care Coordinator review. The Care Coordinator opens the draft side-by-side with the transcript, accepts/edits each field, and publishes. A narrative paragraph version is generated from the approved structured data and stored on the care plan version for sharing with family and referral partners. The entire pipeline is multi-tenant from day one, vendor-abstracted so transcription and LLM providers can be swapped without schema changes, and feature-flagged dark for every org except Tremendous Care during dogfooding.

---

## Decisions locked

Captured from owner discussion before doc drafting. Each is a non-negotiable input to the design.

1. **Vendors for v1**: Anthropic API direct (already wired for `ai-chat` and `care-plan-snapshot`) for the LLM. Deepgram pay-as-you-go (Nova-3 Medical) for transcription. Both without BAAs at v1.
2. **Compliance posture**: California-only operation, private-pay, non-medical home care license. HIPAA does not apply directly today. California's CMIA does apply — vendor terms-of-service confidentiality + technical safeguards (encryption, opt-out of training-data use, access controls) are the v1 posture. Healthcare attorney review of referral agreements lands before first real-client recording. BAAs deferred but **build is architected so they can be added later with a config change, not a rewrite** (see "BAA swap procedure" below).
3. **Recording role**: BD rep or Care Coordinator. No distinction in the recording flow itself — they're the same role for this feature.
4. **Review role**: Care Coordinator reviews every draft before publish. This matches today's care plan QA flow. No separate "clinical review" step.
5. **Consent**: California is two-party (all-party) consent for confidential communications. Verbal consent captured **on tape** at the start of every recording; signed acknowledgment captured in the iPad wizard before recording substantively begins. The consent segment is stored with the recording as legal cover.
6. **Three artifacts per assessment**: (a) raw diarized transcript with timestamps, (b) structured care plan draft with transcript citations, (c) narrative paragraph generated *after approval* from the approved structured data.
7. **Human-in-the-loop on every field**. The AI never auto-commits. Every proposed field shows as a suggestion the Care Coordinator accepts, edits, or rejects.
8. **Feature flag**: `assessments.recording_enabled` in `organizations.settings`. Dark for everyone except Tremendous Care during dogfooding.
9. **Multi-tenancy**: every new table carries `org_id` from creation per the Phase B prime directive. New RLS policies follow the `tenant_isolation_<table>_<verb>` pattern established in PR #236 (B2b).

---

## Non-goals (v1)

To keep v1 buildable in ~2 weeks and dogfood-able quickly:

- **Real-time transcript display during the visit** — not in v1. Audio uploads in chunks; processing is post-visit.
- **In-visit AI coaching / next-question suggestions** — not in v1.
- **Multilingual transcription / Spanish-speaking clients** — Deepgram supports Spanish but the prompt + review UI are English-only in v1.
- **Family-facing digest auto-generation** — not in v1. The narrative paragraph is internal/referral-partner facing.
- **Family signature capture on the iPad** — out of scope for v1 (separate DocuSign flow already exists).
- **Photo capture of pill bottles / medication labels** — out of scope for v1. Will be a high-value v2 addition.
- **Mobile (non-iPad) recording** — out of scope. iPad-only for v1 to match the existing intake wizard footprint.
- **Automatic re-extraction when the care plan schema changes** — the schema in `sections.js` is the contract at extraction time. If we add fields later, old transcripts are not re-processed.

---

## Architecture overview

```
iPad (existing intake wizard, new "Record Assessment" mode)
  │
  ├─ Capture consent (10-sec script on tape + signed checkbox)
  ├─ Chunked audio upload to Supabase Storage during recording
  └─ Submit for processing on Stop
        ↓
  Supabase Storage   bucket: assessment-recordings
                     path:   <org_id>/<client_id>/<recording_id>/audio.<ext>
                     access: private, signed-URL reads, RLS on path prefix
        ↓
  Edge function:  assessment-transcribe
                  Invoked by: Storage upload completion webhook OR explicit call
                  Provider: Deepgram Nova-3 Medical (default)
                  Writes:   assessment_transcripts (diarized, timestamped)
                  Emits:    assessment_transcript_completed event
        ↓
  Edge function:  assessment-extract
                  Trigger:  transcript_completed event
                  Provider: Anthropic Claude (claude-opus-4-7)
                  Input:    transcript + CARE_PLAN_SECTIONS schema
                  Output:   draft care_plan_version (status='ai_draft')
                            every field carries:
                              - proposed value
                              - confidence: 0.0-1.0
                              - citation: { startMs, endMs, quote, speaker }
                  Emits:    assessment_draft_ready event
        ↓
  Frontend:       /clients/<id>/assessment-draft/<recording_id>
                  Care Coordinator review UI
                  Side-by-side: transcript pane | proposed-fields pane
                  Per field: accept | edit | reject | (replay snippet)
                  On Publish: writes care_plan_version, status='published'
        ↓
  Edge function:  assessment-narrate
                  Trigger:  draft published with status='published'
                  Provider: Anthropic Claude
                  Input:    approved care_plan_version.data
                  Output:   narrative paragraph stored on the version
                            (parallel field to existing generated_summary)
```

The pipeline is event-driven via the existing `events` table — every stage emits an event so the AI context layer learns from the workflow, and so failures are diagnosable from the event timeline alone.

---

## Data model

Two new tables and one additive column on `care_plan_versions`. Both new tables carry `org_id NOT NULL DEFAULT public.default_org_id() REFERENCES public.organizations(id)` from creation, per Phase B Prime Directive #2.

### `assessment_recordings`

One row per recording session. The audio file lives in Storage; this row is the metadata anchor and lifecycle owner.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL → organizations | |
| `client_id` | uuid NOT NULL → clients | The prospective client being assessed |
| `recorded_by` | text NOT NULL | User who hit Record (matches `events.actor`) |
| `recorded_by_role` | text | `bd_rep` or `care_coordinator` (for analytics later) |
| `started_at` | timestamptz NOT NULL | When recording began |
| `ended_at` | timestamptz | NULL until Stop is pressed |
| `audio_path` | text | Storage key (relative to bucket); NULL while upload in progress |
| `audio_duration_seconds` | int | Backfilled by transcription step |
| `consent_verbal_captured` | boolean NOT NULL DEFAULT false | True once the on-tape consent segment is confirmed by the transcription step |
| `consent_signed_at` | timestamptz | When the in-app checkbox was checked |
| `consent_signed_by` | text | Client or family member name as entered on the iPad |
| `status` | text NOT NULL DEFAULT `'recording'` | `recording` → `uploaded` → `transcribing` → `extracting` → `awaiting_review` → `published` → `failed` |
| `failure_reason` | text | Populated when `status='failed'` |
| `phi_status` | text NOT NULL DEFAULT `'standard'` | `standard` (current) or `baa_protected` (post-BAA). Refuses real client recording when `'standard'` AND `organizations.settings.assessments.require_baa = true` |
| `created_at` / `updated_at` | timestamptz | Standard |

**Storage bucket**: `assessment-recordings`, private, path convention `<org_id>/<client_id>/<recording_id>/audio.<ext>`. RLS on `storage.objects` keys off the first path segment, mirroring the `profile-pictures` and `payroll-exports` precedents.

**Retention** (v1 default, configurable per org in `organizations.settings.assessments`): audio retained 90 days post-publish, then soft-deleted (the row stays for audit, `audio_path` is nulled and the Storage object removed). Transcript retained indefinitely.

### `assessment_transcripts`

One row per recording. Diarized, timestamped transcript plus the raw provider response for debugging and re-extraction if needed.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL → organizations | |
| `recording_id` | uuid NOT NULL UNIQUE → assessment_recordings | One transcript per recording |
| `provider` | text NOT NULL | `deepgram` for v1; `azure_speech`, `assemblyai` reserved |
| `provider_model` | text | e.g. `nova-3-medical` |
| `transcript_text` | text | Plain-text concatenation, for full-text search |
| `segments` | jsonb NOT NULL | Array of `{ startMs, endMs, speaker, text, confidence }` |
| `speakers` | jsonb | Diarization label map: `{ "0": "BD rep", "1": "Client", "2": "Daughter" }` — Care Coordinator can re-label in the review UI |
| `provider_response_raw` | jsonb | Full provider response, for debugging and re-extraction |
| `created_at` / `updated_at` | timestamptz | |

### `care_plan_versions` — additive columns

`care_plan_versions` already stores the structured care plan as `data` JSONB and the snapshot narrative as `generated_summary`. We add three columns:

| Column | Type | Notes |
|---|---|---|
| `source_recording_id` | uuid → assessment_recordings | NULL for manually-entered versions; populated when this version originated from an assessment recording. Enables "show the transcript snippet that supports this field" in the published view, not just during draft review. |
| `field_citations` | jsonb | Map: `{ "<sectionId>.<fieldId>": { startMs, endMs, quote, speaker, confidence } }`. Only fields the AI proposed have citations; fields the Care Coordinator typed manually do not. Persisted alongside `data` so the audit trail survives. |
| `narrative_paragraph` | text | The post-approval paragraph version. Distinct from `generated_summary` (which is the existing caregiver-facing snapshot). |

All three are nullable, additive, and ignored by every existing code path.

---

## Provider abstraction

Both transcription and LLM live behind narrow interfaces so swapping vendors is a config change, not a refactor. The abstraction sits in `supabase/functions/_shared/providers/`.

```ts
// _shared/providers/transcription.ts

export interface TranscriptionRequest {
  audioUrl: string;
  expectedSpeakers?: number;
  language?: 'en' | 'es';
  hints?: string[];
}

export interface TranscriptionSegment {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  confidence: number;
}

export interface TranscriptionResult {
  segments: TranscriptionSegment[];
  speakers: Record<string, string>;
  fullText: string;
  durationSeconds: number;
  providerResponseRaw: unknown;
}

export interface TranscriptionProvider {
  name: string;
  model: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}
```

```ts
// _shared/providers/llm.ts

export interface LlmRequest {
  systemPrompt: string;
  userMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  providerResponseRaw: unknown;
}

export interface LlmProvider {
  name: string;
  model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}
```

V1 implementations:

- `DeepgramTranscriptionProvider` — calls Deepgram pre-recorded endpoint (v1) or streaming (v1.5). Reads API key from `DEEPGRAM_API_KEY` env var.
- `AnthropicLlmProvider` — calls `api.anthropic.com/v1/messages`, model `claude-opus-4-7`. Reads API key from `ANTHROPIC_API_KEY` (already exists for `ai-chat` and `care-plan-snapshot`).

Reserved for later, sketched but not implemented:

- `AzureSpeechTranscriptionProvider` — falls back here if Deepgram becomes unaffordable or for orgs with existing Azure BAA.
- `AssemblyAiTranscriptionProvider` — alternate.
- `BedrockClaudeLlmProvider` — same model, Bedrock auth, for orgs on the AWS BAA.

**Provider selection** happens per-org via `organizations.settings.assessments.providers = { transcription: 'deepgram', llm: 'anthropic' }`. The factory in `_shared/providers/factory.ts` reads this and returns the right instance. Tremendous Care defaults to `deepgram` + `anthropic`.

---

## Recording UX

The recording flow lives inside the existing intake wizard (`src/features/...intake...` — confirm exact path during build kickoff) as a new "Record Assessment" mode that follows the same iPad-first design language.

### Pre-recording: consent gate

Before the Record button enables:

1. The iPad displays the consent script in large text:

   > "Hi [client name], I'm going to record our conversation today so I can focus on you instead of typing. The recording stays inside our care system and only our care team will hear it. Is that okay with you?"

2. The BD rep / Coordinator reads it aloud.
3. The iPad displays a checkbox: "Client and any family members present have verbally consented to being recorded." The wizard records the name typed in by the BD rep as `consent_signed_by` and timestamps the check as `consent_signed_at`.
4. Record button enables.

### During recording

- Audio chunks upload every 30 seconds to Supabase Storage (resumable upload). If the network drops, chunks queue locally and replay when connectivity returns. The iPad UI shows a single connectivity indicator; the BD rep should not have to think about it.
- A simple timer + "Recording" indicator. No live transcript display in v1.
- A single "Stop & Submit" button. No pause — keep it simple. If the BD rep needs to pause, they stop and start a new recording (the client gets two recordings on the file, which is fine).

### Post-recording

- "Stop & Submit" finalizes the upload, marks the row `status='uploaded'`, and shows a confirmation screen: "Assessment submitted. The Care Coordinator will review the draft within the hour."
- The transcription/extraction pipeline runs in the background. The BD rep does not wait.

### Failure modes the UX handles

- **Upload incomplete on Stop** — the iPad keeps trying to upload the remaining chunks; the BD rep gets a "Upload pending — leave this screen open until complete" warning. Once complete, the screen advances.
- **No network for >5 minutes** — recording continues to local storage; "Will upload when reconnected" message. We do not lose the recording.
- **Consent checkbox unchecked** — Record button stays disabled. Hard gate. California law leaves us no flexibility here.

---

## Field extraction prompt structure

The extraction prompt is the highest-leverage piece of the whole system. Get it wrong and every assessment requires heavy correction; get it right and the Care Coordinator becomes 5x more productive.

### Inputs

1. The diarized transcript (with speaker labels resolved as best the Care Coordinator could pre-extract; otherwise generic `Speaker 0/1/2`).
2. The `CARE_PLAN_SECTIONS` schema from `src/features/care-plans/sections.js`, serialized to JSON with field IDs, labels, types, options, and conditional rules.
3. A list of existing client data (name, DOB if known) so the AI doesn't try to extract them.
4. A short style guide ("California non-medical home care; use lay language; prefer client's own words for `lifeContext` and `interests`; do not infer diagnoses not explicitly mentioned").

### Output shape

A single JSON object the edge function parses:

```json
{
  "fields": {
    "whoTheyAre.fullName": {
      "value": "Margaret Eleanor Chen",
      "confidence": 0.95,
      "citation": {
        "startMs": 12400, "endMs": 16200,
        "quote": "Her full name is Margaret Eleanor Chen, M-A-R-G-A-R-E-T.",
        "speaker": "Daughter"
      }
    },
    "healthProfile.medications": {
      "value": [
        { "name": "Donepezil", "dose": "10 mg", "frequency": "Once daily", "reason": "Memory" }
      ],
      "confidence": 0.78,
      "citation": {
        "startMs": 412000, "endMs": 425500,
        "quote": "She takes a 10-milligram donepezil every morning for her memory.",
        "speaker": "Daughter"
      }
    }
  },
  "unmapped_observations": [
    {
      "topic": "Pets",
      "quote": "Her cat Whiskers is 14 years old and sleeps on her chest every afternoon.",
      "startMs": 1820000,
      "endMs": 1828000,
      "speaker": "Daughter",
      "suggestion": "Worth adding to interests or life context — strong attachment, may affect care planning."
    }
  ]
}
```

**Key design choices**:

- **Confidence is a number, not a category**. The UI maps it to high/medium/low bands but the AI gets a continuous signal.
- **Citation is mandatory** for every proposed field. No citation = the AI is guessing = the field is rejected before review.
- **`unmapped_observations`** is the safety valve. The AI surfaces things it noticed that don't fit the schema (a 14-year-old cat is not a care plan field, but it's gold for caregiver matching). The Care Coordinator decides where these go.
- **List-type fields** (medications, allergies, primary diagnoses) come back as full arrays so the Coordinator can accept the whole list or edit individual rows.

### What the prompt MUST forbid

1. **Inferring diagnoses, allergies, or medications not explicitly mentioned.** No "client probably has X based on symptoms" — that's clinical inference and we are not clinicians.
2. **Inventing prescribers, doses, or frequencies.** If the daughter says "she takes donepezil for memory" with no dose, the dose field is left empty, not guessed.
3. **Filling required fields with placeholder text.** Empty is correct when the assessment did not cover that ground.
4. **Mixing speakers' statements without attribution.** The citation must reflect the exact speaker who said the relevant words.

The system prompt enforces these as hard constraints with explicit examples of acceptable and forbidden output. Lives downstream from the patient-safety lens we'd apply to any clinical transcription tool.

---

## Care Coordinator review UX

A new route: `/clients/<clientId>/assessment-draft/<recordingId>`. Renders only when the recording's status is `awaiting_review` and `org_id` matches the Coordinator's JWT.

### Layout

Two-pane vertical split:

- **Left pane (40%)**: transcript player. Audio player at top (signed URL into Storage). Diarized transcript below, segments clickable to jump audio to that timestamp. Speaker labels editable inline (re-running label updates the transcript view and any field citations referencing that speaker).
- **Right pane (60%)**: care plan sections in their canonical order from `CARE_PLAN_SECTIONS`. Each proposed field renders:
  - Label, type-appropriate input pre-filled with the proposed value
  - Confidence badge (High / Medium / Low based on confidence score)
  - "Replay snippet" button — plays the cited audio segment
  - "Citation" hover — shows the exact transcript quote and speaker
  - Three actions: **Accept** (locks in the value), **Edit** (opens the value for modification, citation preserved), **Reject** (clears the value, citation removed)
- **Bottom bar**: section progress ("3 of 8 sections fully reviewed"), unmapped observations dropdown ("4 items the AI noticed that don't fit a field — review and decide"), and the Publish button (disabled until every required field is accepted or filled).

### Publish

On Publish:

1. Writes a new `care_plan_version` with `data` containing the accepted/edited values, `status='published'`, `source_recording_id` set, and `field_citations` populated for every AI-proposed field that wasn't rejected.
2. Sets `assessment_recordings.status='published'`.
3. Fires the `assessment_draft_published` event.
4. Asynchronously triggers `assessment-narrate` to generate the narrative paragraph.

The Coordinator does not wait for the narrative — they get a toast "Paragraph version generating, refresh in a minute" and can move on.

---

## Narrative generation

The narrative paragraph is a 200–400 word client-and-care-plan summary. It uses **approved structured data** as input, not the raw transcript, so any corrections the Coordinator made flow through.

The prompt asks Claude to produce:

- Opening sentence that humanizes the client (name, age, life context).
- Health summary: diagnoses, medications, functional limitations — clinical-but-readable.
- Cognition and behavior summary.
- Care needs summary: ADLs, IADLs, environment, schedule.
- Family and support summary.
- Closing sentence: the agency's recommended next step (proposed care hours / shift pattern, if the data supports it).

Output is stored as `care_plan_versions.narrative_paragraph`. Available in the care plan view as a "Narrative Summary" tab next to the existing structured sections.

Distinct from the existing `generated_summary` (which is a tighter caregiver-facing snapshot generated by `care-plan-snapshot`). The two coexist; the narrative is referral-partner / family / sales-followup facing.

---

## Multi-tenancy posture

Per Phase B (in flight; see `docs/SAAS_RETROFIT_STATUS.md`), every new table follows the established pattern:

- `org_id uuid NOT NULL DEFAULT public.default_org_id() REFERENCES public.organizations(id)`
- Index on `(org_id, ...)` for the common access patterns (`org_id, client_id`, `org_id, status`).
- RLS enabled on the table.
- Tenant-isolation policy named `tenant_isolation_<table>_<select|insert|update|delete>` with predicate `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`.
- Storage bucket RLS on `storage.objects` filters on `(storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')` — mirrors `payroll-exports` and `profile-pictures`.

Edge functions read the JWT `org_id` from the inbound `Authorization` header and pass it explicitly when writing the `org_id` column — they do not rely on the column default, because edge functions often run with the service role.

**Feature flag**: `organizations.settings.assessments.recording_enabled` (bool, default `false`). Tremendous Care gets `true` at v1 ship. The frontend hides the "Record Assessment" entry point when this is false. Edge functions reject incoming requests if the org's flag is off, as defense in depth.

---

## Compliance posture (without BAA at v1)

We are operating today as: a private-pay, California-only, non-medical home care agency receiving only name + phone from referral partners and generating health information ourselves through in-home assessment. HIPAA does not directly apply to Tremendous Care under this posture. CMIA does.

**What CMIA requires (and we provide)**:

- Reasonable safeguards for confidential medical information: encryption at rest (Supabase default + Storage encryption), encryption in transit (TLS everywhere), access controls (RLS on every table + tenant isolation).
- Limited disclosure: vendors handling the data must have written confidentiality terms. Deepgram's ToS and Anthropic's ToS both include confidentiality clauses. We additionally email each vendor to opt out of training-data use on our account.
- Breach notification readiness: we maintain a log (`events` table) of every access to the recording bucket and every transcript read.

**What we tell clients in the consent script**: the recording is used by our care team to build their care plan, stays inside our care system, and is not shared outside the agency without their explicit permission. This is true under the v1 vendor posture.

**Healthcare attorney sign-off**: before first real-client recording, schedule a one-hour review with a healthcare attorney covering (a) the current referral agreements for downstream BA obligations, (b) the consent script and signed acknowledgment language, (c) the retention policy. Not a development blocker, but lands before production launch.

---

## BAA swap procedure

If/when the owner decides to sign BAAs, the migration is:

1. **AWS Bedrock for Claude** — sign the AWS BAA in AWS Artifact (free, click-through). Request Claude model access in Bedrock console. Create IAM user with `bedrock:InvokeModel` permission scoped to the Claude model ARNs. Add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` to Supabase edge function secrets. Implement `BedrockClaudeLlmProvider` (~50 lines, mirrors `AnthropicLlmProvider`). Update `organizations.settings.assessments.providers.llm` to `'bedrock'` for the org. No schema change, no UI change, no prompt change.

2. **Deepgram BAA tier** — sign the Deepgram Enterprise contract (sales-led). The API endpoint and request shape are identical to pay-as-you-go. Update the `DEEPGRAM_API_KEY` env var to the BAA-tier key. Email Deepgram to confirm the account is BAA-covered. No code change.

3. **Per-org BAA flag** — set `organizations.settings.assessments.require_baa = true`. The edge functions enforce: refuse to process a recording for that org unless the configured provider is BAA-eligible (`bedrock` for LLM, `deepgram-baa` for transcription). This prevents accidental routing of an org's audio to a non-BAA endpoint after the org has opted in.

4. **Audit + sign-off** — Phase E of the SaaS retrofit (`docs/SAAS_RETROFIT.md` → Phase E) is the natural home for the BAA matrix and customer compliance docs.

The expected total work for the swap is one PR (~150 lines, mostly the `BedrockClaudeLlmProvider` and the per-org enforcement logic), one IAM setup session, one Deepgram contract signature, and one regression-test pass on a single test recording. **No data migration, no schema migration, no UI change.**

---

## Build phases

### v1 (target: ~2 weeks of focused work)

1. Schema migration: `assessment_recordings`, `assessment_transcripts`, `care_plan_versions` additive columns, storage bucket + RLS, feature flag in `organizations.settings`.
2. Provider abstraction module: `_shared/providers/{transcription,llm,factory}.ts` with Deepgram + Anthropic implementations.
3. Edge function `assessment-transcribe`.
4. Edge function `assessment-extract` (the prompt is the largest single design risk — budget time for iteration).
5. Edge function `assessment-narrate`.
6. iPad recording UX inside the intake wizard.
7. Care Coordinator review UI at `/clients/<id>/assessment-draft/<recordingId>`.
8. Wire-through to `care_plan_versions` publish.
9. Tests: extraction-prompt accuracy on synthetic transcripts; review-UI behavior; multi-tenant isolation; feature flag enforcement.
10. Dark-launch flag for everyone except Tremendous Care.

### v1.5 (after v1 bakes for 2 weeks of real assessments)

- Streaming transcription (replaces batch on Stop with live chunks for sub-minute turnaround).
- Speaker re-labeling persistence (current draft has it; v1.5 propagates label changes back to the transcript table).
- Confidence-based field auto-acceptance for `>0.95` non-list fields (still reviewable, but pre-accepted to speed flow). Behind a per-org setting.
- Unmapped observations → AI suggestions on where they belong, one-click accept.

### v2 (longer-horizon)

- Photo capture of pill bottles → OCR → medication reconciliation against the spoken list.
- Spanish-language transcription + Spanish→English structured extraction.
- Mobile (non-iPad) recording for caregivers doing follow-up assessments.
- Re-extraction trigger when `CARE_PLAN_SECTIONS` schema changes (regenerate field draft from stored transcript against the new schema).
- Family-facing digest auto-generation from the approved care plan (separate prompt, more conversational tone).
- Integration with the agent platform vision (`docs/AGENT_PLATFORM_VISION.md`) — assessment recording becomes input signal for the matching/scheduling agents.

---

## Open questions for owner

These do not block doc sign-off but should be answered before code lands.

1. **Microphone**: iPad built-in vs. a clip-on lavalier (Rode SmartLav+ at ~$60). Built-in works at conversational distance but lavalier is dramatically better with background noise / soft-spoken clients. Recommendation: order two lavaliers, ship v1 with iPad built-in, A/B test in real assessments.
2. **Retention policy specifics**: 90 days post-publish for audio is the proposed default. Confirm or adjust.
3. **Who is the first dogfooder?** Recommend one BD rep + one Care Coordinator at Tremendous Care, three assessments each before broader rollout.
4. **Error handling on partial transcripts**: if the audio is corrupted at minute 45 of 60, do we still attempt extraction on what we have, or fail the whole recording? Recommendation: attempt extraction with a `transcript_complete=false` flag visible to the Coordinator.
5. **Cost ceiling alert**: at what monthly spend (Deepgram + Anthropic combined) should the system page the owner? Recommendation: $100/month alert, $500/month hard pause requiring acknowledgment.
6. **Healthcare attorney**: name, scheduled date, scope of review. Owner action item.

---

## Glossary

- **BD rep**: Business Development representative. Performs initial in-home assessments and proposals.
- **Care Coordinator**: Operations staff who reviews every care plan before publish, schedules caregivers, and owns the client relationship post-conversion.
- **CMIA**: California Confidentiality of Medical Information Act. State analog to HIPAA with broader applicability (covers any business collecting health information regardless of medical-provider status).
- **BAA**: Business Associate Agreement. HIPAA contract between a covered entity (or business associate) and a vendor handling PHI.
- **PHI**: Protected Health Information under HIPAA. Functionally similar (but not identical) to "medical information" under CMIA.
- **Diarization**: Identifying which speaker said which words in multi-speaker audio.
- **WER**: Word Error Rate. Standard transcription accuracy metric.

---

## Sign-off checklist

Before code lands on any of this, the owner has confirmed:

- [ ] Vendor stack: Anthropic API direct + Deepgram pay-as-you-go for v1
- [ ] Recording role: BD rep or Care Coordinator
- [ ] Review role: Care Coordinator on every draft
- [ ] California two-party consent flow as specified
- [ ] Three-artifact structure (transcript, structured draft, narrative paragraph)
- [ ] Feature flag dark for everyone except Tremendous Care at v1 ship
- [ ] Retention policy: 90 days for audio, indefinite for transcript
- [ ] Healthcare attorney review scheduled before first real recording
- [ ] First dogfooder identified

When all are checked, this doc becomes the build contract. Any deviation gets discussed with the owner and amended here.
