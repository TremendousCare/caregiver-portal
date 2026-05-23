import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../context/NotificationContext';
import { formatNotificationTimeAgo } from '../../lib/notificationFormatters';

/**
 * NotificationBell — floating notification badge in the AppShell.
 *
 * Renders a bell icon in the top-right corner with the unread count
 * badge from NotificationContext. Click opens a dropdown listing the
 * last 20 notifications (most recent first). Clicking a row navigates
 * to the lead's profile and marks the row read.
 *
 * Hidden entirely when the user has no email (e.g. caregiver users on
 * the /care PWA) — there's no one to notify and the realtime channel
 * isn't subscribed.
 */
export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, markOneRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  // Close on click-outside.
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function handleRowClick(n) {
    markOneRead(n.id);
    if (n.link_url) {
      // Internal portal links — strip the origin and navigate via
      // router so we don't trigger a full page reload.
      try {
        const u = new URL(n.link_url, window.location.origin);
        if (u.origin === window.location.origin) {
          navigate(u.pathname + u.search + u.hash);
          setOpen(false);
          return;
        }
      } catch {
        // Fall through — open in a new tab below.
      }
      window.open(n.link_url, '_blank', 'noopener,noreferrer');
    }
    setOpen(false);
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 1100,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Notifications (${unreadCount} unread)`}
        title={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        style={{
          position: 'relative',
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: '1px solid #E0E4EA',
          background: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(46,78,141,0.15)',
          padding: 0,
        }}
      >
        {/* Bell SVG — no emoji per CLAUDE.md UI conventions */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2E4E8D"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: '#DC3545',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(220,53,69,0.4)',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute',
            top: 48,
            right: 0,
            width: 360,
            maxHeight: '70vh',
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid #E0E4EA',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(46,78,141,0.2)',
            padding: 0,
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid #E0E4EA',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700 }}>Notifications</div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#2E4E8D',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          {notifications.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#7A8BA0', fontSize: 13 }}>
              No notifications yet.
            </div>
          ) : (
            <div>
              {notifications.map((n) => {
                const unread = !n.read_at;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleRowClick(n)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 16px',
                      border: 'none',
                      borderBottom: '1px solid #F0F2F5',
                      background: unread ? '#F0F7FF' : '#fff',
                      cursor: n.link_url ? 'pointer' : 'default',
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {unread && (
                        <span
                          aria-label="unread"
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#2E4E8D',
                          }}
                        />
                      )}
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#1A1A1A' }}>
                        {n.title || 'Notification'}
                      </span>
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontSize: 11,
                          color: '#7A8BA0',
                        }}
                      >
                        {formatNotificationTimeAgo(n.created_at)}
                      </span>
                    </div>
                    {n.message && (
                      <div style={{ fontSize: 13, color: '#4A5C75', marginTop: 4, marginLeft: unread ? 16 : 0 }}>
                        {n.message}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
