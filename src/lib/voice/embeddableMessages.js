// ─────────────────────────────────────────────────────────────────
// Pure helpers for the RingCentral Embeddable postMessage protocol.
// Kept React/DOM-free so vitest can exercise message shaping without
// spinning up a component.
//
// Embeddable accepts a documented set of `rc-adapter-*` messages on
// its window. The ones we currently use:
//   - rc-adapter-new-call       (click-to-call out)
//   - rc-adapter-control-call   (answer / reject / hangup / mute …)
//
// The widget's outbound events (call ringing / answered / ended)
// land on the parent window as `rc-call-*-notify` messages. We don't
// currently subscribe — our `call_sessions` Realtime stream is the
// source of truth for screen-pop state. A follow-up could layer
// those in for sub-second UI feedback when WebRTC answers before
// the webhook lands.
//
// Docs:
//   https://ringcentral.github.io/ringcentral-embeddable/docs/integration/api/
// ─────────────────────────────────────────────────────────────────

/**
 * Shape the `rc-adapter-new-call` payload Embeddable expects.
 * `toCall: true` initiates the call immediately. `toCall: false`
 * just prefills the dialpad — handy if we ever want a "compose a
 * call" UX rather than direct dial. PhoneCallButton uses true.
 *
 * @param {string} phoneNumber  destination, any format
 * @param {object} [opts]
 * @param {boolean} [opts.toCall=true]
 * @returns {{ type: string, phoneNumber: string, toCall: boolean } | null}
 *   Returns null when phoneNumber is falsy or empty after trim.
 */
export function buildNewCallMessage(phoneNumber, opts = {}) {
  if (phoneNumber == null) return null;
  const trimmed = String(phoneNumber).trim();
  if (!trimmed) return null;
  return {
    type: 'rc-adapter-new-call',
    phoneNumber: trimmed,
    toCall: opts.toCall !== false,
  };
}

/**
 * Shape an `rc-adapter-control-call` payload for an inbound call
 * control action — answer, reject, hangup, toVoicemail, etc.
 *
 * When `callId` is omitted, Embeddable applies the action to the
 * currently-ringing call. For a single-agent workstation that's
 * almost always what we want, and it avoids the (separate) problem
 * of mapping our `call_sessions.telephony_session_id` onto
 * Embeddable's internal webphone callId.
 *
 * @param {string} callAction  one of: 'answer', 'reject', 'hangup',
 *   'toVoicemail', 'forward', 'mute', 'unmute', 'hold', 'unhold'
 * @param {object} [opts]
 * @param {string} [opts.callId]  Embeddable's webphone callId. Omit
 *   to target the current ringing call.
 * @returns {{ type: string, callAction: string, callId?: string } | null}
 *   Returns null when callAction is empty.
 */
export function buildControlCallMessage(callAction, opts = {}) {
  if (callAction == null) return null;
  const trimmed = String(callAction).trim();
  if (!trimmed) return null;
  const message = {
    type: 'rc-adapter-control-call',
    callAction: trimmed,
  };
  if (opts.callId != null && String(opts.callId).trim() !== '') {
    message.callId = String(opts.callId).trim();
  }
  return message;
}

/**
 * Convenience wrapper — answer the current ringing call.
 *
 * @param {object} [opts]  forwarded to buildControlCallMessage
 * @returns {{ type: string, callAction: string, callId?: string }}
 */
export function buildAnswerCallMessage(opts = {}) {
  return buildControlCallMessage('answer', opts);
}

/**
 * Quick check whether a payload message is an Embeddable-emitted
 * event we'd want to act on later. Stub today; PR 4-followup might
 * call this from a window 'message' listener.
 *
 * @param {any} data
 * @returns {boolean}
 */
export function isEmbeddableEvent(data) {
  return !!(
    data &&
    typeof data === 'object' &&
    typeof data.type === 'string' &&
    data.type.startsWith('rc-')
  );
}
