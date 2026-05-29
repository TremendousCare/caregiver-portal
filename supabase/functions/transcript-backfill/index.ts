// ─────────────────────────────────────────────────────────────────
// Transcript Backfill (one-time recovery)
//
// Recovers call transcripts for calls that ended during the 2026-05-27
// RingSense outage and never got a transcript. During that window the
// post-call cron resolved provider=ringcentral_native, RingSense returned
// 404 for every recording (no license), and after 24h the cron "gave up"
// — it stamped call_sessions.transcript_fetched_at so the row left the
// pending pool, but no transcript was ever produced and no note appended.
// Those rows will never self-heal because the live cron skips anything
// past its 24h give-up window. This function re-transcribes them via the
// org's configured provider (now Whisper) and appends the missing note.
//
// SAFE TO RE-RUN. Idempotent on every axis:
//   - transcribeRecording() checks the call_transcriptions cache first, so
//     a recording transcribed on a previous invocation is not re-billed.
//   - the note append is guarded by hasCallTranscriptNote(), so a profile
//     that already has the note is left untouched.
//
// Targets ONLY "gave up" rows (transcript_fetched_at IS NOT NULL) that are
// matched to a caregiver/client and still lack a cached transcript. Rows
// still in the live pending pool (transcript_fetched_at IS NULL) are left
// to the cron, which handles them within minutes — so the two never race.
//
// Invocation (manual, service-role only):
//   POST /transcript-backfill
//   Authorization: Bearer <SERVICE_ROLE_KEY>
//   body: { "days_back": 14, "limit": 10, "dry_run": true }
//
// Re-invoke until "remaining" reaches 0. Small default batch keeps each
// invocation well under the edge wall-clock limit (Whisper is the slow leg)
// and reuses a single RC access token per batch (RC auth-bucket friendly).
// ─────────────────────────────────────────────────────────────────

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getRingCentralAccessToken } from '../_shared/helpers/ringcentral.ts';
import {
  resolveTranscriptionProvider,
  transcribeRecording,
} from '../_shared/operations/transcribeRecording.ts';
import {
  buildCallTranscriptNote,
  callNoteTimestamp,
  hasCallTranscriptNote,
} from '../_shared/operations/callTranscriptNote.ts';
import { filterUncached } from '../_shared/operations/transcriptBackfillSelect.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? null;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_DAYS_BACK = 14;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
// How many candidate rows to scan per invocation before subtracting the ones
// already transcribed. The real pending pool is ~100-250, so this comfortably
// covers it; the subtraction + slice then yields the next `limit` to process.
const CANDIDATE_CAP = 500;

interface BackfillRow {
  id: string;
  org_id: string;
  recording_id: string;
  matched_entity_type: 'caregiver' | 'client';
  matched_entity_id: string;
  direction: 'inbound' | 'outbound';
  from_e164: string | null;
  to_e164: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

type Outcome =
  | 'note_appended'
  | 'already_had_note'
  | 'no_transcript'   // recording gone from RC, or no speech
  | 'entity_missing'
  | 'failed';

interface RowResult {
  call_session_id: string;
  recording_id: string;
  outcome: Outcome;
  error?: string;
}

// All matched, gave-up, recorded calls in the window — the candidate pool
// before we subtract the ones already transcribed.
async function fetchCandidates(daysBack: number): Promise<BackfillRow[]> {
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const { data, error } = await supabase
    .from('call_sessions')
    .select(
      'id, org_id, recording_id, matched_entity_type, matched_entity_id, direction, from_e164, to_e164, ended_at, duration_seconds',
    )
    .eq('status', 'ended')
    .not('recording_id', 'is', null)
    .not('matched_entity_id', 'is', null)
    .not('transcript_fetched_at', 'is', null)
    .gte('ended_at', cutoff)
    .order('ended_at', { ascending: false })
    .limit(CANDIDATE_CAP);
  if (error) throw new Error(`candidate fetch failed: ${error.message}`);
  return (data || []) as BackfillRow[];
}

// Which of these recording_ids already have a cached transcript.
async function fetchCachedRecordingIds(recordingIds: string[]): Promise<string[]> {
  if (recordingIds.length === 0) return [];
  const { data, error } = await supabase
    .from('call_transcriptions')
    .select('recording_id')
    .in('recording_id', recordingIds);
  if (error) throw new Error(`cached-id fetch failed: ${error.message}`);
  return (data || []).map((r: { recording_id: string }) => r.recording_id);
}

// The genuinely-pending rows: candidates minus those already transcribed.
// Recomputed each invocation, so processed rows drop out and batches advance.
async function loadPending(daysBack: number): Promise<BackfillRow[]> {
  const candidates = await fetchCandidates(daysBack);
  const cached = await fetchCachedRecordingIds(candidates.map((c) => c.recording_id));
  return filterUncached(candidates, cached);
}

async function appendNote(row: BackfillRow, transcript: string): Promise<Outcome> {
  const tableName = row.matched_entity_type === 'client' ? 'clients' : 'caregivers';
  const { data: entity, error: readErr } = await supabase
    .from(tableName)
    .select('notes')
    .eq('id', row.matched_entity_id)
    .single();
  if (readErr || !entity) return 'entity_missing';

  const currentNotes = Array.isArray(entity.notes) ? entity.notes : [];
  if (hasCallTranscriptNote(currentNotes, callNoteTimestamp(row.ended_at))) {
    return 'already_had_note';
  }
  const note = buildCallTranscriptNote(row, transcript);
  const { error: writeErr } = await supabase
    .from(tableName)
    .update({ notes: [...currentNotes, note] })
    .eq('id', row.matched_entity_id);
  if (writeErr) return 'failed';
  return 'note_appended';
}

async function processRow(
  row: BackfillRow,
  rcAccessToken: string,
  provider: Awaited<ReturnType<typeof resolveTranscriptionProvider>>,
): Promise<RowResult> {
  try {
    const result = await transcribeRecording({
      supabase,
      recordingId: row.recording_id,
      rcAccessToken,
      provider,
      openaiApiKey: OPENAI_API_KEY,
    });
    if (!result || !result.transcript) {
      // Recording no longer in RC retention, or contained no speech.
      return { call_session_id: row.id, recording_id: row.recording_id, outcome: 'no_transcript' };
    }
    const outcome = await appendNote(row, result.transcript);
    return { call_session_id: row.id, recording_id: row.recording_id, outcome };
  } catch (err) {
    return {
      call_session_id: row.id,
      recording_id: row.recording_id,
      outcome: 'failed',
      error: (err as Error).message || String(err),
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Access control is the Supabase gateway's JWT verification, the same model
  // every other background job here uses — the cron invokers pass the
  // publishable key, which is what reaches this function. We deliberately do
  // NOT gate on the service-role key: it isn't stored anywhere a cron/SQL
  // caller can read (only project_url + publishable_key are in vault), so a
  // service-role gate would make this function impossible to trigger. This
  // matches post-call-processor, which is likewise gateway-gated and also
  // appends call-transcript notes. Require *an* Authorization header so an
  // unauthenticated direct hit is rejected even if verify_jwt is ever off.
  if (!req.headers.get('Authorization')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const daysBack = Math.max(1, Number(body.days_back) || DEFAULT_DAYS_BACK);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
    const dryRun = body.dry_run === true;

    const pending = await loadPending(daysBack);

    if (dryRun) {
      return new Response(
        JSON.stringify({
          dry_run: true,
          pending_pool: pending.length,
          would_process_next: Math.min(limit, pending.length),
          sample: pending.slice(0, limit).map((r) => ({
            call_session_id: r.id,
            recording_id: r.recording_id,
            matched_entity_type: r.matched_entity_type,
            ended_at: r.ended_at,
          })),
          note: 'pending_pool excludes calls already transcribed; a real run processes `limit` of these per invocation.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const batch = pending.slice(0, limit);
    const results: RowResult[] = [];
    if (batch.length > 0) {
      // One RC token per invocation, shared across the batch — same
      // auth-bucket-friendly pattern the cron uses.
      const rcAccessToken = await getRingCentralAccessToken();
      const provider = await resolveTranscriptionProvider(supabase, batch[0].org_id);
      for (const row of batch) {
        // Rows can span orgs in principle; re-resolve only if it differs.
        const p =
          row.org_id === batch[0].org_id
            ? provider
            : await resolveTranscriptionProvider(supabase, row.org_id);
        results.push(await processRow(row, rcAccessToken, p));
      }
    }

    const tally = (o: Outcome) => results.filter((r) => r.outcome === o).length;
    const pendingAfter = pending.length - tally('note_appended') - tally('already_had_note');
    return new Response(
      JSON.stringify({
        dry_run: false,
        pending_pool_before: pending.length,
        processed: results.length,
        approx_pending_after: Math.max(0, pendingAfter),
        summary: {
          note_appended: tally('note_appended'),
          already_had_note: tally('already_had_note'),
          no_transcript: tally('no_transcript'),
          entity_missing: tally('entity_missing'),
          failed: tally('failed'),
        },
        results,
        hint: pending.length > limit
          ? 'More rows remain — re-invoke to continue.'
          : 'Processed the last of the pending pool (re-run a dry_run to confirm 0 remain).',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[transcript-backfill] fatal:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
