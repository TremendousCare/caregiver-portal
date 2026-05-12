// ─────────────────────────────────────────────────────────────────
// RingCentral Telephony Sessions Webhook
//
// Voice / CTI Phase 1 PR 2 — companion to the SMS webhook
// (ringcentral-webhook/index.ts).
//
// Three responsibilities:
//   1. ?action=subscribe  → create / renew the Telephony Sessions
//      webhook subscription against the org's RC account. Status
//      stored on communication_voice_config.webhook_subscription_*.
//   2. POST (no action)   → receive a Telephony Sessions event,
//      dedupe, parse, match phone → entity & extension → user,
//      upsert call_sessions, append to events table. RLS-respecting
//      Realtime broadcast happens automatically via postgres_changes
//      filtered on matched_user_id on the frontend (PR 3).
//   3. validation-token   → RC subscription registration challenge.
//
// No new env vars. JWT comes through communication_voice_config →
// communication_routes via the existing get_route_ringcentral_jwt RPC,
// the same plumbing the SMS webhook uses.
// ─────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  RC_API_URL,
  getRingCentralAccessTokenWithJwt,
} from '../_shared/helpers/ringcentral.ts';
import { logEvent } from '../ai-chat/context/events.ts';
import {
  parseTelephonyEvent,
  type CallEventNormalized,
} from './parse.ts';
import {
  planCallSessionUpsert,
  buildEventDedupeKey,
  type ExistingCallSessionRow,
} from './upsert.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, validation-token',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Phone → entity match (same shape as SMS webhook) ──────────────
// Reuses the same digits-tail comparison so SMS and voice never disagree
// on who is calling. Intentionally inlined rather than imported from the
// SMS webhook so the two paths can evolve independently — if either
// matcher diverges, the inbound SMS log will surface it within a day.

function phoneDigitsTail(phone: string): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

async function matchPhoneToEntity(
  orgId: string,
  phone: string | null,
): Promise<{
  entityType: 'caregiver' | 'client' | null;
  entityId: string | null;
}> {
  if (!phone) return { entityType: null, entityId: null };
  const tail = phoneDigitsTail(phone);
  if (tail.length < 10) return { entityType: null, entityId: null };

  // Caregivers take precedence — matches the SMS webhook's read order.
  const { data: caregivers } = await supabase
    .from('caregivers')
    .select('id, phone')
    .eq('org_id', orgId)
    .eq('archived', false);

  if (caregivers) {
    for (const cg of caregivers) {
      if (cg.phone && phoneDigitsTail(cg.phone) === tail) {
        return { entityType: 'caregiver', entityId: String(cg.id) };
      }
    }
  }

  const { data: clients } = await supabase
    .from('clients')
    .select('id, phone')
    .eq('org_id', orgId)
    .eq('archived', false);

  if (clients) {
    for (const cl of clients) {
      if (cl.phone && phoneDigitsTail(cl.phone) === tail) {
        return { entityType: 'client', entityId: String(cl.id) };
      }
    }
  }

  return { entityType: null, entityId: null };
}

// ─── Extension → user ──────────────────────────────────────────────

async function resolveExtensionUser(
  orgId: string,
  extensionId: string | null,
): Promise<string | null> {
  if (!extensionId) return null;
  const { data, error } = await supabase
    .from('org_memberships')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('ringcentral_extension_id', extensionId)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].user_id as string;
}

// ─── Known-extension cache (small, per cold start) ─────────────────
// Used by the parser to pick the "right" party out of an RC event with
// multiple parties (eg. a queue forward). Cheap to refresh — at most
// one membership query per cold start.
let _knownExtCache: { fetchedAt: number; ids: Set<string> } | null = null;

async function getKnownExtensionIds(orgId: string): Promise<ReadonlySet<string>> {
  const TTL_MS = 60_000;
  const now = Date.now();
  if (_knownExtCache && now - _knownExtCache.fetchedAt < TTL_MS) {
    return _knownExtCache.ids;
  }
  const { data } = await supabase
    .from('org_memberships')
    .select('ringcentral_extension_id')
    .eq('org_id', orgId)
    .not('ringcentral_extension_id', 'is', null);
  const ids = new Set<string>();
  if (data) {
    for (const row of data) {
      if (row.ringcentral_extension_id) ids.add(String(row.ringcentral_extension_id));
    }
  }
  _knownExtCache = { fetchedAt: now, ids };
  return ids;
}

// ─── Event-table mapping ───────────────────────────────────────────
// Map the call_sessions status into the event_type names the rest of
// the platform consumes (briefing, outcome detection, context layer).

function eventTypeForStatus(
  status: CallEventNormalized['status'],
  direction: 'inbound' | 'outbound',
): string {
  if (status === 'ringing') {
    return direction === 'outbound' ? 'call_outbound_initiated' : 'call_ringing';
  }
  if (status === 'answered') return 'call_answered';
  if (status === 'missed') return 'call_missed';
  if (status === 'voicemail') return 'call_voicemail';
  return 'call_ended';
}

// ─── Voice config & JWT lookup ─────────────────────────────────────

interface VoiceConfigRow {
  org_id: string;
  auth_route_category: string | null;
  webhook_subscription_id: string | null;
}

async function loadVoiceConfigs(): Promise<VoiceConfigRow[]> {
  const { data, error } = await supabase
    .from('communication_voice_config')
    .select('org_id, auth_route_category, webhook_subscription_id');
  if (error) {
    throw new Error(`Failed to load communication_voice_config: ${error.message}`);
  }
  return (data || []) as VoiceConfigRow[];
}

async function getJwtForVoiceConfig(cfg: VoiceConfigRow): Promise<string> {
  // Phase 1 interim: voice reuses the SMS route JWT (see migration header
  // in 20260511000000_voice_phase1_communication_voice_config.sql).
  const category = cfg.auth_route_category;
  if (category) {
    const { data, error } = await supabase.rpc('get_route_ringcentral_jwt', {
      p_category: category,
    });
    if (!error && Array.isArray(data) && data.length > 0 && data[0]?.jwt) {
      return data[0].jwt as string;
    }
  }
  // Last-resort fallback to the legacy env var so existing single-tenant
  // setups still work while Phase C is pending.
  const envJwt = Deno.env.get('RINGCENTRAL_JWT_TOKEN');
  if (envJwt) return envJwt;
  throw new Error(
    `No JWT available for voice config ${cfg.org_id}. Set communication_voice_config.auth_route_category to a configured SMS route.`,
  );
}

// ─── Subscribe / renew ─────────────────────────────────────────────

interface VoiceSubscribeResult {
  org_id: string;
  action: 'created' | 'renewed' | 'failed' | 'skipped';
  subscription_id?: string;
  expires_at?: string;
  error?: string;
}

async function subscribeOneOrg(
  cfg: VoiceConfigRow,
  webhookUrl: string,
): Promise<VoiceSubscribeResult> {
  try {
    if (!cfg.auth_route_category) {
      return {
        org_id: cfg.org_id,
        action: 'skipped',
        error: 'auth_route_category not set on communication_voice_config',
      };
    }

    const jwt = await getJwtForVoiceConfig(cfg);
    const accessToken = await getRingCentralAccessTokenWithJwt(jwt);

    // Try to renew first.
    if (cfg.webhook_subscription_id) {
      const renewResp = await fetch(
        `${RC_API_URL}/restapi/v1.0/subscription/${cfg.webhook_subscription_id}/renew`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (renewResp.ok) {
        const renewData = await renewResp.json();
        await supabase
          .from('communication_voice_config')
          .update({
            webhook_subscription_id: renewData.id,
            webhook_subscription_expires_at: renewData.expirationTime,
            webhook_last_renewed_at: new Date().toISOString(),
          })
          .eq('org_id', cfg.org_id);
        return {
          org_id: cfg.org_id,
          action: 'renewed',
          subscription_id: renewData.id,
          expires_at: renewData.expirationTime,
        };
      }
      // Fall through on any renew failure (404 / expired / etc.)
    }

    // Create a new subscription. Account-level Telephony Sessions filter
    // gives us every extension on the org's RC account in one stream.
    const subResp = await fetch(`${RC_API_URL}/restapi/v1.0/subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        eventFilters: ['/restapi/v1.0/account/~/telephony/sessions'],
        deliveryMode: {
          transportType: 'WebHook',
          address: webhookUrl,
        },
        expiresIn: 630720000, // RC caps at its own max (~7 days)
      }),
    });

    if (!subResp.ok) {
      const errText = await subResp.text();
      throw new Error(`RC telephony subscription create failed (${subResp.status}): ${errText}`);
    }

    const subData = await subResp.json();
    await supabase
      .from('communication_voice_config')
      .update({
        webhook_subscription_id: subData.id,
        webhook_subscription_expires_at: subData.expirationTime,
        webhook_last_renewed_at: new Date().toISOString(),
      })
      .eq('org_id', cfg.org_id);

    return {
      org_id: cfg.org_id,
      action: 'created',
      subscription_id: subData.id,
      expires_at: subData.expirationTime,
    };
  } catch (err) {
    return {
      org_id: cfg.org_id,
      action: 'failed',
      error: (err as Error).message || String(err),
    };
  }
}

async function handleSubscribe(): Promise<Response> {
  try {
    const webhookUrl = `${SUPABASE_URL}/functions/v1/ringcentral-telephony-webhook`;
    const configs = await loadVoiceConfigs();
    if (configs.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            'No communication_voice_config rows. Enable voice in Admin Settings first.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const results: VoiceSubscribeResult[] = [];
    for (const cfg of configs) {
      results.push(await subscribeOneOrg(cfg, webhookUrl));
    }

    const anyFailed = results.some((r) => r.action === 'failed');
    return new Response(
      JSON.stringify({
        success: !anyFailed,
        results,
        summary: {
          total: results.length,
          subscribed: results.filter((r) => r.action === 'created' || r.action === 'renewed').length,
          skipped: results.filter((r) => r.action === 'skipped').length,
          failed: results.filter((r) => r.action === 'failed').length,
        },
      }),
      {
        status: anyFailed ? 207 : 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
}

// ─── Inbound event handling ────────────────────────────────────────

async function handleTelephonyEvent(body: any): Promise<Response> {
  // RC sends a `subscriptionId` so we can look up which org this event
  // belongs to. Without it we can't multi-tenant-route the event.
  const subscriptionId =
    body?.subscriptionId || body?.subscription?.id || null;

  if (!subscriptionId) {
    return new Response(
      JSON.stringify({ skipped: true, reason: 'No subscriptionId in payload' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const { data: cfgRow, error: cfgErr } = await supabase
    .from('communication_voice_config')
    .select('org_id')
    .eq('webhook_subscription_id', subscriptionId)
    .limit(1)
    .maybeSingle();
  if (cfgErr || !cfgRow) {
    // Unknown subscription — log and bail. RC will not retry on 200.
    console.warn('[telephony-webhook] Unknown subscriptionId:', subscriptionId);
    return new Response(
      JSON.stringify({ skipped: true, reason: 'Unknown subscriptionId' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
  const orgId: string = cfgRow.org_id;

  const known = await getKnownExtensionIds(orgId);
  const parsed = parseTelephonyEvent(body, known);
  if (!parsed) {
    return new Response(
      JSON.stringify({ skipped: true, reason: 'Unparseable event' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // ─── Dedupe at the (org, session, party, status) level ────────────
  // We rely on the unique (org_id, telephony_session_id) for the row,
  // but RC retransmits identical event payloads; skip the duplicate
  // before doing entity-match work.
  const dedupeKey = buildEventDedupeKey(parsed);
  // No dedicated dedupe table — use the existing row's status as a
  // cheap "have we already processed this exact state?" signal. RC's
  // retransmits are rare; the cost of an idempotent re-upsert is tiny.
  const { data: existingRows } = await supabase
    .from('call_sessions')
    .select(
      'id, status, answered_at, started_at, ended_at, recording_id, matched_user_id, matched_entity_type, matched_entity_id',
    )
    .eq('org_id', orgId)
    .eq('telephony_session_id', parsed.telephonySessionId)
    .limit(1);

  const existing: ExistingCallSessionRow | null =
    existingRows && existingRows.length > 0
      ? (existingRows[0] as ExistingCallSessionRow)
      : null;

  const plan = planCallSessionUpsert(existing, parsed);

  // ─── Match phone → entity & extension → user (only when needed) ──
  // If we already matched on a prior event for this session, reuse the
  // existing values so a transient match miss on a later event doesn't
  // wipe out our resolution.
  const fromPhone = parsed.direction === 'inbound' ? parsed.fromE164 : parsed.toE164;
  let matchedEntityType: string | null = existing?.matched_entity_type ?? null;
  let matchedEntityId: string | null = existing?.matched_entity_id ?? null;
  if (!matchedEntityId) {
    const m = await matchPhoneToEntity(orgId, fromPhone);
    matchedEntityType = m.entityType;
    matchedEntityId = m.entityId;
  }

  let matchedUserId: string | null = existing?.matched_user_id ?? null;
  if (!matchedUserId) {
    matchedUserId = await resolveExtensionUser(orgId, parsed.extensionId);
  }

  // ─── Upsert call_sessions ─────────────────────────────────────────
  const upsertRow: Record<string, any> = {
    org_id: orgId,
    telephony_session_id: parsed.telephonySessionId,
    party_id: parsed.partyId,
    direction: parsed.direction,
    status: plan.status,
    from_e164: parsed.fromE164,
    to_e164: parsed.toE164,
    extension_id: parsed.extensionId,
    matched_user_id: matchedUserId,
    matched_entity_type: matchedEntityType,
    matched_entity_id: matchedEntityId,
    started_at: plan.startedAt,
    answered_at: plan.answeredAt,
    ended_at: plan.endedAt,
    duration_seconds: plan.durationSeconds,
    recording_id: parsed.recordingId || existing?.recording_id || null,
    raw_event_payload: body,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('call_sessions')
    .upsert(upsertRow, { onConflict: 'org_id,telephony_session_id' });

  if (upsertErr) {
    console.error('[telephony-webhook] Upsert failed:', upsertErr);
    return new Response(
      JSON.stringify({ error: `Upsert failed: ${upsertErr.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // ─── Append to the unified event bus ──────────────────────────────
  // Only on actual status transitions (not on late retransmits) so the
  // event log doesn't get spammed.
  if (!plan.isLateRetransmit && (!existing || existing.status !== plan.status)) {
    const eventType = eventTypeForStatus(plan.status, parsed.direction);
    await logEvent(
      supabase,
      eventType,
      matchedEntityType as 'caregiver' | 'client' | null,
      matchedEntityId,
      'system:ringcentral',
      {
        telephony_session_id: parsed.telephonySessionId,
        direction: parsed.direction,
        from_e164: parsed.fromE164,
        to_e164: parsed.toE164,
        extension_id: parsed.extensionId,
        matched_user_id: matchedUserId,
        dedupe_key: dedupeKey,
      },
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      org_id: orgId,
      telephony_session_id: parsed.telephonySessionId,
      status: plan.status,
      late_retransmit: plan.isLateRetransmit,
      matched: {
        entity_type: matchedEntityType,
        entity_id: matchedEntityId,
        user_id: matchedUserId,
      },
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

// ─── HTTP entry ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // RC subscription registration challenge.
  const validationToken =
    req.headers.get('validation-token') || req.headers.get('Validation-Token');
  if (validationToken) {
    return new Response('', {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Validation-Token': validationToken,
      },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'subscribe') {
    return handleSubscribe();
  }

  try {
    const body = await req.json();
    return await handleTelephonyEvent(body);
  } catch (err) {
    console.error('[ringcentral-telephony-webhook] error:', err);
    return new Response(
      JSON.stringify({ error: `Internal error: ${(err as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
