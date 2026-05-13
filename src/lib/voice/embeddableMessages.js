// ─────────────────────────────────────────────────────────────────
// Pure helpers for the RingCentral Embeddable postMessage protocol.
// Kept React/DOM-free so vitest can exercise message shaping without
// spinning up a component.
//
// Embeddable accepts a documented set of `rc-adapter-*` messages on
// its window. The two we currently use:
//   - rc-adapter-new-call    (click-to-call out)
//   - rc-adapter-set-presence  (unused; placeholder for future)
//
// The widget's outbound events (call ringing / answered / ended)
// land on the parent window as `rc-call-*-notify` messages. PR 4
// does NOT listen to those — our existing call_sessions Realtime
// stream is the source of truth. A follow-up may layer those in for
// quicker UI feedback when WebRTC answers faster than the webhook.
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
