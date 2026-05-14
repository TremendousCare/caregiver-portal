// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 2 — RingCentral Embeddable widget
//
// Controlled panel that hosts RC's hosted Embeddable build inside an
// iframe. Open/close is owned by the parent (the ToolsFAB launcher)
// rather than the widget itself — that way one corner-mounted
// launcher coordinates all the workspace tools (AI assistant + RC
// phone + future ones) instead of every tool fighting for the same
// pixels.
//
// Embeddable gives us:
//   - In-browser audio (WebRTC) for inbound + outbound calls
//   - Answer / Decline / Mute / Hold / Transfer buttons
//   - Dialpad, voicemail, call quality indicator
//
// We layer on top:
//   - Our own screen-pop (IncomingCallToast) — fires from
//     call_sessions Realtime, carries matched-entity context.
//   - Click-to-call via postMessage (`rc-adapter-new-call`) wired
//     through VoiceContext.placeCall().
//
// Auth: Embeddable handles its own OAuth (3-legged, in-iframe). The
// `clientId` comes from `VITE_RINGCENTRAL_CLIENT_ID` — public OAuth
// identifier, safe to expose to the browser. The redirect URI must
// be registered on the RC API app (the "Embeddable" app, NOT the
// JWT app used by server-side functions).
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { useVoice } from '../../shared/context/VoiceContext';
import styles from './voice.module.css';

const HOSTED_URL = 'https://ringcentral.github.io/ringcentral-embeddable/app.html';

const RC_CLIENT_ID = import.meta.env?.VITE_RINGCENTRAL_CLIENT_ID || '';

function buildEmbeddableUrl(clientId) {
  if (!clientId) return null;
  const params = new URLSearchParams({
    clientId,
    appServer: 'https://platform.ringcentral.com',
    enableFromNumberSetting: '1',
    enableSharedMessages: '0',
    disconnectInactiveSubscription: '1',
  });
  return `${HOSTED_URL}?${params.toString()}`;
}

export function RingCentralEmbeddable({ open = false, onClose }) {
  const { registerEmbeddableIframe } = useVoice();
  const iframeRef = useRef(null);
  const [shouldRender, setShouldRender] = useState(false);

  // Only render at all for users in an org with at least one bound
  // RC extension. Otherwise the dialer is just noise.
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('org_memberships')
        .select('ringcentral_extension_id')
        .not('ringcentral_extension_id', 'is', null)
        .limit(1);
      if (cancelled) return;
      setShouldRender((data || []).length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register the iframe with VoiceContext so placeCall() can
  // postMessage into it. Mount the iframe permanently once we know
  // we should render (off-screen when closed) so the user's OAuth
  // session and any active call survive close/reopen cycles.
  useEffect(() => {
    if (!iframeRef.current) return undefined;
    registerEmbeddableIframe(iframeRef.current);
    return () => registerEmbeddableIframe(null);
  }, [shouldRender, registerEmbeddableIframe]);

  if (!shouldRender) return null;

  if (!RC_CLIENT_ID) {
    if (!open) return null;
    return (
      <div className={styles.embedConfigError}>
        Voice dialer unavailable — set <code>VITE_RINGCENTRAL_CLIENT_ID</code> in Vercel and redeploy.
      </div>
    );
  }

  const src = buildEmbeddableUrl(RC_CLIENT_ID);

  return (
    <div
      className={`${styles.embedPanel} ${open ? styles.embedOpen : styles.embedHidden}`}
      aria-hidden={!open}
    >
      <div className={styles.embedHeader}>
        <span className={styles.embedTitle}>RingCentral Phone</span>
        {onClose && (
          <button
            type="button"
            className={styles.embedClose}
            onClick={onClose}
            aria-label="Close phone"
          >
            ×
          </button>
        )}
      </div>
      <iframe
        ref={iframeRef}
        title="RingCentral Phone"
        src={src}
        className={styles.embedIframe}
        allow="microphone *; autoplay *"
      />
    </div>
  );
}
