// Phase 1.1.C — agent_actions NDJSON export.
//
// Streams the audit log as newline-delimited JSON, one row per line.
// Each line is a row + verification metadata so the consumer can
// distinguish verified rows from broken-chain ones without re-running
// the full verifier themselves.
//
// Query params:
//   ?agent_id=<uuid>        — optional. Filter the OUTPUT to a single agent.
//   ?from=<iso>             — optional. Inclusive lower bound on created_at.
//   ?to=<iso>               — optional. Inclusive upper bound on created_at.
//   ?limit=<n>              — optional. Cap output to the most recent N (after
//                             filter); default + max 10000.
//
// Auth (Codex P1 on PR #303): requires the service-role key as the
// Bearer token. We compare against SUPABASE_SERVICE_ROLE_KEY directly.
// Any authenticated user JWT (which Supabase's default JWT verification
// would otherwise accept) is rejected with 403. This endpoint dumps
// the full audit chain including signatures and payloads — only the
// cron + scripted admin exports should reach it.
//
// Verification semantics (Codex P2 on PR #303): the verifier ALWAYS
// runs against the full chain for the org, regardless of output
// filters. Otherwise filtered exports would falsely report
// `broken_chain_link` for rows whose predecessor was filtered out.
// We then apply the output filters when streaming. A safety cap on
// total chain size (VERIFY_CAP) prevents OOM on a future huge org;
// chunked verification is a follow-up if it ever matters.

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
const VERIFY_CAP = 50000;  // hard cap on full-chain verification; bigger chains need a chunked verifier

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

    // Codex P1 on PR #303: explicit auth gate. Reject anything that
    // isn't the service-role key. Even Supabase's default JWT
    // verification accepts authenticated user JWTs; we need stricter
    // here because the export bypasses RLS and dumps signatures +
    // payloads.
    const authHeader = req.headers.get('Authorization') || '';
    const presentedToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!presentedToken || presentedToken !== SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(403, {
        error: 'service-role key required for agent_actions export',
      });
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

    // ── Verification step (Codex P2 on PR #303) ──
    //
    // Verification ALWAYS runs against the full chain for the org,
    // regardless of output filters. If we verified only the filtered
    // subset, rows whose predecessors were filtered out would be
    // reported as 'broken_chain_link' even when the chain is intact.
    //
    // Safety: count first; refuse if the chain exceeds VERIFY_CAP
    // rather than silently truncating. Future chunked-verification
    // implementation can lift this cap.
    const { count: chainCount, error: countErr } = await supabase
      .from('agent_actions')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);
    if (countErr) {
      throw new Error(`agent_actions count failed: ${countErr.message}`);
    }
    if ((chainCount ?? 0) > VERIFY_CAP) {
      return jsonResponse(413, {
        error: `Chain too large for inline verification (${chainCount} rows > ${VERIFY_CAP} cap). Use a chunked verifier — not yet implemented.`,
      });
    }

    // Load the FULL chain for the org in chain order.
    const { data: allRows, error: readErr } = await supabase
      .from('agent_actions')
      .select('id, chain_seq, org_id, agent_id, agent_version, action_type, phase, entity_type, entity_id, actor, payload, outcome_id, created_at, prev_hash, row_hash, signature')
      .eq('org_id', orgId)
      .order('chain_seq', { ascending: true });
    if (readErr) {
      throw new Error(`agent_actions read failed: ${readErr.message}`);
    }

    const verifyKey = await deriveVerifyKeyFromSeed(hexToBytes(SIGNING_SEED_HEX));
    const report = await verifyAgentActionsChain(
      (allRows || []) as AgentActionRow[],
      verifyKey,
      orgId,
    );

    // Build a per-row verification map for O(1) annotation. Errors
    // come from the full-chain walk so a filtered output still has
    // accurate per-row verified status.
    const errorByRowId = new Map<string, { reason: string; detail: string }>();
    for (const e of report.errors) {
      errorByRowId.set(e.row_id, { reason: e.reason, detail: e.detail });
    }

    // ── Output filter step (purely about which rows to stream) ──
    let outputRows = (allRows || []) as AgentActionRow[];
    if (agentId) outputRows = outputRows.filter(r => r.agent_id === agentId);
    if (fromIso) outputRows = outputRows.filter(r => r.created_at >= fromIso);
    if (toIso)   outputRows = outputRows.filter(r => r.created_at <= toIso);
    // Limit takes the most recent N (matches typical export UX —
    // "give me the last 1000 audit rows for this agent").
    if (outputRows.length > limit) {
      outputRows = outputRows.slice(outputRows.length - limit);
    }

    // Stream NDJSON. Each line is { row, verified, error? }.
    // Header line summarises the FULL-CHAIN verification result
    // (so the consumer sees overall integrity even when their
    // filter is narrow) plus the OUTPUT-row count (after filter).
    const encoder = new TextEncoder();
    const outputRowCount = outputRows.length;
    const stream = new ReadableStream({
      async start(controller) {
        const header = {
          export_meta: {
            org_id:      orgId,
            agent_id:    agentId,
            from:        fromIso,
            to:          toIso,
            limit,
            // Full-chain verification stats (always computed against
            // the unfiltered chain for the org).
            chain_total_rows:     report.total_rows,
            chain_verified_rows:  report.verified,
            first_break_at:       report.first_break_at,
            first_break_reason:   report.first_break_reason,
            // Filtered output count.
            output_rows:          outputRowCount,
            generated_at:         new Date().toISOString(),
          },
        };
        controller.enqueue(encoder.encode(JSON.stringify(header) + '\n'));

        for (const row of outputRows) {
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

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
