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

import { createClient } from 'jsr:@supabase/supabase-js@2';
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

// Phase 1.6.2 — analyser give-up window. A call whose transcript
// landed but which still has ai_summary IS NULL after this many
// hours exits the pending-analysis pool. This stops the cron from
// hammering kill_switched agents forever on calls from the indefinite
// past — the shadow bake only needs new traffic from when the
// kill_switch flips off.
const ANALYSIS_GIVEUP_HOURS = 24;

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

interface AnalysisProcessResult {
  call_session_id: string;
  analyst: 'analysed' | 'shadow' | 'killed' | 'skipped' | 'analyst_error';
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

    if (row.matched_entity_type && row.matched_entity_id) {
      const ok = await appendCallNote(row, transcript);
      return {
        call_session_id: row.id,
        outcome: ok ? 'note_attached' : 'transcribed',
      };
    }
    return { call_session_id: row.id, outcome: 'no_match' };

    // NOTE: The call_analyst extractor is invoked from the SEPARATE
    // pending-analysis pool (see processPendingAnalysis below), not
    // inline here. That separation is the fix for Codex P1
    // #r3251942660 — invoking inline tied the analyst's eligibility
    // to the transcript_fetched_at flip, which permanently excluded
    // calls transcribed while kill_switch was on. The analysis pool's
    // selector is `ai_summary IS NULL AND transcript_fetched_at IS
    // NOT NULL`, which is the idempotency anchor advertised in the
    // 1.6.2 spec.
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
// SEPARATE POOL from the transcript-fetch pool above. After
// transcript_fetched_at is stamped, the row enters the pending-
// analysis pool. The cron picks it up on a subsequent tick and runs
// the extractor agent.
//
//   * kill_switch=true → runAgent returns { status: 'killed' }
//     immediately, no Anthropic call, no DB writes. The row stays
//     in the pending pool. When the owner flips kill_switch OFF,
//     the next cron tick picks up everything in the pool (up to the
//     ANALYSIS_GIVEUP_HOURS window). This is the fix for Codex P1
//     #r3251942660 — the original inline invocation tied the
//     analyst's eligibility to transcript_fetched_at, permanently
//     excluding calls processed while killed.
//   * shadow_mode=true → ai_suggestions write at status='pending'
//     so /agent-grading can show them; agent_actions audit rows
//     stamp phase='shadow' instead of 'executed'.
//
// Idempotency anchor: `call_sessions.ai_summary IS NULL`. A re-run
// on an already-analysed row is skipped by the inner pre-check in
// runCallAnalyst; the cron's selector also filters on this, so
// re-entry is safe under all failure modes.
//
// Give-up: rows older than ANALYSIS_GIVEUP_HOURS exit the pool
// naturally (selector includes `ended_at > now() - interval`). This
// stops the cron from hammering kill-switched agents forever on
// calls from the indefinite past.
// ═══════════════════════════════════════════════════════════════

interface PendingAnalysisRow {
  id:                 string;
  org_id:             string;
  matched_entity_type: 'caregiver' | 'client' | null;
  matched_entity_id:   string | null;
  recording_id:        string | null;
}

async function fetchPendingAnalysis(): Promise<PendingAnalysisRow[]> {
  const giveupCutoff = new Date(
    Date.now() - ANALYSIS_GIVEUP_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from('call_sessions')
    .select(
      'id, org_id, matched_entity_type, matched_entity_id, recording_id',
    )
    .is('ai_summary', null)
    .not('transcript_fetched_at', 'is', null)
    .gte('ended_at', giveupCutoff)
    .order('ended_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    throw new Error(
      `Failed to load pending-analysis call_sessions: ${error.message}`,
    );
  }
  return (data || []) as PendingAnalysisRow[];
}

async function processOneAnalysis(
  row: PendingAnalysisRow,
): Promise<AnalysisProcessResult> {
  const out = await runCallAnalyst(row.id);
  return {
    call_session_id: row.id,
    analyst:         out.analyst,
    analyst_error:   out.analyst_error,
  };
}

interface AnalystOutcome {
  analyst: AnalysisProcessResult['analyst'];
  analyst_error?: string;
}

async function runCallAnalyst(callSessionId: string): Promise<AnalystOutcome> {
  try {
    // Idempotency: re-runs are a no-op if the call has already been
    // analysed. Cheap pre-check before assembling context. The
    // analysis-pending pool already filters on `ai_summary IS NULL`
    // but a row could have been analysed by a concurrent worker
    // between selection and this call.
    const { data: existing } = await supabase
      .from('call_sessions')
      .select('ai_summary')
      .eq('id', callSessionId)
      .maybeSingle();
    if (existing?.ai_summary) {
      return { analyst: 'skipped' };
    }

    const session = await loadCallSessionContext(supabase, callSessionId);
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
    // ─── Pool 1 — transcript-pending ───
    const pending = await fetchPending();
    const results: ProcessResult[] = [];
    for (const row of pending) {
      results.push(await processOne(row));
    }

    // ─── Pool 2 — analysis-pending (Phase 1.6.2) ───
    // Separate selector so the analyst can retry across cron ticks
    // when kill_switch flips OFF mid-bake. Existence in this pool is
    // strictly gated by `ai_summary IS NULL` — re-runs of analysed
    // rows are excluded at the DB layer.
    const pendingAnalysis = await fetchPendingAnalysis();
    const analysisResults: AnalysisProcessResult[] = [];
    for (const row of pendingAnalysis) {
      analysisResults.push(await processOneAnalysis(row));
    }

    return new Response(
      JSON.stringify({
        success: true,
        considered:           pending.length,
        considered_analysis:  pendingAnalysis.length,
        summary: {
          transcribed: results.filter((r) => r.outcome === 'transcribed').length,
          note_attached: results.filter((r) => r.outcome === 'note_attached').length,
          no_match: results.filter((r) => r.outcome === 'no_match').length,
          gave_up: results.filter((r) => r.outcome === 'gave_up').length,
          failed: results.filter((r) => r.outcome === 'failed').length,
          analysed: analysisResults.filter((r) => r.analyst === 'analysed').length,
          shadow: analysisResults.filter((r) => r.analyst === 'shadow').length,
          analyst_killed: analysisResults.filter((r) => r.analyst === 'killed').length,
          analyst_skipped: analysisResults.filter((r) => r.analyst === 'skipped').length,
          analyst_error: analysisResults.filter((r) => r.analyst === 'analyst_error').length,
        },
        results,
        analysis_results: analysisResults,
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
