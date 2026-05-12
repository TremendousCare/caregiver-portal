// Pure helpers for the RingCentral Telephony Sessions webhook.
// Kept free of Deno imports so they can be unit-tested under Node/Vitest
// in addition to running inside the edge function.
//
// Mirrors the structure of ringcentral-webhook/subscribe-helpers.ts so a
// developer familiar with the SMS webhook recognises the pattern.

// ─── Types ─────────────────────────────────────────────────────────

/** Normalised representation of a single RC Telephony Sessions event. */
export interface CallEventNormalized {
  /** The RC telephony session id — stable across all events for one call. */
  telephonySessionId: string;
  /** The party id that this event is about (one party = one leg of the call). */
  partyId: string | null;
  /** 'inbound' or 'outbound' from the org's perspective. */
  direction: 'inbound' | 'outbound';
  /** Mapped to our call_sessions.status enum. */
  status: 'ringing' | 'answered' | 'ended' | 'missed' | 'voicemail';
  /** Caller E.164 (whoever initiated the call). */
  fromE164: string | null;
  /** Callee E.164 (whoever the call is directed to). */
  toE164: string | null;
  /** The RC extension id involved in the call from our org's side. */
  extensionId: string | null;
  /** The party-event RC timestamp (event.eventTime). */
  eventTime: string | null;
  /** Recording id if the call is being recorded and RC has surfaced it. */
  recordingId: string | null;
}

/** Status code coming from RC Telephony Sessions: `parties[i].status.code`. */
export type RcStatusCode =
  | 'Setup'
  | 'Proceeding'
  | 'Alerting'
  | 'Answered'
  | 'Hold'
  | 'Disconnected'
  | 'Voicemail'
  | 'VoiceMail'
  | 'Parked'
  | 'Gone';

// ─── Status mapping ────────────────────────────────────────────────

/**
 * Map an RC party status code (+ optional reason, + whether the party
 * was previously answered) to our internal call_sessions status enum.
 *
 * The "was answered" hint matters because:
 *   - Disconnected after Answered  → 'ended'
 *   - Disconnected before Answered → 'missed' (caller hung up while ringing)
 *
 * See RC docs:
 *   https://developers.ringcentral.com/api-reference/Call-Control/
 */
export function mapRcStatusToCallStatus(
  rcStatus: string,
  opts: { wasAnswered?: boolean; reason?: string } = {},
): CallEventNormalized['status'] {
  const normalized = String(rcStatus || '').toLowerCase();
  const reason = String(opts.reason || '').toLowerCase();

  if (
    normalized === 'setup' ||
    normalized === 'proceeding' ||
    normalized === 'alerting'
  ) {
    return 'ringing';
  }

  if (normalized === 'answered' || normalized === 'hold') {
    return 'answered';
  }

  if (normalized === 'voicemail' || normalized === 'voicemail'.toLowerCase()) {
    return 'voicemail';
  }
  // RC sometimes emits VoiceMail with mixed case; we lowercase above.

  if (normalized === 'disconnected' || normalized === 'gone' || normalized === 'parked') {
    // Reason 'Voicemail' wins over a wasAnswered=false reading.
    if (reason === 'voicemail') return 'voicemail';
    if (opts.wasAnswered) return 'ended';
    return 'missed';
  }

  // Unknown status → fall back to ringing so the row still gets a screen-pop.
  return 'ringing';
}

// ─── Direction mapping ─────────────────────────────────────────────

/**
 * Derive call direction from a single RC party. RC's `direction` field is
 * already either 'Inbound' or 'Outbound' from the extension's perspective,
 * but it can be missing on older payload shapes; we fall back to a phone
 * + extensionId heuristic.
 */
export function deriveDirection(party: Record<string, unknown>): 'inbound' | 'outbound' {
  const rcDir = String(party.direction || '').toLowerCase();
  if (rcDir === 'inbound') return 'inbound';
  if (rcDir === 'outbound') return 'outbound';

  // Fallback: if the party has an extensionId in `from` it's outbound; in `to`
  // it's inbound.
  const from = (party.from || {}) as Record<string, unknown>;
  const to = (party.to || {}) as Record<string, unknown>;
  if (from && from.extensionId) return 'outbound';
  if (to && to.extensionId) return 'inbound';

  // Last resort.
  return 'inbound';
}

// ─── Phone normalisation (mirrors helpers/phone.ts) ────────────────

export function normalizeE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// ─── Top-level parser ──────────────────────────────────────────────

/**
 * Parse a single RC Telephony Sessions webhook event into our internal
 * shape. RC fires multiple events per call (one per party state change);
 * the caller is expected to invoke this once per event and upsert the
 * call_sessions row with the latest status.
 *
 * Returns null when the event is malformed or for some reason
 * un-handleable (eg. multi-party conference legs we don't model yet).
 *
 * The `targetExtensionId` argument is the extension we care about — for
 * the org-level subscription this is "any extension in our account", so
 * the function picks the first party that matches `parties[].extensionId
 * IN (knownExtensionIds)`. If none match, the first inbound-to-our-account
 * party is used so we still get a screen-pop row even when extension
 * binding hasn't happened yet.
 */
export function parseTelephonyEvent(
  rawEvent: any,
  knownExtensionIds: ReadonlySet<string> = new Set(),
): CallEventNormalized | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  // RC may deliver the body under `body` or at the top level depending on
  // how the subscription transport is configured. Tolerate both.
  const body = (rawEvent.body || rawEvent) as Record<string, any>;

  const telephonySessionId =
    String(body.telephonySessionId || body.sessionId || '') || '';
  if (!telephonySessionId) return null;

  const parties = Array.isArray(body.parties) ? body.parties : [];
  if (parties.length === 0) return null;

  // Pick the party we care about. Preference order:
  //   1. A party whose extensionId is in `knownExtensionIds`.
  //   2. A party with ANY extensionId on the org's side (to/from).
  //   3. The first party.
  let chosen: Record<string, any> | null = null;
  for (const p of parties) {
    const extId = String(p.extensionId || '');
    if (extId && knownExtensionIds.has(extId)) {
      chosen = p;
      break;
    }
  }
  if (!chosen) {
    for (const p of parties) {
      if (p.extensionId) {
        chosen = p;
        break;
      }
    }
  }
  if (!chosen) chosen = parties[0];

  const direction = deriveDirection(chosen);
  const statusRaw = String((chosen.status || {}).code || '');
  const reasonRaw = String((chosen.status || {}).reason || '');

  // Was-answered hint: peek at the same session's history if RC supplied it.
  // RC events do not always include this; the upsert layer also computes
  // it from the row's existing answered_at, which is the authoritative path.
  const wasAnswered = Boolean(chosen.wasAnswered);

  const status = mapRcStatusToCallStatus(statusRaw, {
    wasAnswered,
    reason: reasonRaw,
  });

  const from = (chosen.from || {}) as Record<string, unknown>;
  const to = (chosen.to || {}) as Record<string, unknown>;
  const fromE164 = normalizeE164(String(from.phoneNumber || '') || null);
  const toE164 = normalizeE164(String(to.phoneNumber || '') || null);

  const recordings = Array.isArray(chosen.recordings) ? chosen.recordings : [];
  const recordingId =
    recordings.length > 0 && recordings[0] && recordings[0].id
      ? String(recordings[0].id)
      : null;

  return {
    telephonySessionId,
    partyId: chosen.id ? String(chosen.id) : null,
    direction,
    status,
    fromE164,
    toE164,
    extensionId: chosen.extensionId ? String(chosen.extensionId) : null,
    eventTime: body.eventTime ? String(body.eventTime) : null,
    recordingId,
  };
}

// ─── Status transition guard ───────────────────────────────────────

/**
 * Decide whether to apply an incoming status to an existing row. Postgres'
 * unique constraint on (org_id, telephony_session_id) plus our upsert
 * already guarantees one row per call, but RC events can arrive out of
 * order (especially for `ringing` after `answered` in network glitches).
 * This helper prevents us from regressing a call's status.
 *
 * Returns the status that should be written. Always returns the incoming
 * status if there's no existing row.
 */
const STATUS_ORDER: Record<CallEventNormalized['status'], number> = {
  ringing: 0,
  answered: 1,
  voicemail: 2,
  missed: 2,
  ended: 3,
};

export function resolveTargetStatus(
  existingStatus: CallEventNormalized['status'] | null | undefined,
  incomingStatus: CallEventNormalized['status'],
): CallEventNormalized['status'] {
  if (!existingStatus) return incomingStatus;
  const existingRank = STATUS_ORDER[existingStatus];
  const incomingRank = STATUS_ORDER[incomingStatus];
  if (existingRank === undefined || incomingRank === undefined) return incomingStatus;
  // Never go backwards. A 'ringing' event arriving after 'answered' is a
  // late retransmit and must be ignored at the status level.
  return incomingRank >= existingRank ? incomingStatus : existingStatus;
}
