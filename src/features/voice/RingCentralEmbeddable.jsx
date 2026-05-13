// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 2 — RingCentral Embeddable widget
//
// Drop-in iframe for RC's hosted Embeddable build. Renders as a
// floating collapsible panel at the bottom-right of the admin shell
// (offset above the AIChatbot button so the two don't overlap).
//
// What this gives us out of the box:
//   - In-browser audio (WebRTC) for inbound + outbound calls
//   - Answer / Decline / Mute / Hold / Transfer buttons
//   - Dialpad
//   - Call quality indicator
//   - Voicemail UI
//
// What we add ON TOP (separately):
//   - Our own screen-pop (IncomingCallToast) — fires from the
//     call_sessions Realtime stream, carries our matched-entity
//     context. Embeddable's notification is a duplicate; tolerable
//     in V1 (will coordinate in a follow-up).
//   - Click-to-call via postMessage (`rc-adapter-new-call`) —
//     wired through VoiceContext.placeCall(). PhoneCallButton is
//     the consumer.
//
// Auth: Embeddable handles its own OAuth — user signs in once per
// session inside the iframe with their RC credentials. The
// `clientId` is passed via URL query string; it's a PUBLIC OAuth
// identifier, safe to expose to the browser. The `redirectUri`
// must be registered in the RC API app's "OAuth Redirect URIs"
// list at developers.ringcentral.com — for the hosted build that's
// https://ringcentral.github.io/ringcentral-embeddable/redirect.html
//
// Toggling: Hidden by default for non-bound users (Embeddable is
// noisy if you can't actually take calls). Visible to users with
// any ringcentral_extension_id binding.
// ─────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { useVoice } from '../../shared/context/VoiceContext';
import styles from './voice.module.css';

const HOSTED_URL = 'https://ringcentral.github.io/ringcentral-embeddable/app.html';

// Read the RC client ID from Vite env vars. Public OAuth identifier;
// safe to expose. Configure in Vercel under
// `VITE_RINGCENTRAL_CLIENT_ID`. Without it the widget renders a
// helpful inline error rather than a confusing blank iframe.
const RC_CLIENT_ID = import.meta.env?.VITE_RINGCENTRAL_CLIENT_ID || '';

function buildEmbeddableUrl(clientId) {
  if (!clientId) return null;
  const params = new URLSearchParams({
    clientId,
    appServer: 'https://platform.ringcentral.com',
    // Cache the auth in the user's browser so they don't have to
    // sign in to RC on every page load.
    enableFromNumberSetting: '1',
    enableSharedMessages: '0',
    disconnectInactiveSubscription: '1',
  });
  return `${HOSTED_URL}?${params.toString()}`;
}

export function RingCentralEmbeddable() {
  const { registerEmbeddableIframe } = useVoice();
  const iframeRef = useRef(null);
  const [collapsed, setCollapsed] = useState(true);
  const [shouldRender, setShouldRender] = useState(false);

  // Only render the widget for users who actually have a bound RC
  // extension. Otherwise the dialer is just noise.
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

  // Register the iframe ref with VoiceContext so placeCall() can
  // postMessage into it.
  useEffect(() => {
    if (!iframeRef.current) return undefined;
    registerEmbeddableIframe(iframeRef.current);
    return () => registerEmbeddableIframe(null);
  }, [shouldRender, registerEmbeddableIframe]);

  if (!shouldRender) return null;

  if (!RC_CLIENT_ID) {
    return (
      <div className={styles.embedConfigError}>
        Voice dialer unavailable — set <code>VITE_RINGCENTRAL_CLIENT_ID</code> in Vercel and redeploy.
      </div>
    );
  }

  const src = buildEmbeddableUrl(RC_CLIENT_ID);

  return (
    <div className={`${styles.embedPanel} ${collapsed ? styles.embedCollapsed : ''}`}>
      <div className={styles.embedHeader}>
        <span className={styles.embedTitle}>RingCentral Phone</span>
        <button
          type="button"
          className={styles.embedToggle}
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand phone' : 'Collapse phone'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
        <iframe
          ref={iframeRef}
          title="RingCentral Phone"
          src={src}
          className={styles.embedIframe}
          allow="microphone *; autoplay *"
        />
      )}
    </div>
  );
}
