# Call Transcription Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add on-demand call transcription via OpenAI Whisper API with DB caching, UI in both caregiver and client activity logs, and an AI chat tool.

**Architecture:** Single Edge Function (`call-transcription`) downloads audio from RingCentral, sends to Whisper API, caches in `call_transcriptions` table. Frontend shows a "Transcript" button that fetches and displays text in a collapsible inline panel. AI chat gets a new `get_call_transcription` tool.

**Tech Stack:** Supabase Edge Functions (Deno), OpenAI Whisper API, React, Vitest

**Design Doc:** `docs/plans/2026-02-20-call-transcription-design.md`

---

### Task 1: Create feature branch

**Step 1: Create and switch to feature branch**

Run: `git checkout -b feature/call-transcription`
Expected: `Switched to a new branch 'feature/call-transcription'`

---

### Task 2: Create `call_transcriptions` database table

**Files:**
- Database migration via Supabase MCP

**Step 1: Apply migration**

Use `apply_migration` with project_id `zocrnurvazyxdpyqimgj`:

```sql
-- Create call_transcriptions cache table
CREATE TABLE IF NOT EXISTS call_transcriptions (
  recording_id text PRIMARY KEY,
  transcript text NOT NULL,
  duration_seconds integer,
  language text DEFAULT 'en',
  created_at timestamptz DEFAULT now()
);

-- RLS: all authenticated can read, service_role inserts
ALTER TABLE call_transcriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read transcriptions"
  ON call_transcriptions FOR SELECT
  TO authenticated
  USING (true);

-- service_role bypasses RLS by default, no INSERT policy needed for it
```

**Step 2: Verify table exists**

Run `execute_sql`: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'call_transcriptions' ORDER BY ordinal_position;`

Expected: 5 columns — recording_id (text), transcript (text), duration_seconds (integer), language (text), created_at (timestamp with time zone)

---

### Task 3: Add `buildTranscriptionUrl` helper + tests (TDD)

**Files:**
- Modify: `src/lib/recording.js:15` (append new function)
- Modify: `src/lib/__tests__/recording.test.js:38` (append new tests)

**Step 1: Write the failing tests**

Append to `src/lib/__tests__/recording.test.js`:

```javascript
import { buildTranscriptionUrl } from '../recording';

describe('buildTranscriptionUrl', () => {
  it('builds a URL with recordingId and token params', () => {
    const url = buildTranscriptionUrl('123456', 'test-token-abc');
    expect(url).toContain('recordingId=123456');
    expect(url).toContain('token=test-token-abc');
    expect(url).toContain('/functions/v1/call-transcription?');
  });

  it('encodes special characters in recordingId', () => {
    const url = buildTranscriptionUrl('12 34', 'token');
    expect(url).toContain('recordingId=12%2034');
  });

  it('encodes special characters in token', () => {
    const url = buildTranscriptionUrl('123', 'tok=en+val');
    expect(url).toContain('token=tok%3Den%2Bval');
  });

  it('handles a typical numeric recording ID', () => {
    const url = buildTranscriptionUrl('9876543210', 'eyJhbGciOiJIUzI1NiJ9.test');
    expect(url).toContain('recordingId=9876543210');
    expect(url).toContain('token=eyJhbGciOiJIUzI1NiJ9.test');
  });

  it('preserves empty string token', () => {
    const url = buildTranscriptionUrl('123', '');
    expect(url).toContain('token=');
    expect(url).toContain('recordingId=123');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test` from repo root
Expected: FAIL — `buildTranscriptionUrl` is not exported from `../recording`

**Step 3: Write the implementation**

Append to `src/lib/recording.js`:

```javascript
/**
 * Build an authenticated URL for the call-transcription Edge Function.
 *
 * @param {string} recordingId - RingCentral recording ID
 * @param {string} accessToken - Supabase session access token
 * @returns {string} Full URL for transcription fetch
 */
export function buildTranscriptionUrl(recordingId, accessToken) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  return `${supabaseUrl}/functions/v1/call-transcription?recordingId=${encodeURIComponent(recordingId)}&token=${encodeURIComponent(accessToken)}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/lib/recording.js src/lib/__tests__/recording.test.js
git commit -m "feat: add buildTranscriptionUrl helper with tests"
```

---

### Task 4: Create `call-transcription` Edge Function

**Files:**
- Create: `supabase/functions/call-transcription/index.ts`

**Step 1: Create the Edge Function**

Create `supabase/functions/call-transcription/index.ts`:

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Environment Variables ───
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RINGCENTRAL_CLIENT_ID");
const RC_CLIENT_SECRET = Deno.env.get("RINGCENTRAL_CLIENT_SECRET");
const RC_JWT_TOKEN = Deno.env.get("RINGCENTRAL_JWT_TOKEN");
const RC_API_URL = "https://platform.ringcentral.com";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ─── RC Auth (same pattern as call-recording) ───

async function getRingCentralAccessToken(): Promise<string> {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT_TOKEN) {
    throw new Error("RingCentral credentials not configured");
  }
  const response = await fetch(`${RC_API_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT_TOKEN,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`RingCentral auth failed: ${error}`);
  }
  const data = await response.json();
  return data.access_token;
}

// ─── Main Handler ───
// Transcribes a RingCentral call recording via OpenAI Whisper API.
// Caches results in call_transcriptions table.
//
// Usage: GET /call-transcription?recordingId=123456&token=<supabase_jwt>

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const recordingId = url.searchParams.get("recordingId");
    const token = url.searchParams.get("token");

    // ── Validate inputs ──

    if (!recordingId) {
      return new Response(
        JSON.stringify({ error: "recordingId query parameter is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!/^\d+$/.test(recordingId)) {
      return new Response(
        JSON.stringify({ error: "Invalid recordingId format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!token) {
      return new Response(
        JSON.stringify({ error: "Authentication required (token parameter)" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Validate Supabase auth token ──

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired authentication token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Check cache first ──

    const { data: cached } = await supabase
      .from("call_transcriptions")
      .select("transcript, duration_seconds, language")
      .eq("recording_id", recordingId)
      .single();

    if (cached) {
      console.log(`[call-transcription] Cache hit for recording ${recordingId}`);
      return new Response(
        JSON.stringify({
          transcript: cached.transcript,
          duration_seconds: cached.duration_seconds,
          language: cached.language,
          cached: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Download recording from RingCentral ──

    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OpenAI API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[call-transcription] Cache miss — downloading recording ${recordingId} from RC`);
    const rcAccessToken = await getRingCentralAccessToken();
    const rcUrl = `${RC_API_URL}/restapi/v1.0/account/~/recording/${recordingId}/content`;

    const rcResponse = await fetch(rcUrl, {
      headers: { Authorization: `Bearer ${rcAccessToken}` },
    });

    if (!rcResponse.ok) {
      const errText = await rcResponse.text().catch(() => "Unknown error");
      console.error(`[call-transcription] RC fetch failed (${rcResponse.status}):`, errText);
      return new Response(
        JSON.stringify({ error: "Recording not found or unavailable" }),
        {
          status: rcResponse.status === 404 ? 404 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Send to Whisper API ──

    const audioBlob = await rcResponse.blob();
    const contentType = rcResponse.headers.get("Content-Type") || "audio/mpeg";
    const extension = contentType.includes("wav") ? "wav" : contentType.includes("ogg") ? "ogg" : "mp3";

    console.log(`[call-transcription] Sending ${audioBlob.size} bytes to Whisper API`);

    const formData = new FormData();
    formData.append("file", audioBlob, `recording.${extension}`);
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errText = await whisperResponse.text().catch(() => "Unknown error");
      console.error(`[call-transcription] Whisper API failed (${whisperResponse.status}):`, errText);
      return new Response(
        JSON.stringify({ error: "Transcription service failed. Please try again." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const whisperData = await whisperResponse.json();
    const transcript = whisperData.text || "";
    const durationSeconds = whisperData.duration ? Math.round(whisperData.duration) : null;
    const language = whisperData.language || "en";

    console.log(`[call-transcription] Whisper returned ${transcript.length} chars, ${durationSeconds}s, lang=${language}`);

    // ── Cache the result ──

    const { error: insertError } = await supabase
      .from("call_transcriptions")
      .insert({
        recording_id: recordingId,
        transcript,
        duration_seconds: durationSeconds,
        language,
      });

    if (insertError) {
      console.error("[call-transcription] Cache insert failed:", insertError);
      // Don't fail the request — we still have the transcript
    }

    return new Response(
      JSON.stringify({
        transcript,
        duration_seconds: durationSeconds,
        language,
        cached: false,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[call-transcription] Error:", err);
    return new Response(
      JSON.stringify({ error: `Transcription failed: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
```

**Step 2: Commit**

```bash
git add supabase/functions/call-transcription/index.ts
git commit -m "feat: add call-transcription Edge Function (Whisper API + caching)"
```

---

### Task 5: Add transcript UI to ActivityLog.jsx (caregivers)

**Files:**
- Modify: `src/features/caregivers/caregiver/ActivityLog.jsx`

**Step 1: Add import**

Add `buildTranscriptionUrl` to the existing import from `recording.js` (line 3):

```javascript
import { buildRecordingUrl, buildTranscriptionUrl } from '../../../lib/recording';
```

**Step 2: Add transcript state variables**

After line 19 (`const accessTokenRef = useRef('');`), add:

```javascript
  const [expandedTranscriptId, setExpandedTranscriptId] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(null);
  const [transcriptError, setTranscriptError] = useState(null);
  const transcriptCacheRef = useRef({});
```

**Step 3: Add fetchTranscript handler**

After the `handleAddNote` function (after line 102), add:

```javascript
  const fetchTranscript = async (recordingId) => {
    // Toggle off if already expanded
    if (expandedTranscriptId === recordingId) {
      setExpandedTranscriptId(null);
      return;
    }
    // Return cached transcript
    if (transcriptCacheRef.current[recordingId]) {
      setExpandedTranscriptId(recordingId);
      return;
    }
    // Fetch from Edge Function
    setTranscriptLoading(recordingId);
    setTranscriptError(null);
    try {
      const url = buildTranscriptionUrl(recordingId, accessTokenRef.current);
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Transcription failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      transcriptCacheRef.current[recordingId] = data;
      setExpandedTranscriptId(recordingId);
    } catch (err) {
      console.error('[ActivityLog] Transcript fetch error:', err);
      setTranscriptError(recordingId);
    } finally {
      setTranscriptLoading(null);
    }
  };
```

**Step 4: Add Transcript button in badge row**

Inside the badge row, right after the Play/Stop recording button block (after line 232), add the Transcript button:

```jsx
                    {n.hasRecording && n.recordingId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); fetchTranscript(n.recordingId); }}
                        style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 10,
                          background: expandedTranscriptId === n.recordingId ? '#7C3AED' : '#F3E8FF',
                          color: expandedTranscriptId === n.recordingId ? '#fff' : '#7C3AED',
                          fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                        }}
                        disabled={transcriptLoading === n.recordingId}
                      >
                        {transcriptLoading === n.recordingId ? '⏳ Transcribing...' : expandedTranscriptId === n.recordingId ? '✕ Hide Transcript' : '📝 Transcript'}
                      </button>
                    )}
```

**Step 5: Add transcript panel below audio player**

After the audio player block (after the `recordingError` div, around line 253), add:

```jsx
              {expandedTranscriptId === n.recordingId && transcriptCacheRef.current[n.recordingId] && (
                <div style={{ marginTop: 8, padding: '10px 14px', background: '#FAF5FF', borderRadius: 8, border: '1px solid #E9D5FF', fontSize: 13, lineHeight: 1.6, color: '#374151', whiteSpace: 'pre-wrap' }}>
                  <div style={{ fontSize: 11, color: '#7C3AED', fontWeight: 600, marginBottom: 6 }}>
                    Transcript {transcriptCacheRef.current[n.recordingId].duration_seconds && `(${Math.floor(transcriptCacheRef.current[n.recordingId].duration_seconds / 60)}m ${transcriptCacheRef.current[n.recordingId].duration_seconds % 60}s)`}
                  </div>
                  {transcriptCacheRef.current[n.recordingId].transcript || '(No speech detected)'}
                </div>
              )}
              {transcriptError === n.recordingId && (
                <div style={{ color: '#DC3545', fontSize: 12, marginTop: 4 }}>
                  Failed to transcribe recording. Please try again.
                </div>
              )}
```

**Step 6: Commit**

```bash
git add src/features/caregivers/caregiver/ActivityLog.jsx
git commit -m "feat: add transcript button and collapsible panel to caregiver ActivityLog"
```

---

### Task 6: Add transcript UI to ClientActivityLog.jsx (clients)

**Files:**
- Modify: `src/features/clients/client/ClientActivityLog.jsx`

**Step 1: Add import**

Update line 3 to include `buildTranscriptionUrl`:

```javascript
import { buildRecordingUrl, buildTranscriptionUrl } from '../../../lib/recording';
```

**Step 2: Add transcript state variables**

After line 50 (`const accessTokenRef = useRef('');`), add:

```javascript
  const [expandedTranscriptId, setExpandedTranscriptId] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(null);
  const [transcriptError, setTranscriptError] = useState(null);
  const transcriptCacheRef = useRef({});
```

**Step 3: Add fetchTranscript handler**

After the `handleAddNote` function (after line 162), add the same `fetchTranscript` function as in Task 5 Step 3.

**Step 4: Add Transcript button in badge row**

After the recording playback button (around line 347), add the same Transcript button JSX as Task 5 Step 4, but using `entry.recordingId` instead of `n.recordingId`:

```jsx
                  {entry.hasRecording && entry.recordingId && (
                    <button
                      onClick={(e) => { e.stopPropagation(); fetchTranscript(entry.recordingId); }}
                      style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 10,
                        background: expandedTranscriptId === entry.recordingId ? '#7C3AED' : '#F3E8FF',
                        color: expandedTranscriptId === entry.recordingId ? '#fff' : '#7C3AED',
                        fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      }}
                      disabled={transcriptLoading === entry.recordingId}
                    >
                      {transcriptLoading === entry.recordingId ? '⏳ Transcribing...' : expandedTranscriptId === entry.recordingId ? '✕ Hide Transcript' : '📝 Transcript'}
                    </button>
                  )}
```

**Step 5: Add transcript panel below audio player**

After the audio player block (around line 367), add the same transcript panel JSX as Task 5 Step 5, using `entry.recordingId` instead of `n.recordingId`.

**Step 6: Commit**

```bash
git add src/features/clients/client/ClientActivityLog.jsx
git commit -m "feat: add transcript button and collapsible panel to client ActivityLog"
```

---

### Task 7: Add `get_call_transcription` AI chat tool

**Files:**
- Modify: `supabase/functions/ai-chat/tools/communication.ts` (append after `get_call_recording`)
- Modify: `supabase/functions/ai-chat/config.ts:19` (bump version comment if present)

**Step 1: Add the tool**

Append to `supabase/functions/ai-chat/tools/communication.ts` (after the `get_call_recording` registerTool block at line 291):

```typescript
// ── get_call_transcription (auto) ──

registerTool(
  {
    name: "get_call_transcription",
    description:
      "Get the text transcript of a recorded call using AI speech-to-text. The recording ID can be found in the get_call_log output (shown as [Recorded - ID: 123456]). First-time transcription may take a few seconds; subsequent requests return instantly from cache.",
    input_schema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "The RingCentral recording ID (numeric string from get_call_log output)",
        },
      },
      required: ["recording_id"],
    },
    riskLevel: "auto",
  },
  async (input: any, _ctx: ToolContext): Promise<ToolResult> => {
    const recordingId = input.recording_id;
    if (!recordingId) return { error: "recording_id is required." };

    if (!/^\d+$/.test(recordingId)) {
      return { error: "Invalid recording ID format. Must be numeric." };
    }

    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      // Call the call-transcription Edge Function internally
      const url = `${supabaseUrl}/functions/v1/call-transcription?recordingId=${recordingId}&token=${serviceKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: "Transcription failed" }));
        return { error: errData.error || `Transcription failed (HTTP ${response.status})` };
      }

      const data = await response.json();
      return {
        recording_id: recordingId,
        transcript: data.transcript || "(No speech detected)",
        duration_seconds: data.duration_seconds,
        language: data.language,
        cached: data.cached,
        note: "This is an AI-generated transcript. It may contain minor inaccuracies.",
      };
    } catch (err) {
      console.error("get_call_transcription error:", err);
      return { error: `Failed to transcribe recording: ${(err as Error).message}` };
    }
  },
);
```

**Important note:** The AI chat tool calls the Edge Function using the service role key as the token. The `call-transcription` Edge Function validates tokens via `supabase.auth.getUser()` — the service role key won't pass this validation. We need to add an alternative auth path in the Edge Function for internal calls. See Task 4 addendum below.

**Task 4 Addendum: Add service role auth path**

In `call-transcription/index.ts`, after the user token validation block, add a fallback for service role key:

```typescript
    // ── Validate auth ──
    // Accept either a Supabase user JWT or the service role key (for internal Edge Function calls)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (token === SUPABASE_SERVICE_ROLE_KEY) {
      // Internal call from ai-chat or other Edge Functions — trusted
      console.log("[call-transcription] Authenticated via service role key");
    } else {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired authentication token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
```

**Step 2: Commit**

```bash
git add supabase/functions/ai-chat/tools/communication.ts supabase/functions/call-transcription/index.ts
git commit -m "feat: add get_call_transcription AI chat tool (ai-chat v39)"
```

---

### Task 8: Run tests and build

**Step 1: Run tests**

Run: `npm test`
Expected: ALL PASS (existing + new transcription tests)

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds with no errors

---

### Task 9: Deploy Edge Functions

**Step 1: Deploy call-transcription**

Run: `npx supabase functions deploy call-transcription --no-verify-jwt --project-ref zocrnurvazyxdpyqimgj`
Expected: Deployed successfully

**Step 2: Deploy ai-chat (v39)**

Run: `npx supabase functions deploy ai-chat --no-verify-jwt --project-ref zocrnurvazyxdpyqimgj`
Expected: Deployed successfully

---

### Task 10: Final commit and open PR

**Step 1: Add design doc and plan**

```bash
git add docs/plans/2026-02-20-call-transcription-design.md docs/plans/2026-02-20-call-transcription-plan.md
git commit -m "docs: add call transcription design doc and implementation plan"
```

**Step 2: Push branch**

Run: `git push -u origin feature/call-transcription`

**Step 3: Open PR**

Use `gh pr create` with title "feat: On-demand call transcription via OpenAI Whisper" and body summarizing the changes.

**Step 4: Wait for user approval before merging**

Ask: "Ready to merge?" — NEVER merge without explicit user confirmation.
