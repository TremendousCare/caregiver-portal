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
import { runAgent } from '../_shared/operations/agentRuntime.ts';
import {
  loadCallSessionContext,
  fetchCallTranscriptContext,
  fetchCallTaxonomyContext,
  fetchEntityMemoriesForCall,
  fetchCallEntityIdentity,
} from '../_shared/operations/agentRuntime/callContext.ts';
import { persistCallAnalysis } from '../_shared/operations/agentRuntime/persistCallAnalysis.ts';

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
  /** Phase 1.6.2: call_analyst invocation outcome, if attempted. */
  analyst?: 'analysed' | 'shadow' | 'killed' | 'skipped' | 'analyst_error';
  analyst_error?: string;
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

    let noteOutcome: ProcessResult['outcome'] = 'transcribed';
    if (row.matched_entity_type && row.matched_entity_id) {
      const ok = await appendCallNote(row, transcript);
      noteOutcome = ok ? 'note_attached' : 'transcribed';
    } else {
      noteOutcome = 'no_match';
    }

    // ─── Phase 1.6.2: invoke the call_analyst extractor ───
    const analyst = await runCallAnalyst(row);
    return {
      call_session_id: row.id,
      outcome:         noteOutcome,
      analyst:         analyst.analyst,
      analyst_error:   analyst.analyst_error,
    };
  } catch (err) {
    return {
      call_session_id: row.id,
      outcome: 'failed',
      error: (err as Error).message || String(err),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1.6.2 — call_analyst integration
//
// After the transcript is fetched + the note appended, the
// extractor agent reads the transcript + matched-entity context
// + active call_taxonomy and emits a single structured-output tool
// call. The runtime handles kill_switch / shadow_mode:
//   * kill_switch=true → returns { status: 'killed' } immediately,
//     no Anthropic call, no DB writes. Default for the seeded
//     agent; flip via Settings to start the shadow bake.
//   * shadow_mode=true → ai_suggestions still write at status='pending'
//     so /agent-grading can show them; agent_actions audit rows
//     stamp phase='shadow' instead of 'executed'.
//
// Idempotency anchor: `call_sessions.ai_summary IS NULL` ─ a re-run
// on an already-analysed row is a no-op (we skip before invoking
// Anthropic). This is what allows the cron to be safely re-entrant.
// ═══════════════════════════════════════════════════════════════

interface AnalystOutcome {
  analyst: ProcessResult['analyst'];
  analyst_error?: string;
}

async function runCallAnalyst(row: PendingCallRow): Promise<AnalystOutcome> {
  try {
    // Idempotency: re-runs are a no-op if the call has already been
    // analysed. Cheap pre-check before assembling context.
    const { data: existing } = await supabase
      .from('call_sessions')
      .select('ai_summary')
      .eq('id', row.id)
      .maybeSingle();
    if (existing?.ai_summary) {
      return { analyst: 'skipped' };
    }

    // Load the full call session row for the analysis. The
    // PendingCallRow shape doesn't carry every field the helpers
    // want (recording_id is there, but loadCallSessionContext also
    // returns ended_at + duration for prompt formatting). Cheap
    // single-row read.
    const session = await loadCallSessionContext(supabase, row.id);
    if (!session) return { analyst: 'skipped', analyst_error: 'call_session not found' };
    if (!session.org_id) return { analyst: 'skipped', analyst_error: 'call_session missing org_id' };

    // ─── Assemble context blocks (read helpers in callContext.ts) ───
    const [
      identityBlock,
      transcriptBlock,
      taxonomyBlock,
      memoriesBlock,
    ] = await Promise.all([
      fetchCallEntityIdentity(supabase, session.matched_entity_type, session.matched_entity_id),
      fetchCallTranscriptContext(supabase, session.recording_id),
      fetchCallTaxonomyContext(supabase, session.org_id),
      fetchEntityMemoriesForCall(
        supabase,
        session.matched_entity_type,
        session.matched_entity_id,
        { limit: 10, orgId: session.org_id },
      ),
    ]);

    // Transcript missing → nothing meaningful to analyse. This
    // shouldn't happen because we only reach here after the
    // transcript fetch succeeded, but tolerate stale state.
    if (!transcriptBlock) {
      return { analyst: 'skipped', analyst_error: 'transcript missing at analysis time' };
    }

    const contextBlock = [identityBlock, transcriptBlock, memoriesBlock, taxonomyBlock]
      .filter((b) => b && b.length > 0)
      .join("\n\n");

    // Extract the taxonomy slug sets so the handler can validate
    // the model's tool_use response without a second DB query.
    const { data: taxonomyRows } = await supabase
      .from('call_taxonomy')
      .select('axis, slug')
      .eq('org_id', session.org_id)
      .eq('is_active', true);
    const callTypeSlugs: string[] = [];
    const redFlagSlugs:  string[] = [];
    for (const r of taxonomyRows || []) {
      if (r.axis === 'call_type') callTypeSlugs.push(r.slug);
      else if (r.axis === 'red_flag') redFlagSlugs.push(r.slug);
    }

    const result = await runAgent(
      supabase,
      'call_analyst',
      {
        shape: 'extractor',
        extractor: {
          callSessionId:    session.id,
          contextBlock,
          callTypeSlugs,
          redFlagSlugs,
          matchedEntityType: session.matched_entity_type,
          matchedEntityId:   session.matched_entity_id,
          orgId:             session.org_id,
        },
      },
      { orgId: session.org_id },
    );

    if (result.status === 'killed')   return { analyst: 'killed' };
    if (result.status === 'error')    return { analyst: 'analyst_error', analyst_error: result.error?.message };
    if (!result.analysis)             return { analyst: 'analyst_error', analyst_error: 'no analysis returned' };

    const persistResult = await persistCallAnalysis(supabase, {
      callSessionId:    session.id,
      orgId:            session.org_id,
      matchedEntityType: session.matched_entity_type,
      matchedEntityId:   session.matched_entity_id,
      agentId:           result.agent.id,
      agentVersion:      result.agent.version,
      shadowMode:        result.shadow,
      analysis:          result.analysis,
    });

    if (persistResult.errors.length > 0) {
      console.warn('[post-call-processor] persistCallAnalysis errors:',
        JSON.stringify(persistResult.errors));
    }
    return {
      analyst: result.shadow ? 'shadow' : 'analysed',
      analyst_error: persistResult.errors.length > 0
        ? `${persistResult.errors.length} partial-write error(s)`
        : undefined,
    };
  } catch (err) {
    return {
      analyst: 'analyst_error',
      analyst_error: (err as Error).message || String(err),
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
          analysed: results.filter((r) => r.analyst === 'analysed').length,
          shadow: results.filter((r) => r.analyst === 'shadow').length,
          analyst_killed: results.filter((r) => r.analyst === 'killed').length,
          analyst_skipped: results.filter((r) => r.analyst === 'skipped').length,
          analyst_error: results.filter((r) => r.analyst === 'analyst_error').length,
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
