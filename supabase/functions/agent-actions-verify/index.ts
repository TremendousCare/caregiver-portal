// Phase 1.1.B — agent_actions chain verifier edge function.
//
// Daily cron target. Reads every agent_actions row (per org),
// recomputes hashes, verifies signatures, and either returns a
// clean report or writes a `events` row with
// event_type='agent_actions_chain_break' so the break shows up in
// monitoring dashboards.
//
// Invocation:
//   GET /functions/v1/agent-actions-verify
//     → verifies the chain for the default org (Tremendous Care)
//   POST /functions/v1/agent-actions-verify with body { org_id }
//     → verifies the named org (multi-org rollout in SaaS Phase B5+)
//
// The cron job calls the GET form. Manual invocation can use either.
//
// Returns 200 with a JSON report on success or break detection. Only
// 5xx if the function itself fails (e.g. env var missing).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  AgentActionRow,
  verifyAgentActionsChain,
  deriveVerifyKeyFromSeed,
} from '../_shared/operations/agentActionsVerify.ts';
import { hexToBytes } from '../_shared/operations/agentActionsCrypto.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SIGNING_SEED_HEX = Deno.env.get('AGENT_ACTIONS_ED25519_SEED');

const DEFAULT_ORG_SLUG = 'tremendous-care';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!SIGNING_SEED_HEX) {
      throw new Error('AGENT_ACTIONS_ED25519_SEED env var is not set');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Resolve org. POST body wins; otherwise default org.
    let orgId: string | null = null;
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body && typeof body.org_id === 'string') orgId = body.org_id;
      } catch { /* empty body fine */ }
    }
    if (!orgId) {
      orgId = await resolveDefaultOrgId(supabase);
      if (!orgId) {
        throw new Error(`Could not resolve default org_id (slug='${DEFAULT_ORG_SLUG}')`);
      }
    }

    // Load every row for this org in chain order. We walk by
    // chain_seq (a strictly monotonic IDENTITY column added in
    // 20260510090000) to avoid the false-break issue where two
    // rows in the same millisecond sort by random UUID id and
    // disagree with insertion order. Codex P1 on PR #302.
    const { data: rows, error } = await supabase
      .from('agent_actions')
      .select('id, chain_seq, org_id, agent_id, agent_version, action_type, phase, entity_type, entity_id, actor, payload, outcome_id, created_at, prev_hash, row_hash, signature')
      .eq('org_id', orgId)
      .order('chain_seq', { ascending: true });

    if (error) {
      throw new Error(`agent_actions read failed: ${error.message}`);
    }

    const verifyKey = await deriveVerifyKeyFromSeed(hexToBytes(SIGNING_SEED_HEX));
    const report = await verifyAgentActionsChain(
      (rows || []) as AgentActionRow[],
      verifyKey,
      orgId,
    );

    // If the chain is broken, write an alert event so monitoring
    // surfaces it. event_type='agent_actions_chain_break' is a new
    // string but the events table doesn't constrain event_type so
    // it's fine to introduce here.
    if (report.first_break_at !== null) {
      try {
        await supabase.from('events').insert({
          org_id: orgId,
          event_type: 'agent_actions_chain_break',
          actor: 'system:agent-actions-verify',
          payload: {
            first_break_at: report.first_break_at,
            first_break_reason: report.first_break_reason,
            total_rows: report.total_rows,
            verified: report.verified,
            errors: report.errors.slice(0, 10), // cap event payload size
          },
        });
      } catch (logErr) {
        console.error('[agent-actions-verify] failed to log chain break event:', logErr);
      }
    }

    return new Response(
      JSON.stringify({ success: true, report }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[agent-actions-verify] error:', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message || String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

async function resolveDefaultOrgId(supabase: any): Promise<string | null> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', DEFAULT_ORG_SLUG)
    .maybeSingle();
  if (error || !data) return null;
  return data.id || null;
}
