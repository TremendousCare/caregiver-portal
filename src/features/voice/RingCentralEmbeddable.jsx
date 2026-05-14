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

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { useVoice } from '../../shared/context/VoiceContext';
import {
  clampPosition,
  loadStoredPosition,
  storePosition,
} from '../../lib/voice/embeddablePosition';
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
  const panelRef = useRef(null);
  const [collapsed, setCollapsed] = useState(true);
  const [shouldRender, setShouldRender] = useState(false);
  // null = use the CSS default bottom-right placement. Once the user
  // drags, we switch to left/top absolute positioning persisted in
  // localStorage so each user keeps their preferred spot.
  const [position, setPosition] = useState(() => loadStoredPosition());
  const dragStateRef = useRef(null);

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

  // ─── Drag handling ───
  // Pointer events give us unified mouse + touch support and capture
  // semantics so the drag survives the cursor leaving the header.
  const handlePointerDown = useCallback(
    (e) => {
      // Ignore clicks on the collapse toggle so dragging the panel
      // doesn't also toggle it.
      if (e.target.closest(`.${styles.embedToggle}`)) return;
      if (e.button !== undefined && e.button !== 0) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragStateRef.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        moved: false,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Older browsers without setPointerCapture — drag still works
        // via window listeners installed below.
      }
    },
    [],
  );

  const handlePointerMove = useCallback((e) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const panel = panelRef.current;
    if (!panel) return;
    drag.moved = true;
    const next = clampPosition(
      { left: e.clientX - drag.offsetX, top: e.clientY - drag.offsetY },
      { width: window.innerWidth, height: window.innerHeight },
      { width: panel.offsetWidth, height: panel.offsetHeight },
    );
    setPosition(next);
  }, []);

  const handlePointerUp = useCallback(
    (e) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragStateRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (drag.moved) {
        // Read the current position from React state via a functional
        // update so we persist exactly what's on screen.
        setPosition((p) => {
          if (p) storePosition(p);
          return p;
        });
      }
    },
    [],
  );

  // Re-clamp when the window resizes so the widget never disappears
  // off-screen on a smaller viewport.
  useEffect(() => {
    if (!position) return undefined;
    function onResize() {
      const panel = panelRef.current;
      if (!panel) return;
      setPosition((p) => {
        if (!p) return p;
        const next = clampPosition(
          p,
          { width: window.innerWidth, height: window.innerHeight },
          { width: panel.offsetWidth, height: panel.offsetHeight },
        );
        if (next.left !== p.left || next.top !== p.top) {
          storePosition(next);
          return next;
        }
        return p;
      });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [position]);

  if (!shouldRender) return null;

  if (!RC_CLIENT_ID) {
    return (
      <div className={styles.embedConfigError}>
        Voice dialer unavailable — set <code>VITE_RINGCENTRAL_CLIENT_ID</code> in Vercel and redeploy.
      </div>
    );
  }

  const src = buildEmbeddableUrl(RC_CLIENT_ID);

  // When the user has dragged, switch from CSS bottom-right anchoring
  // to absolute left/top. Otherwise leave inline style empty so the
  // stylesheet's default placement wins.
  const inlineStyle = position
    ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' }
    : undefined;

  return (
    <div
      ref={panelRef}
      className={`${styles.embedPanel} ${collapsed ? styles.embedCollapsed : ''}`}
      style={inlineStyle}
    >
      <div
        className={styles.embedHeader}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="toolbar"
        aria-label="RingCentral phone (drag to move)"
      >
        <span className={styles.embedTitle}>RC</span>
        <button
          type="button"
          className={styles.embedToggle}
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand phone' : 'Collapse phone'}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
