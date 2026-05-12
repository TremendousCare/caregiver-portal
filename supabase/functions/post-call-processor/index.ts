// ─────────────────────────────────────────────────────────────────
// Post-Call Processor
//
// Voice / CTI Phase 1 PR 2 — companion to the telephony webhook.
//
// Cron-invoked worker (every minute, see migration
// 20260512000000_post_call_processor_cron.sql) that walks ended
// call_sessions whose recording exists but whose transcript has not
// yet been fetched. For each pending row:
//
//   1. Calls the existing `call-transcription` edge function — which
//      caches the result in call_transcriptions (PK = recording_id)
//      and handles both RC-native and Whisper paths internally.
//   2. Stamps call_sessions.transcript_fetched_at so the partial
//      index `idx_call_sessions_pending_transcript` no longer matches
//      the row. Idempotent on rerun: the call-transcription cache
//      makes a second call cheap, and the row drops out of the index
//      regardless.
//   3. When a caregiver / client is matched, appends a note of
//      `type: 'call'` to the entity's notes array so the call shows
//      up in the timeline alongside SMS/email events — same shape as
//      the SMS webhook's logInboundNote().
//
// Idempotency, retry, and give-up:
//   - Success      → transcript_fetched_at = now(); row leaves the
//                    pending index.
//   - Soft failure → transcript_fetched_at stays NULL; cron retries
//                    next tick (up to RETRY_GIVEUP_HOURS later).
//   - Permanent    → after RETRY_GIVEUP_HOURS since ended_at, mark
//                    transcript_fetched_at anyway so we stop hammering
//                    RC for a recording that's never going to land.
//
// No new env vars. Uses the existing SERVICE_ROLE_KEY for self-calls.
// ─────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = 25;          // per cron tick
const MIN_AGE_SECONDS = 30;     // RC recording surface lag
const RETRY_GIVEUP_HOURS = 24;  // stop trying after a day

interface PendingCallRow {
  id: string;
  org_id: string;
  recording_id: string;
  matched_entity_type: 'caregiver' | 'client' | null;
  matched_entity_id: string | null;
  direction: 'inbound' | 'outbound';
  from_e164: string | null;
  to_e164: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  matched_user_id: string | null;
}

interface ProcessResult {
  call_session_id: string;
  outcome: 'transcribed' | 'note_attached' | 'no_match' | 'gave_up' | 'failed';
  error?: string;
}

async function fetchPending(): Promise<PendingCallRow[]> {
  // Partial index `idx_call_sessions_pending_transcript` matches:
  //   status='ended' AND recording_id IS NOT NULL AND transcript_fetched_at IS NULL
  // We additionally filter by age at query time (not in the predicate,
  // because now() is not IMMUTABLE — see CLAUDE.md Environment Gotchas).
  const cutoff = new Date(Date.now() - MIN_AGE_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from('call_sessions')
    .select(
      'id, org_id, recording_id, matched_entity_type, matched_entity_id, direction, from_e164, to_e164, ended_at, duration_seconds, matched_user_id',
    )
    .eq('status', 'ended')
    .not('recording_id', 'is', null)
    .is('transcript_fetched_at', null)
    .lte('ended_at', cutoff)
    .order('ended_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    throw new Error(`Failed to load pending call_sessions: ${error.message}`);
  }
  return (data || []) as PendingCallRow[];
}

async function fetchTranscript(recordingId: string): Promise<string | null> {
  // call-transcription authenticates via a `token` *query parameter*
  // (not a Bearer header) and explicitly treats SUPABASE_SERVICE_ROLE_KEY
  // as a trusted internal-caller credential. See call-transcription's
  // index.ts for the auth contract. Passing only the Authorization
  // header makes call-transcription return 401, which is what caused
  // "No transcript returned" on every backfilled row in the first
  // post-bugfix run.
  const params = new URLSearchParams({
    recordingId,
    token: SUPABASE_SERVICE_ROLE_KEY,
  });
  const resp = await fetch(
    `${SUPABASE_URL}/functions/v1/call-transcription?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  if (!data) return null;
  const text = (data.transcript || data.text || '') as string;
  return text || null;
}

async function appendCallNote(
  row: PendingCallRow,
  transcript: string,
): Promise<boolean> {
  if (!row.matched_entity_type || !row.matched_entity_id) return false;
  const tableName = row.matched_entity_type === 'client' ? 'clients' : 'caregivers';

  const { data: entity, error: readErr } = await supabase
    .from(tableName)
    .select('notes')
    .eq('id', row.matched_entity_id)
    .single();
  if (readErr || !entity) return false;

  const currentNotes = Array.isArray(entity.notes) ? entity.notes : [];
  const remotePhone = row.direction === 'inbound' ? row.from_e164 : row.to_e164;
  const note = {
    text: transcript,
    type: 'call',
    direction: row.direction,
    source: 'ringcentral',
    timestamp: row.ended_at ? Date.parse(row.ended_at) : Date.now(),
    author: 'Call Transcript',
    outcome: `${row.direction === 'inbound' ? 'Inbound' : 'Outbound'} call${remotePhone ? ' ' + remotePhone : ''}${row.duration_seconds ? ` (${row.duration_seconds}s)` : ''}`,
  };
  const { error: writeErr } = await supabase
    .from(tableName)
    .update({ notes: [...currentNotes, note] })
    .eq('id', row.matched_entity_id);
  return !writeErr;
}

async function markTranscriptFetched(callSessionId: string): Promise<void> {
  await supabase
    .from('call_sessions')
    .update({ transcript_fetched_at: new Date().toISOString() })
    .eq('id', callSessionId);
}

function isPastGiveup(row: PendingCallRow): boolean {
  if (!row.ended_at) return false;
  const ageHours = (Date.now() - Date.parse(row.ended_at)) / 36e5;
  return ageHours > RETRY_GIVEUP_HOURS;
}

async function processOne(row: PendingCallRow): Promise<ProcessResult> {
  try {
    // Give-up path: don't keep retrying forever. Mark and move on.
    if (isPastGiveup(row)) {
      await markTranscriptFetched(row.id);
      return { call_session_id: row.id, outcome: 'gave_up' };
    }

    const transcript = await fetchTranscript(row.recording_id);
    if (!transcript) {
      // Soft failure — leave the row pending, cron will retry next tick.
      return { call_session_id: row.id, outcome: 'failed', error: 'No transcript returned' };
    }

    // Cache the transcription as already-done before attempting the note
    // attach. A note-attach failure mustn't trigger a retry loop on the
    // (much more expensive) transcription call.
    await markTranscriptFetched(row.id);

    if (row.matched_entity_type && row.matched_entity_id) {
      const ok = await appendCallNote(row, transcript);
      return {
        call_session_id: row.id,
        outcome: ok ? 'note_attached' : 'transcribed',
      };
    }
    return { call_session_id: row.id, outcome: 'no_match' };
  } catch (err) {
    return {
      call_session_id: row.id,
      outcome: 'failed',
      error: (err as Error).message || String(err),
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const pending = await fetchPending();
    const results: ProcessResult[] = [];
    for (const row of pending) {
      results.push(await processOne(row));
    }

    return new Response(
      JSON.stringify({
        success: true,
        considered: pending.length,
        summary: {
          transcribed: results.filter((r) => r.outcome === 'transcribed').length,
          note_attached: results.filter((r) => r.outcome === 'note_attached').length,
          no_match: results.filter((r) => r.outcome === 'no_match').length,
          gave_up: results.filter((r) => r.outcome === 'gave_up').length,
          failed: results.filter((r) => r.outcome === 'failed').length,
        },
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[post-call-processor] fatal:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
