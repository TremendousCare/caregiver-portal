import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCaregivers } from '../../../shared/context/CaregiverContext';
import styles from './messaging.module.css';

const MAX_CHARS = 1000;

const SpeechRecognition = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null;

/**
 * Inline SMS compose bar at the bottom of the conversation view.
 * Sends via the existing bulk-sms Edge Function with a single caregiver ID.
 *
 * Routing: when 2+ active communication routes are configured with phone + JWT,
 * a "Send from:" chip appears below the input. The initial selection uses a
 * smart default based on the caregiver's employment status (onboarding →
 * Onboarding route, otherwise → default route). Users can override via the
 * chip to pick any configured route. When 0 or 1 routes exist, the chip is
 * hidden and the edge function falls through to its legacy env-var path.
 *
 * Note logging: the bulk-sms Edge Function writes the authoritative note
 * to the caregiver's record on the server. This component only does a
 * local-only optimistic update (via addNoteLocalOnly) so the bubble
 * appears immediately in the UI — it does NOT write a second note to
 * the database.
 */
export function SMSComposeBar({ caregiver, currentUser, showToast }) {
  const { addNoteLocalOnly } = useCaregivers();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);

  // ── Route selector state ──
  const [routes, setRoutes] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const routePickerRef = useRef(null);

  const hasPhone = !!caregiver.phone;
  const smsOptedOut = caregiver.smsOptedOut === true || caregiver.sms_opted_out === true;
  const charCount = message.length;
  const canSend =
    message.trim().length > 0 && charCount <= MAX_CHARS && !sending && hasPhone && !smsOptedOut;

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Load active communication routes once on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('communication_routes')
          .select('category, label, is_default, sms_from_number, sms_vault_secret_name')
          .eq('is_active', true)
          .order('sort_order', { ascending: true });
        if (error) throw error;
        if (cancelled) return;
        setRoutes(data || []);
      } catch (err) {
        console.warn('[SMSComposeBar] Failed to load communication routes:', err);
        // With no routes loaded the selector stays hidden and sends go
        // through the edge function's legacy env-var path.
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // A route is "usable" (can be selected) only when it has both a phone and a JWT.
  const isRouteConfigured = useCallback(
    (r) => !!(r && r.sms_vault_secret_name && r.sms_from_number),
    [],
  );

  // Compute smart default. Rules:
  //   - Caregiver in onboarding (no employmentStatus or === 'onboarding')
  //     → prefer the 'onboarding' route if it exists and is configured.
  //   - Otherwise → use the is_default route if configured.
  //   - Last resort → first configured route (alphabetical by sort_order).
  //   - If nothing is configured, return null (edge function uses legacy path).
  const smartDefaultCategory = useMemo(() => {
    if (!routes.length) return null;
    const isOnboarding = !caregiver.employmentStatus || caregiver.employmentStatus === 'onboarding';
    if (isOnboarding) {
      const onboarding = routes.find(
        (r) => r.category === 'onboarding' && isRouteConfigured(r),
      );
      if (onboarding) return onboarding.category;
    }
    const def = routes.find((r) => r.is_default && isRouteConfigured(r));
    if (def) return def.category;
    const firstConfigured = routes.find((r) => isRouteConfigured(r));
    return firstConfigured?.category || null;
  }, [routes, caregiver.employmentStatus, isRouteConfigured]);

  // Seed selectedCategory when the smart default first resolves, without
  // overriding an explicit user selection on subsequent re-renders.
  useEffect(() => {
    if (smartDefaultCategory && selectedCategory === null) {
      setSelectedCategory(smartDefaultCategory);
    }
  }, [smartDefaultCategory, selectedCategory]);

  // Close the route picker menu on outside click
  useEffect(() => {
    if (!showRoutePicker) return;
    const handler = (e) => {
      if (routePickerRef.current && !routePickerRef.current.contains(e.target)) {
        setShowRoutePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showRoutePicker]);

  // Only show the selector when the user has something to choose between.
  // A single route (or zero routes) means there's no decision to make.
  const configuredRoutes = useMemo(
    () => routes.filter(isRouteConfigured),
    [routes, isRouteConfigured],
  );
  const showRouteSelector = configuredRoutes.length >= 2;
  const selectedRoute = routes.find((r) => r.category === selectedCategory) || null;

  const toggleListening = useCallback(() => {
    if (!SpeechRecognition) return;

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setMessage(transcript);
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  const handleSend = async () => {
    if (!canSend) return;

    const text = message.trim();
    setSending(true);

    try {
      const body = {
        caregiver_ids: [caregiver.id],
        message: text,
        current_user: currentUser?.email || currentUser?.displayName || 'system',
      };
      // Only pass `category` when the selector is shown (2+ configured routes)
      // AND a selection is active. Single-route or no-route setups fall
      // through to the edge function's legacy env-var path — byte-identical
      // to pre-Step-6 behavior.
      if (showRouteSelector && selectedCategory) {
        body.category = selectedCategory;
      }

      const { error } = await supabase.functions.invoke('bulk-sms', { body });

      if (error) throw error;

      // Optimistic, client-only update so the bubble appears immediately.
      // The Edge Function has already written the authoritative note
      // server-side — we intentionally do NOT persist here to avoid a
      // duplicate entry in the timeline. The optimistic note is replaced
      // by the real server note on the next full caregivers refetch.
      addNoteLocalOnly(caregiver.id, {
        text,
        type: 'text',
        direction: 'outbound',
        source: 'portal',
      });

      setMessage('');
      if (showToast) showToast('Message sent', 'success');
    } catch (err) {
      console.error('[SMSComposeBar] Send failed:', err);
      if (showToast) showToast('Failed to send message. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!hasPhone) {
    return (
      <div className={styles.composeDisabledMsg}>
        No phone number on file — add one in the profile to send texts
      </div>
    );
  }

  if (smsOptedOut) {
    return (
      <div className={styles.composeDisabledMsg} style={{
        background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA',
      }}>
        🚫 This caregiver has opted out of SMS. Outbound texts are blocked for compliance.
        Re-subscribe from the Profile Information card if they request it.
      </div>
    );
  }

  return (
    <div className={styles.composeBar}>
      <div className={styles.composeInputWrapper}>
        <textarea
          className={styles.composeInput}
          placeholder={isListening ? 'Listening...' : 'Type a message...'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          rows={1}
        />
        {charCount > 0 && (
          <span className={`${styles.charCount} ${charCount > MAX_CHARS ? styles.charCountOver : charCount > MAX_CHARS * 0.9 ? styles.charCountWarn : ''}`}>
            {charCount}/{MAX_CHARS}
          </span>
        )}
        {showRouteSelector && (
          <div className={styles.routeSelector} ref={routePickerRef}>
            <button
              type="button"
              className={styles.routeChip}
              onClick={() => setShowRoutePicker((v) => !v)}
              disabled={sending}
              title="Change which number this message sends from"
            >
              <span className={styles.routeChipIcon}>{'\uD83D\uDCF1'}</span>
              <span>Send from: <strong>{selectedRoute?.label || '—'}</strong></span>
              <span className={styles.routeChipArrow}>{'\u25BE'}</span>
            </button>
            {showRoutePicker && (
              <div className={styles.routePickerMenu} role="menu">
                {routes.map((r) => {
                  const configured = isRouteConfigured(r);
                  const isActive = r.category === selectedCategory;
                  return (
                    <button
                      key={r.category}
                      type="button"
                      role="menuitem"
                      className={`${styles.routePickerItem} ${isActive ? styles.routePickerItemActive : ''}`}
                      disabled={!configured}
                      title={!configured ? 'This route has no phone number or JWT configured yet' : undefined}
                      onClick={() => {
                        if (!configured) return;
                        setSelectedCategory(r.category);
                        setShowRoutePicker(false);
                      }}
                    >
                      <span className={styles.routePickerItemLabel}>
                        {r.label}
                        {r.is_default && (
                          <span className={styles.routePickerItemDefaultBadge}>default</span>
                        )}
                      </span>
                      {!configured && (
                        <span className={styles.routePickerItemNotSet}>not set</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {SpeechRecognition && (
        <button
          className={`${styles.micBtn}${isListening ? ` ${styles.micBtnActive}` : ''}`}
          onClick={toggleListening}
          title={isListening ? 'Stop listening' : 'Voice input'}
          type="button"
          disabled={sending}
        >
          {'\uD83C\uDF99'}
        </button>
      )}
      <button
        className={styles.composeButton}
        onClick={handleSend}
        disabled={!canSend}
      >
        {sending ? 'Sending...' : 'Send'}
      </button>
    </div>
  );
}
