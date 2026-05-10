// Phase 1.1.B — agent_flag toggle wrapper.
//
// Frontend used to call `toggle_agent_flag_v1` directly via
// `supabase.rpc()`. Phase 1.1.B routes that call through this edge
// function so we can dual-write to `agent_actions` (the tamper-
// evident audit log) in the same request, server-side.
//
// Why an edge function (not Postgres):
//   - record_agent_action_v1 takes a pre-computed Ed25519 signature
//   - Postgres can't sign Ed25519 without pgsodium (deferred to SaaS
//     Phase C per the locked plan)
//   - The edge function loads AGENT_ACTIONS_ED25519_SEED from env
//     and signs with Web Crypto
//
// Sequence:
//   1. JWT auth — verify Bearer token, decode org_id claim
//   2. Call toggle_agent_flag_v1 RPC with the user's authenticated
//      session (admin gate enforced by the RPC itself)
//   3. On success, switch to a service-role supabase client and
//      call recordAgentAction (which calls record_agent_action_v1
//      RPC, granted to service_role only)
//   4. Return the toggle result + audit row id (or audit_failed
//      flag if the audit-row write failed but the toggle landed)
//
// Failure modes:
//   - Toggle fails → return error, no audit row attempted
//   - Toggle succeeds, audit fails → return success with
//     audit_failed=true. The frontend shows a toast saying "toggle
//     applied but audit log write failed; chain may show a gap."
//     The verifier will surface the discrepancy as an unmatched
//     events row vs missing agent_actions row in 1.1.C.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

import { recordAgentAction, AgentActionPhase } from '../_shared/operations/agentActions.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  || Deno.env.get('SUPABASE_ANON_KEY_SECRET');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestBody {
  agent_id?: string;
  flag?:     'kill_switch' | 'shadow_mode' | 'read_only_mode';
  value?:    boolean;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── 1. JWT auth ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse(401, { error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');

    // User-context client (anon-keyed, JWT in Authorization header)
    // for the toggle call. The RPC's admin gate runs against this
    // session.
    const supabaseAuth = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }

    const orgId = decodeOrgIdFromJwt(token);
    if (!orgId) {
      return jsonResponse(403, {
        error: 'JWT is missing org_id claim. Confirm the SaaS-retrofit access token hook is enabled.',
      });
    }

    // ── 2. Validate body ──
    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }
    if (!body.agent_id || typeof body.agent_id !== 'string') {
      return jsonResponse(400, { error: 'agent_id required' });
    }
    if (
      body.flag !== 'kill_switch' &&
      body.flag !== 'shadow_mode' &&
      body.flag !== 'read_only_mode'
    ) {
      return jsonResponse(400, {
        error: 'flag must be kill_switch, shadow_mode, or read_only_mode',
      });
    }
    if (typeof body.value !== 'boolean') {
      return jsonResponse(400, { error: 'value must be a boolean' });
    }

    // ── 3. Call the toggle RPC under the user's session. The RPC's
    //       admin gate (public.is_admin()) catches non-admins. ──
    const { data: newValue, error: rpcErr } = await supabaseAuth.rpc('toggle_agent_flag_v1', {
      p_agent_id: body.agent_id,
      p_flag:     body.flag,
      p_value:    body.value,
    });

    if (rpcErr) {
      return jsonResponse(rpcErr.code === '42501' ? 403 : 500, {
        error: rpcErr.message || 'toggle_agent_flag_v1 failed',
        code:  rpcErr.code,
      });
    }

    // ── 4. Service-role client for the audit-log write. The
    //       record_agent_action_v1 RPC is granted to service_role
    //       only (Codex P1 #2 fix). ──
    const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // We need the agent_id and current version for the audit row.
    // Read after the toggle so the version reflects post-toggle
    // state — but toggles don't bump version per locked D4, so it's
    // the same number we'd have read pre-toggle. Either way, single
    // SELECT under service_role.
    const { data: agentRow, error: agentErr } = await supabaseService
      .from('agents')
      .select('id, version')
      .eq('id', body.agent_id)
      .maybeSingle();

    let auditFailed = false;
    let auditId: string | undefined;
    if (agentErr || !agentRow) {
      auditFailed = true;
      console.error('[agent-flag-toggle] agent lookup for audit failed:', agentErr);
    } else {
      const userEmail = (user.email || '').toLowerCase();
      const phase: AgentActionPhase = body.value ? 'executed' : 'rejected';
      // ^ "executed" when enabling a flag, "rejected" when disabling.
      //   Locked phase vocabulary doesn't have a "toggled_off" so we
      //   reuse "rejected" to mean "operator chose to undo this
      //   capability." Document in the spec doc.
      const result = await recordAgentAction(supabaseService, {
        orgId,
        agentId:      body.agent_id,
        agentVersion: agentRow.version,
        actionType:   'agent_flag_toggled',
        phase,
        entityType:   null,
        entityId:     null,
        actor:        `user:${userEmail || user.id}`,
        payload: {
          flag:      body.flag,
          new_value: body.value,
          source:    'settings_ui',
        },
        outcomeId: null,
      });
      if (!result.success) {
        auditFailed = true;
        console.error('[agent-flag-toggle] audit write failed:', result.error);
      } else {
        auditId = result.id;
      }
    }

    return jsonResponse(200, {
      success:       true,
      new_value:     newValue,
      audit_id:      auditId,
      audit_failed:  auditFailed,
    });
  } catch (err) {
    console.error('[agent-flag-toggle] error:', err);
    return jsonResponse(500, { error: (err as Error).message || 'internal error' });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function decodeOrgIdFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.org_id === 'string' && payload.org_id.length > 0
      ? payload.org_id
      : null;
  } catch {
    return null;
  }
}
