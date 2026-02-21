# Call Transcription via OpenAI Whisper — Design Doc

**Date**: 2026-02-20
**Status**: Approved
**Approach**: Single Edge Function with DB caching (Approach A)

## Overview

On-demand call transcription for recorded RingCentral calls. Users click a "Transcript" button next to the existing Play button. First request transcribes via OpenAI Whisper API and caches the result; subsequent requests return instantly from cache. Available for both caregiver and client calls. AI chatbot can also fetch transcripts to reason about call contents.

**Cost**: ~$0.006/minute of audio, charged once per recording (cached after).

## Architecture

```
Browser (Transcript button)
  → call-transcription Edge Function
    → Check call_transcriptions table (cache hit? return immediately)
    → Cache miss:
      → Download audio from RingCentral API
      → Send to Whisper API (POST /v1/audio/transcriptions)
      → Store in call_transcriptions table
      → Return transcript
```

## 1. Database — `call_transcriptions` table

| Column | Type | Notes |
|--------|------|-------|
| `recording_id` | text, PK | RingCentral recording ID |
| `transcript` | text, NOT NULL | Full transcript text |
| `duration_seconds` | integer, nullable | Audio duration (cost tracking) |
| `language` | text, default `'en'` | Detected/requested language |
| `created_at` | timestamptz, default `now()` | When transcription was created |

**RLS**: All authenticated can SELECT. Only service_role can INSERT.

No FK to caregivers — recording_id is entity-agnostic (works for both caregivers and clients).

## 2. Edge Function — `call-transcription`

**Endpoint**: `GET /call-transcription?recordingId=<id>&token=<supabase_jwt>`

**File**: `supabase/functions/call-transcription/index.ts` (in git)

**Flow**:
1. Validate `recordingId` (numeric only) and `token` (Supabase JWT)
2. Query `call_transcriptions` for cached transcript
3. If cached → return `{ transcript, duration_seconds, language, cached: true }`
4. If not cached:
   - Auth with RingCentral (JWT bearer grant, same as call-recording)
   - Download recording audio from RC API
   - Send to Whisper: `POST https://api.openai.com/v1/audio/transcriptions`, model=whisper-1, multipart form data
   - Insert into `call_transcriptions`
   - Return `{ transcript, duration_seconds, language, cached: false }`

**Errors**: 401 (bad token), 400 (bad recording ID), 502 (RC or Whisper failure)

**Deploy**: `npx supabase functions deploy call-transcription --no-verify-jwt`

## 3. Frontend UI

Both `ActivityLog.jsx` (caregivers) and `ClientActivityLog.jsx` (clients):

**Button**: "Transcript" next to Play button on recorded calls.

**States**:
- Default → "Transcript" button
- Loading → "Transcribing..." with spinner
- Expanded → transcript text panel below call entry, "Hide Transcript" to collapse
- Error → inline error message

**State**:
- `expandedTranscriptId` — which recording's transcript is visible
- `transcriptCache` (useRef) — map of recordingId → text (avoids re-fetch on re-expand)
- `transcriptLoading` — currently fetching recording ID
- `transcriptError` — error per recording

**Helper**: `buildTranscriptionUrl(recordingId, accessToken)` in `src/lib/recording.js`

## 4. AI Chat — `get_call_transcription` tool

Added to `supabase/functions/ai-chat/tools/communication.ts`.

- **Risk**: auto (read-only)
- **Input**: recording_id (string)
- **Output**: transcript text + metadata
- Calls call-transcription Edge Function internally
- Bumps ai-chat to v39 (23 tools)

## 5. Testing

`src/lib/__tests__/transcription.test.js`:
- `buildTranscriptionUrl()` correct URL construction
- Edge cases: missing params

## Deliverables

| Piece | File/Location |
|-------|---------------|
| DB migration | via Supabase MCP |
| Edge Function | `supabase/functions/call-transcription/index.ts` |
| Frontend (caregiver) | `src/features/caregivers/caregiver/ActivityLog.jsx` |
| Frontend (client) | `src/features/clients/client/ClientActivityLog.jsx` |
| URL helper | `src/lib/recording.js` |
| AI Chat tool | `supabase/functions/ai-chat/tools/communication.ts` |
| Tests | `src/lib/__tests__/transcription.test.js` |
| Supabase secret | `OPENAI_API_KEY` (already set) |

**Branch**: `feature/call-transcription` off main, PR when ready.
