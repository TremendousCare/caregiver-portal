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
//   1. Resolves the org's transcription_provider preference from
//      communication_voice_config (RingSense native vs OpenAI Whisper
//      vs both-with-fallback) and calls the shared transcribeRecording
//      operation directly — same op that backs the call-transcription
//      HTTP endpoint, so cache + provider semantics are identical
//      across both entry points. The op caches results in
//      call_transcriptions (PK = recording_id) so a second call for
//      the same recording is cheap.
//   2. Stamps call_sessions.transcript_fetched_at so the partial
//      index `idx_call_sessions_pending_transcript` no longer matches
//      the row. Idempotent on rerun: re-entry hits the cache and the
//      row drops out of the index regardless.
//   3. When a caregiver / client is matched, appends a note of
//      `type: 'call'` to the entity's notes array so the call shows
//      up in the timeline alongside SMS/email events — same shape as
//      the SMS webhook's logInboundNote().
//
// Auth pressure: a single RC access token is minted at the top of
// each cron tick (via the shared cached helper) and reused for every
// recording in the batch. Replaces the previous "HTTP-fetch
// call-transcription per row" pattern which fanned out into one
// /oauth/token POST per row and parked RC's per-extension auth bucket
// in CMN-301 penalty when batches were hot.
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
import { getRingCentralAccessToken } from '../_shared/helpers/ringcentral.ts';
import { isRateLimitError } from '../_shared/operations/rateLimit.ts';
import {
  resolveTranscriptionProvider,
  transcribeRecording,
  type TranscriptionProvider,
} from '../_shared/operations/transcribeRecording.ts';
import {
  buildCallTranscriptNote,
  callNoteTimestamp,
  hasCallTranscriptNote,
} from '../_shared/operations/callTranscriptNote.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? null;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Per-tick batch size. Each transcript-pending row costs at least one
// RingCentral "Heavy" API call (recording download for Whisper, or a
// RingSense insights GET for native). RC caps the Heavy group at 10
// requests / 60s per extension with a 60s penalty, and that same extension
// also serves interactive get-communications reads. A batch of 25 on a
// per-minute cron guaranteed we blew the ceiling every tick and parked the
// bucket in perpetual penalty — which is exactly what blanked the lead
// Messages tab. Keep the batch well under the Heavy ceiling so background
// transcription leaves headroom for interactive reads. Paired with the
// 5-minute cron cadence (migration 20260603100000), worst case is 5 Heavy
// calls per 5 minutes from this worker.
const BATCH_SIZE = 5;           // per cron tick — stay under RC Heavy 10/60s
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
  outcome: 'transcribed' | 'note_attached' | 'no_match' | 'gave_up' | 'failed' | 'rate_limited';
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

// Per-tick transcription context. The cron mints ONE RC access token
// at the top of each batch and resolves the provider ONCE per org, then
// reuses both across every recording in that batch. This is what
// replaces the previous "fetch /call-transcription over HTTP for each
// of 25 rows" pattern, which incurred up to 25 fresh /oauth/token POSTs
// per cron tick and parked the per-extension auth bucket in penalty.
type TranscriptionContext = {
  rcAccessToken: string;
  providerByOrg: Map<string, TranscriptionProvider>;
};

async function buildTranscriptionContext(): Promise<TranscriptionContext> {
  return {
    rcAccessToken: await getRingCentralAccessToken(),
    providerByOrg: new Map(),
  };
}

async function getProviderForOrg(
  ctx: TranscriptionContext,
  orgId: string,
): Promise<TranscriptionProvider> {
  const cached = ctx.providerByOrg.get(orgId);
  if (cached) return cached;
  const provider = await resolveTranscriptionProvider(supabase, orgId);
  ctx.providerByOrg.set(orgId, provider);
  return provider;
}

async function fetchTranscript(
  row: PendingCallRow,
  ctx: TranscriptionContext,
): Promise<string | null> {
  const provider = await getProviderForOrg(ctx, row.org_id);
  // Soft "not ready" returns null. Hard errors (missing RingSense
  // scope, RC 5xx, Whisper auth, etc.) throw — those are caught one
  // level up in processOne's try/catch, which preserves the error
  // message in the per-row outcome so chronic failures are visible
  // in the cron's response payload, not just buried in function logs.
  const result = await transcribeRecording({
    supabase,
    recordingId: row.recording_id,
    rcAccessToken: ctx.rcAccessToken,
    provider,
    openaiApiKey: OPENAI_API_KEY,
  });
  if (!result) return null;
  return result.transcript || null;
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
  // Idempotency: if a transcript note for this exact call is already on the
  // entity, treat it as success without re-appending. Guards against double
  // notes if a row is ever reprocessed (e.g. the backfill and the cron both
  // touch it).
  if (hasCallTranscriptNote(currentNotes, callNoteTimestamp(row.ended_at))) {
    return true;
  }
  const note = buildCallTranscriptNote(row, transcript);
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

async function processOne(
  row: PendingCallRow,
  ctx: TranscriptionContext,
): Promise<ProcessResult> {
  try {
    // Give-up path: don't keep retrying forever. Mark and move on.
    if (isPastGiveup(row)) {
      await markTranscriptFetched(row.id);
      return { call_session_id: row.id, outcome: 'gave_up' };
    }

    const transcript = await fetchTranscript(row, ctx);
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
    const message = (err as Error).message || String(err);
    // A 429 / CMN-301 means RC's shared per-extension bucket is in its
    // penalty interval. The transcript is NOT lost — the row stays pending
    // (transcript_fetched_at untouched) and a later tick retries. We surface
    // this as its own outcome so the batch loop can STOP immediately rather
    // than firing the rest of the batch into a bucket that will reject every
    // one of them and extend the penalty.
    if (isRateLimitError(err)) {
      return { call_session_id: row.id, outcome: 'rate_limited', error: message };
    }
    return {
      call_session_id: row.id,
      outcome: 'failed',
      error: message,
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
      cost: {
        input_tokens:  result.cost.input_tokens,
        output_tokens: result.cost.output_tokens,
        duration_ms:   result.cost.duration_ms,
        model:         result.agent.model || null,
      },
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
    // Build the transcription context BEFORE the loop so we mint exactly
    // one RC access token per cron tick and share it across every
    // recording in the batch. Previously each row spawned an HTTP fetch
    // to call-transcription, which in turn did its own /oauth/token POST
    // — up to 25 fresh auths per tick against RC's 5-req/60s ceiling,
    // which is what was parking the per-extension auth bucket in
    // CMN-301 penalty.
    const pending = await fetchPending();
    const results: ProcessResult[] = [];
    if (pending.length > 0) {
      let transcriptionCtx: TranscriptionContext | null = null;
      try {
        transcriptionCtx = await buildTranscriptionContext();
      } catch (err) {
        // RC auth itself failed — skip the whole transcript pool this
        // tick rather than burning per-row retries. Rows stay pending,
        // next tick will retry the auth.
        console.warn(
          '[post-call-processor] could not mint RC token for transcription batch:',
          (err as Error).message || err,
        );
      }
      if (transcriptionCtx) {
        for (const row of pending) {
          const result = await processOne(row, transcriptionCtx);
          results.push(result);
          // Circuit-breaker: the moment RC's per-extension bucket signals a
          // rate-limit penalty, stop the batch. Every remaining row would
          // hit the same in-penalty bucket and 429 too, which only prolongs
          // the penalty and starves interactive reads. The unprocessed rows
          // stay pending and the next (5-min-spaced) tick picks them up.
          if (result.outcome === 'rate_limited') {
            console.warn(
              `[post-call-processor] RC rate limit hit; halting transcript batch after ${results.length}/${pending.length} rows. Remaining rows stay pending for the next tick.`,
            );
            break;
          }
        }
      } else {
        for (const row of pending) {
          results.push({
            call_session_id: row.id,
            outcome: 'failed',
            error: 'RC auth unavailable',
          });
        }
      }
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
          rate_limited: results.filter((r) => r.outcome === 'rate_limited').length,
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
