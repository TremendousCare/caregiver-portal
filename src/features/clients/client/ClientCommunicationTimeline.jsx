import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import cl from './client.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';

// ─── Communication Note Types ────────────────────────────────
const COMM_TYPES = [
  { value: 'call', label: 'Phone Call', icon: '\uD83D\uDCDE' },
  { value: 'text', label: 'Text Message', icon: '\uD83D\uDCAC' },
  { value: 'email', label: 'Email', icon: '\u2709\uFE0F' },
  { value: 'meeting', label: 'Meeting', icon: '\uD83E\uDD1D' },
];

const NOTE_OUTCOMES = [
  { value: 'answered', label: 'Answered' },
  { value: 'voicemail', label: 'Left Voicemail' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'busy', label: 'Busy' },
  { value: 'scheduled', label: 'Scheduled Follow-Up' },
  { value: 'completed', label: 'Completed' },
];

// ─── Helper: Normalize Phone ─────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9+]/g, '');
}

// ─── Main Component ──────────────────────────────────────────

export function ClientCommunicationTimeline({ client, currentUser, onAddNote }) {
  // ─── State ──────────────────────────────────────────────
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('call');
  const [noteDirection, setNoteDirection] = useState('outbound');
  const [noteOutcome, setNoteOutcome] = useState('');
  const [showForm, setShowForm] = useState(false);

  // RingCentral data
  const [rcData, setRcData] = useState({ sms: [], calls: [] });
  const [rcLoading, setRcLoading] = useState(false);
  const [rcError, setRcError] = useState(null);

  // ─── Fetch RingCentral Communication Data ───────────────
  useEffect(() => {
    const phone = normalizePhone(client?.phone);
    if (!phone || !supabase) return;

    let cancelled = false;
    setRcLoading(true);
    setRcError(null);

    supabase.functions
      .invoke('get-communications', {
        body: { phone, days_back: 90 },
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          console.warn('RC fetch failed for client:', error);
          setRcData({ sms: [], calls: [] });
          // Don't show error if it's just "no data" — only show connection errors
          if (error) setRcError('Could not load external communication data.');
        } else {
          setRcData({ sms: data.sms || [], calls: data.calls || [] });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('RC fetch error:', err);
          setRcData({ sms: [], calls: [] });
          setRcError('Could not load external communication data.');
        }
      })
      .finally(() => {
        if (!cancelled) setRcLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client?.id, client?.phone]);

  // ─── Merge Portal Notes + RC Data ──────────────────────
  const mergedTimeline = useMemo(() => {
    // Filter portal notes to communication types only
    const commTypes = ['call', 'text', 'email', 'meeting', 'sms'];
    const portalEntries = (client.notes || [])
      .filter((n) => commTypes.includes(n.type))
      .map((n, i) => ({
        ...n,
        id: `portal-comm-${i}`,
        source: n.source || 'portal',
        timestamp: n.timestamp || n.date,
      }));

    const rcEntries = [...rcData.sms, ...rcData.calls].map((rc, i) => ({
      ...rc,
      id: `rc-${i}`,
      source: 'ringcentral',
    }));

    // Deduplication: skip RC entries that match portal notes within 2 minutes
    const portalOutboundTexts = portalEntries.filter(
      (n) => (n.type === 'text' || n.type === 'sms') && n.direction === 'outbound' && n.source === 'portal'
    );
    const portalRCNotes = portalEntries.filter((n) => n.source === 'ringcentral');

    const deduped = rcEntries.filter((rc) => {
      const rcTime = new Date(rc.timestamp).getTime();
      // Skip RC outbound texts matching portal outbound notes
      if ((rc.type === 'text' || rc.type === 'sms') && rc.direction === 'outbound') {
        if (
          portalOutboundTexts.some(
            (pn) => Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000
          )
        )
          return false;
      }
      // Skip RC entries matching webhook-written notes
      if (
        portalRCNotes.some((pn) => {
          if (pn.type !== rc.type || pn.direction !== rc.direction) return false;
          return Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000;
        })
      )
        return false;
      return true;
    });

    return [...portalEntries, ...deduped].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [client.notes, rcData]);

  // ─── Add Note Handler ──────────────────────────────────
  const handleAddNote = () => {
    if (!noteText.trim()) return;
    const note = {
      text: noteText.trim(),
      type: noteType,
      direction: noteDirection,
    };
    if (noteOutcome) note.outcome = noteOutcome;
    onAddNote(client.id, note);
    setNoteText('');
    setNoteOutcome('');
    setShowForm(false);
  };

  // ─── Quick-log with pre-set type ───────────────────────
  const handleQuickLog = (type) => {
    setNoteType(type);
    setNoteDirection('outbound');
    setNoteOutcome('');
    setNoteText('');
    setShowForm(true);
  };

  // ─── Type icon map ─────────────────────────────────────
  const getTypeIcon = (type) => {
    switch (type) {
      case 'call': return '\uD83D\uDCDE';
      case 'text':
      case 'sms': return '\uD83D\uDCAC';
      case 'email': return '\u2709\uFE0F';
      case 'meeting': return '\uD83D\uDCC5';
      default: return '\uD83D\uDCDD';
    }
  };

  const getTypeLabel = (type) => {
    switch (type) {
      case 'call': return 'Call';
      case 'text':
      case 'sms': return 'Text';
      case 'email': return 'Email';
      case 'meeting': return 'Meeting';
      default: return type;
    }
  };

  // ─── Render ────────────────────────────────────────────

  return (
    <div className={cl.notesSection} style={{ marginTop: 20 }}>
      <h3 className={cl.notesSectionTitle}>
        {'\uD83D\uDCE1'} Communication History
      </h3>

      {/* Quick action buttons */}
      <div style={styles.quickActions}>
        {COMM_TYPES.map((t) => (
          <button
            key={t.value}
            style={{
              ...styles.quickBtn,
              ...(showForm && noteType === t.value ? styles.quickBtnActive : {}),
            }}
            onClick={() => handleQuickLog(t.value)}
          >
            {t.icon} Log {t.label}
          </button>
        ))}
      </div>

      {/* Expandable Add Form */}
      {showForm && (
        <div style={styles.formContainer}>
          {/* Direction toggle */}
          <div style={styles.formRow}>
            <div style={{ display: 'flex', gap: 4 }}>
              {['outbound', 'inbound'].map((d) => (
                <button
                  key={d}
                  style={{
                    ...styles.directionBtn,
                    ...(noteDirection === d ? styles.directionBtnActive : {}),
                  }}
                  onClick={() => setNoteDirection(d)}
                >
                  {d === 'outbound' ? '\u2197 Outbound' : '\u2199 Inbound'}
                </button>
              ))}
            </div>
            <select
              className={forms.fieldInput}
              style={{ padding: '4px 8px', fontSize: 12, maxWidth: 160 }}
              value={noteOutcome}
              onChange={(e) => setNoteOutcome(e.target.value)}
            >
              <option value="">Outcome...</option>
              {NOTE_OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* Note text input */}
          <div className={forms.noteInputRow}>
            <input
              className={forms.noteInput}
              placeholder="What was discussed or attempted..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
              autoFocus
            />
            <button
              className={`tc-btn-primary ${btn.primaryBtn}`}
              onClick={handleAddNote}
            >
              Log
            </button>
            <button
              className={btn.secondaryBtn}
              style={{ padding: '11px 16px' }}
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {rcLoading && (
        <div style={styles.loadingRow}>
          <span style={styles.spinner} />
          Loading communication history...
        </div>
      )}

      {/* Error message */}
      {rcError && !rcLoading && (
        <div style={styles.errorRow}>
          {'\u26A0\uFE0F'} {rcError}
        </div>
      )}

      {/* Timeline */}
      <div className={cl.notesList} style={{ maxHeight: 400 }}>
        {mergedTimeline.map((entry) => {
          const isRC = entry.source === 'ringcentral';
          const outcomeInfo = NOTE_OUTCOMES.find((o) => o.value === entry.outcome);
          const ts = entry.timestamp
            ? new Date(entry.timestamp).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : '\u2014';

          return (
            <div key={entry.id} className={cl.noteItem}>
              <div style={styles.entryHeader}>
                {/* Left: timestamp + author */}
                <div className={cl.noteTimestamp}>
                  {ts}
                  {entry.author && (
                    <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>
                      &mdash; {entry.author}
                    </span>
                  )}
                  {isRC && (
                    <span style={styles.rcBadge}>(RingCentral)</span>
                  )}
                </div>

                {/* Right: badges */}
                <div style={styles.badgeRow}>
                  {/* Type badge */}
                  <span style={styles.typeBadge}>
                    {getTypeIcon(entry.type)} {getTypeLabel(entry.type)}
                  </span>

                  {/* Direction badge */}
                  {entry.direction && (
                    <span
                      style={{
                        ...styles.directionBadge,
                        background: entry.direction === 'inbound' ? '#E8F5E9' : '#FFF8ED',
                        color: entry.direction === 'inbound' ? '#388E3C' : '#D97706',
                      }}
                    >
                      {entry.direction === 'inbound' ? '\u2199 In' : '\u2197 Out'}
                    </span>
                  )}

                  {/* Outcome badge */}
                  {outcomeInfo && (
                    <span style={styles.outcomeBadge}>
                      {outcomeInfo.label}
                    </span>
                  )}

                  {/* Recording indicator */}
                  {entry.hasRecording && (
                    <span style={styles.recordingBadge}>
                      Recorded
                    </span>
                  )}
                </div>
              </div>
              <div className={cl.noteText}>{entry.text}</div>
            </div>
          );
        })}

        {/* Empty state */}
        {mergedTimeline.length === 0 && !rcLoading && (
          <div style={styles.emptyState}>
            No communication history yet. Use the buttons above to log your first outreach.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline Styles ───────────────────────────────────────────

const styles = {
  quickActions: {
    display: 'flex',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  quickBtn: {
    padding: '8px 16px',
    borderRadius: 10,
    border: '1px solid #D5DCE6',
    background: '#FFFFFF',
    color: '#2E4E8D',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  quickBtnActive: {
    background: '#EBF0FA',
    borderColor: '#2E4E8D',
    color: '#2E4E8D',
    boxShadow: '0 2px 8px rgba(46,78,141,0.12)',
  },

  formContainer: {
    background: '#F8F9FB',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    border: '1px solid #E2E8F0',
  },
  formRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  directionBtn: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #D1D5DB',
    background: '#FAFBFC',
    color: '#6B7B8F',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  directionBtnActive: {
    borderColor: '#1084C3',
    background: '#EBF5FB',
    color: '#1084C3',
  },

  loadingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    color: '#6B7B8F',
    fontSize: 13,
  },
  spinner: {
    display: 'inline-block',
    width: 14,
    height: 14,
    border: '2px solid #D1D5DB',
    borderTopColor: '#2E4E8D',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  errorRow: {
    padding: '10px 16px',
    color: '#D97706',
    fontSize: 13,
    fontWeight: 500,
  },

  // Timeline entries
  entryHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
    flexWrap: 'wrap',
    gap: 6,
  },
  badgeRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  typeBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#EBF0FA',
    color: '#2E4E8D',
    fontWeight: 600,
  },
  directionBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    fontWeight: 600,
  },
  outcomeBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#F5F5F5',
    color: '#556270',
    fontWeight: 600,
  },
  recordingBadge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#E0F2FE',
    color: '#0284C7',
    fontWeight: 600,
  },
  rcBadge: {
    marginLeft: 8,
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: 500,
  },

  // Empty state
  emptyState: {
    color: '#6B7B8F',
    fontSize: 13,
    padding: 24,
    textAlign: 'center',
    fontWeight: 500,
  },
};
