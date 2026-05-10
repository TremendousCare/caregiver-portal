// Phase 1.1.C — agent_actions NDJSON export.
//
// Streams the audit log as newline-delimited JSON, one row per line.
// Each line is a row + verification metadata so the consumer can
// distinguish verified rows from broken-chain ones without re-running
// the full verifier themselves.
//
// Query params:
//   ?agent_id=<uuid>        — optional. Filter to a single agent.
//   ?from=<iso>             — optional. Inclusive lower bound on created_at.
//   ?to=<iso>               — optional. Inclusive upper bound on created_at.
//   ?limit=<n>              — optional. Cap result count (default + max 10000).
//
// Auth: requires the service-role key (this returns the entire audit
// log including signatures, which is sensitive). The caller is
// expected to be either the cron job or an admin running an export
// from a one-off script.

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
const DEFAULT_LIMIT = 10000;
const MAX_LIMIT = 10000;

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
    const url = new URL(req.url);

    const agentId = url.searchParams.get('agent_id');
    const fromIso = url.searchParams.get('from');
    const toIso   = url.searchParams.get('to');
    const limitRaw = url.searchParams.get('limit');
    const limit = clampLimit(limitRaw);

    // Determine org. POST body wins (matches the verifier endpoint
    // pattern); GET defaults to Tremendous Care until SaaS Phase B5+
    // makes per-org explicit.
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

    // Build the base query. We always order by chain_seq ASC so the
    // verifier can walk the result in chain order — even when the
    // user filtered by agent_id (which means we're verifying a
    // SUBSET of the chain; some prev_hash links will reference
    // rows outside the filter, and we report those as
    // 'broken_chain_link' with detail "out_of_filter" so the
    // consumer can distinguish "real corruption" from "filtered
    // out".
    let query = supabase
      .from('agent_actions')
      .select('id, chain_seq, org_id, agent_id, agent_version, action_type, phase, entity_type, entity_id, actor, payload, outcome_id, created_at, prev_hash, row_hash, signature')
      .eq('org_id', orgId)
      .order('chain_seq', { ascending: true })
      .limit(limit);

    if (agentId)  query = query.eq('agent_id', agentId);
    if (fromIso)  query = query.gte('created_at', fromIso);
    if (toIso)    query = query.lte('created_at', toIso);

    const { data: rows, error } = await query;
    if (error) {
      throw new Error(`agent_actions read failed: ${error.message}`);
    }

    const verifyKey = await deriveVerifyKeyFromSeed(hexToBytes(SIGNING_SEED_HEX));

    // Run the verifier across the (filtered) rows. The verifier
    // expects rows in chain_seq ASC order — already done above.
    // For filtered exports the chain may have apparent breaks at
    // filter boundaries; the consumer needs to know which.
    const report = await verifyAgentActionsChain(
      (rows || []) as AgentActionRow[],
      verifyKey,
      orgId,
    );

    // Build a per-row verification map for O(1) annotation as we stream.
    const errorByRowId = new Map<string, { reason: string; detail: string }>();
    for (const e of report.errors) {
      errorByRowId.set(e.row_id, { reason: e.reason, detail: e.detail });
    }

    // Stream NDJSON. Each line is { row, verified, error? }.
    // Begin with a header line summarising the export so the
    // consumer can validate the boundary without scanning every
    // row.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const header = {
          export_meta: {
            org_id:      orgId,
            agent_id:    agentId,
            from:        fromIso,
            to:          toIso,
            limit,
            total_rows:  report.total_rows,
            verified:    report.verified,
            first_break_at:     report.first_break_at,
            first_break_reason: report.first_break_reason,
            generated_at: new Date().toISOString(),
          },
        };
        controller.enqueue(encoder.encode(JSON.stringify(header) + '\n'));

        for (const row of (rows || []) as AgentActionRow[]) {
          const err = errorByRowId.get(row.id);
          const line = {
            row,
            verified: !err,
            ...(err ? { error: err } : {}),
          };
          controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="agent-actions-${orgId}-${nowFileSlug()}.ndjson"`,
      },
    });
  } catch (err) {
    console.error('[agent-actions-export] error:', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message || String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function resolveDefaultOrgId(supabase: any): Promise<string | null> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', DEFAULT_ORG_SLUG)
    .maybeSingle();
  if (error || !data) return null;
  return data.id || null;
}

function nowFileSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}
