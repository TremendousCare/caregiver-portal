import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useCallback,
} from 'react';
import { supabase } from '../../lib/supabase';
import { useApp } from './AppContext';
import { composeNotificationToast } from '../../lib/notificationFormatters';

const NotificationContext = createContext(null);

// How many recent rows to load on mount. The bell dropdown shows the
// last N; everything older lives only in the DB. 20 is the same cap
// we use for the events bus situational layer in the AI chat.
const HISTORY_LIMIT = 20;

/**
 * NotificationProvider — realtime in-portal notifications for the
 * dispatch-lead-notifications worker (PR 3 of the lead-notif feature).
 *
 * Each row in `notifications_user` targets one user (by email). The
 * dispatcher inserts one row per configured toast recipient when a new
 * lead fires; this provider:
 *   1. Loads the user's recent rows on mount.
 *   2. Subscribes to realtime INSERT on `notifications_user` filtered
 *      by `user_email = currentUserEmail`. The PR 1 schema migration
 *      already added this table to the supabase_realtime publication.
 *   3. On each new row → prepends to state and pops a toast via the
 *      existing showToast() helper from AppContext.
 *
 * Mark-as-read flips `read_at` to now() for the affected rows. RLS
 * allows the authenticated user to UPDATE only their own rows
 * (notifications_user_update_own policy, PR 1).
 */
export function NotificationProvider({ children }) {
  const { currentUserEmail, currentOrgId, showToast } = useApp();
  const [notifications, setNotifications] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const initialLoadDoneRef = useRef(false);

  // ─── Initial load ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!currentUserEmail) {
      setNotifications([]);
      setLoaded(true);
      return () => { cancelled = true; };
    }
    setLoaded(false);
    initialLoadDoneRef.current = false;
    (async () => {
      try {
        let query = supabase
          .from('notifications_user')
          .select('id, org_id, user_email, notification_type, lead_id, title, message, link_url, severity, read_at, created_at')
          .order('created_at', { ascending: false })
          .limit(HISTORY_LIMIT);
        if (currentOrgId) {
          // Defense in depth: RLS already constrains by user_email,
          // but org-filtering the read also keeps cross-org rows out
          // even if a future RLS regression slips through.
          query = query.eq('org_id', currentOrgId);
        }
        const { data, error } = await query;
        if (error) throw error;
        if (cancelled) return;
        setNotifications(data || []);
      } catch (err) {
        console.error('NotificationContext: initial load failed', err);
      } finally {
        if (!cancelled) {
          setLoaded(true);
          initialLoadDoneRef.current = true;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [currentUserEmail, currentOrgId]);

  // ─── Realtime subscription ──────────────────────────────────────
  // postgres_changes filter syntax for an exact match on a text column:
  // `user_email=eq.<value>`. Email is lowercased on insert by the
  // dispatcher (which copies from the settings list, but to be safe
  // we case-insensitive-compare in the handler below).
  useEffect(() => {
    if (!currentUserEmail) return undefined;
    const emailLower = currentUserEmail.toLowerCase();
    const channel = supabase
      .channel(`notifications_user:${emailLower}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications_user',
          filter: `user_email=eq.${currentUserEmail}`,
        },
        (payload) => {
          const row = payload?.new;
          if (!row) return;
          // Defensive recheck: realtime filter is server-side, but
          // we still verify case-insensitively before injecting.
          if (
            typeof row.user_email !== 'string'
            || row.user_email.toLowerCase() !== emailLower
          ) {
            return;
          }
          setNotifications((prev) => {
            // Dedup against rows already loaded by the initial fetch
            // (race window when realtime + initial select overlap).
            if (prev.some((n) => n.id === row.id)) return prev;
            return [row, ...prev].slice(0, HISTORY_LIMIT);
          });
          // Pop the existing toast. Composer mirrors the dispatcher's
          // notifications_user row contract. The 3-second auto-dismiss
          // is set in AppContext.
          if (initialLoadDoneRef.current && showToast) {
            showToast(composeNotificationToast(row));
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentUserEmail, showToast]);

  // ─── Mutations ──────────────────────────────────────────────────
  const markAllRead = useCallback(async () => {
    if (!currentUserEmail) return;
    const unreadIds = notifications.filter((n) => !n.read_at).map((n) => n.id);
    if (unreadIds.length === 0) return;
    // Optimistic update so the bell badge clears instantly.
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (n.read_at ? n : { ...n, read_at: nowIso })),
    );
    const { error } = await supabase
      .from('notifications_user')
      .update({ read_at: nowIso })
      .in('id', unreadIds);
    if (error) {
      console.error('NotificationContext: mark all read failed', error);
      // No revert: the realtime channel will resync if needed and
      // a stale "read" badge is better UX than a flicker back to red.
    }
  }, [notifications, currentUserEmail]);

  const markOneRead = useCallback(async (id) => {
    if (!id) return;
    const target = notifications.find((n) => n.id === id);
    if (!target || target.read_at) return;
    const nowIso = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: nowIso } : n)),
    );
    const { error } = await supabase
      .from('notifications_user')
      .update({ read_at: nowIso })
      .eq('id', id);
    if (error) {
      console.error('NotificationContext: mark one read failed', error);
    }
  }, [notifications]);

  // ─── Derived values ─────────────────────────────────────────────
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read_at).length,
    [notifications],
  );

  const value = useMemo(
    () => ({ notifications, unreadCount, loaded, markAllRead, markOneRead }),
    [notifications, unreadCount, loaded, markAllRead, markOneRead],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  // Returning a default-empty shape (instead of throwing) makes it
  // safe to render the NotificationBell in shells that haven't been
  // wrapped — e.g. unit-test renderers or the public esignature
  // standalone routes.
  if (!ctx) {
    return {
      notifications: [],
      unreadCount: 0,
      loaded: false,
      markAllRead: async () => {},
      markOneRead: async () => {},
    };
  }
  return ctx;
}
