# In-Home Assessment Transcription

Records (or uploads) the audio of an in-home assessment visit, retains it as a
clinical record, and produces a diarized transcript via **Deepgram**
(`nova-3-medical`). The transcript is the input for AI care-plan extraction
(PR 4).

## Data model (PR 1 — migration `20260602010000_assessments_schema.sql`)

- **`assessments`** — one row per assessment visit. Lifecycle:
  `recording → uploaded → transcribing → transcribed` (`failed` is terminal
  with retry). Holds the audio pointer (`audio_path`), `client_id`,
  `duration_seconds`, `error_message`. Org-scoped (`org_id`), RLS gated on
  `public.is_staff()`; admin-only `DELETE`.
- **`assessment_transcriptions`** — one row per assessment
  (`UNIQUE assessment_id`). Flat `transcript` plus `transcript_json`
  (diarized utterances) and Deepgram metadata.
- **`assessment-audio`** storage bucket — private, org-scoped via the
  `<org_id>/<assessment_id>.<ext>` path prefix.

PR 2 (`20260603000000`) adds `assessments.transcribe_attempts` and
`assessments.dg_request_id`.

## Pipeline (PR 2)

```
Frontend (PR 3)                 assessment-transcribe          Deepgram                deepgram-callback
  upload audio ─────────────────►  mint signed URL
  insert assessment (uploaded)     submit (async, callback) ───► transcribe ──(POST)──► verify token
  POST {assessment_id}             status → transcribing                                 upsert transcription
                                                                                          status → transcribed
                                   ▲
                                   │ retries lost submits / callbacks
                  assessment-transcribe-reconcile (cron, every 5 min)
```

- **`assessment-transcribe`** (staff-auth): mints a 1-hour signed URL for the
  audio and submits it to Deepgram in async-callback mode. Sets status
  `transcribing`, increments `transcribe_attempts`.
- **`deepgram-callback`** (public, secret-token auth): Deepgram POSTs the
  result here. Verifies the shared secret in the URL, upserts the transcript
  (idempotent), flips status to `transcribed`, logs an `events` row. Records
  `failed` on a Deepgram error / no-speech payload.
- **`assessment-transcribe-reconcile`** (cron, every 5 min): recovers rows
  whose initial submit or callback was lost; gives up after `maxAttempts`
  (→ `failed`). Decision logic is the pure `decideReconcileAction()`.

Shared, unit-tested helpers: `_shared/helpers/deepgram.ts` (protocol) and
`_shared/operations/assessmentTranscription.ts` (submit op + reconcile policy).
Tests: `src/lib/__tests__/deepgram.test.js`,
`src/lib/__tests__/assessmentReconcile.test.js`.

## Frontend (PR 3)

`AssessmentsPanel` (`src/features/clients/client/AssessmentsPanel.jsx`) lives in
the client record's Overview tab. Staff can **record** an assessment in-browser
(reuses the BD portal's `VoiceRecorder`) or **upload** an existing audio file.
On capture it: uploads the audio to `assessment-audio/<org_id>/<id>.<ext>`,
inserts the `assessments` row (`status: 'uploaded'`), and calls
`assessment-transcribe`. The panel lists prior assessments with a status badge,
a diarized transcript viewer (speaker-tagged turns), audio playback via an
on-demand signed URL, and a Retry action on failed rows.

Because `assessments` is not in the realtime publication, the panel **polls**
every 8s while any row is in-flight (`uploaded`/`transcribing`) and stops once
all have settled. Pure display/format logic is extracted to
`src/lib/assessmentTranscript.js` and unit-tested in
`src/lib/__tests__/assessmentTranscript.test.js`.

## Required environment variables (Supabase project secrets)

Both are read by `assessment-transcribe`, `deepgram-callback`, and the
reconcile worker:

| Secret | Purpose |
|--------|---------|
| `DEEPGRAM_API_KEY` | Deepgram API key (sent as `Authorization: Token …`). |
| `DEEPGRAM_CALLBACK_SECRET` | Random string embedded in the callback URL and verified by `deepgram-callback`, so only Deepgram's callback (which echoes the URL verbatim) is accepted. |

These hold no per-tenant data, so a single project-level secret is correct for
now. **Real client assessment audio must not be sent to Deepgram until the
BAA is in place.**

## Security notes

- Audio never streams through the edge functions — Deepgram fetches the
  time-limited signed URL directly.
- The callback function is publicly reachable (every function deploys with
  `--no-verify-jwt`) and is protected by `DEEPGRAM_CALLBACK_SECRET` +
  org-scoped `assessment_id`/`org_id` correlation in the URL.
