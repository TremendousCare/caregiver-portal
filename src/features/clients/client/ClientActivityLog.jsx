import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { buildRecordingUrl } from '../../../lib/recording';
import cl from './client.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';

// ─── Constants ──────────────────────────────────────────────
const NOTE_TYPES = [
  { value: 'note', label: 'Note', icon: '📝' },
  { value: 'call', label: 'Call', icon: '📞' },
  { value: 'text', label: 'Text', icon: '💬' },
  { value: 'email', label: 'Email', icon: '✉️' },
  { value: 'meeting', label: 'Meeting', icon: '🤝' },
  { value: 'auto', label: 'Auto', icon: '⚙️' },
];

const COMM_TYPES = ['call', 'text', 'email', 'meeting'];

const NOTE_OUTCOMES = [
  { value: 'answered', label: 'Answered' },
  { value: 'voicemail', label: 'Left Voicemail' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'busy', label: 'Busy' },
  { value: 'scheduled', label: 'Scheduled Follow-Up' },
  { value: 'completed', label: 'Completed' },
];

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9+]/g, '');
}

// ─── Unified Activity Log ───────────────────────────────────
export function ClientActivityLog({ client, currentUser, onAddNote }) {
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('note');
  const [noteDirection, setNoteDirection] = useState('outbound');
  const [noteOutcome, setNoteOutcome] = useState('');
  const [filterType, setFilterType] = useState('all');

  // RingCentral data
  const [rcData, setRcData] = useState({ sms: [], calls: [] });
  const [rcLoading, setRcLoading] = useState(false);
  const [rcError, setRcError] = useState(null);

  // Recording playback state
  const [playingRecordingId, setPlayingRecordingId] = useState(null);
  const [recordingError, setRecordingError] = useState(null);
  const accessTokenRef = useRef('');

  // Get Supabase access token for recording playback URLs
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      accessTokenRef.current = session?.access_token || '';
    });
  }, []);

  const isCommType = COMM_TYPES.includes(noteType);

  // ─── Fetch RingCentral Data ─────────────────────────────
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

    return () => { cancelled = true; };
  }, [client?.id, client?.phone]);

  // ─── Merge Portal Notes + RC Data ───────────────────────
  const mergedTimeline = useMemo(() => {
    const portalEntries = (client.notes || []).map((n, i) => ({
      ...n,
      id: `portal-${i}`,
      source: n.source || 'portal',
      timestamp: n.timestamp || n.date,
    }));

    const rcEntries = [...rcData.sms, ...rcData.calls].map((rc, i) => ({
      ...rc,
      id: `rc-${i}`,
      source: 'ringcentral',
    }));

    // Dedup: skip RC entries that match portal notes within 2 minutes
    const commTypes = ['call', 'text', 'sms', 'email', 'meeting'];
    const portalOutboundTexts = portalEntries.filter(
      (n) => (n.type === 'text' || n.type === 'sms') && n.direction === 'outbound' && n.source === 'portal'
    );
    const portalRCNotes = portalEntries.filter((n) => n.source === 'ringcentral');

    const deduped = rcEntries.filter((rc) => {
      const rcTime = new Date(rc.timestamp).getTime();
      if ((rc.type === 'text' || rc.type === 'sms') && rc.direction === 'outbound') {
        if (portalOutboundTexts.some((pn) => Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000))
          return false;
      }
      if (portalRCNotes.some((pn) => {
        if (pn.type !== rc.type || pn.direction !== rc.direction) return false;
        return Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000;
      }))
        return false;
      return true;
    });

    let all = [...portalEntries, ...deduped].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Apply filter
    if (filterType !== 'all') {
      if (filterType === 'comms') {
        all = all.filter((e) => commTypes.includes(e.type));
      } else {
        all = all.filter((e) => e.type === filterType || (filterType === 'text' && e.type === 'sms'));
      }
    }

    return all;
  }, [client.notes, rcData, filterType]);

  // ─── Add Note Handler ───────────────────────────────────
  const handleAddNote = () => {
    if (!noteText.trim()) return;
    const note = { text: noteText.trim(), type: noteType };
    if (isCommType) {
      note.direction = noteDirection;
      if (noteOutcome) note.outcome = noteOutcome;
    }
    onAddNote(client.id, note);
    setNoteText('');
    setNoteOutcome('');
  };

  // ─── Type helpers ───────────────────────────────────────
  const getTypeInfo = (type) => NOTE_TYPES.find((t) => t.value === type || (t.value === 'text' && type === 'sms'));
  const outcomeInfo = (val) => NOTE_OUTCOMES.find((o) => o.value === val);

  // ─── Filter options ─────────────────────────────────────
  const FILTER_OPTIONS = [
    { value: 'all', label: 'All' },
    { value: 'comms', label: 'Communications' },
    { value: 'note', label: 'Notes' },
    { value: 'auto', label: 'Auto' },
  ];

  return (
    <div className={cl.notesSection}>
      <h3 className={cl.notesSectionTitle}>📋 Activity Log</h3>

      {/* Input section */}
      <div style={styles.inputSection}>
        {/* Type selector pills */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          {NOTE_TYPES.map((t) => (
            <button
              key={t.value}
              style={{
                padding: '5px 12px', borderRadius: 20, border: '1px solid',
                borderColor: noteType === t.value ? '#2E4E8D' : '#D1D5DB',
                background: noteType === t.value ? '#EBF0FA' : '#FAFBFC',
                color: noteType === t.value ? '#2E4E8D' : '#6B7B8F',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
              onClick={() => setNoteType(t.value)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Direction + Outcome row (only for communication types) */}
        {isCommType && (
          <div style={styles.formRow}>
            <div style={{ display: 'flex', gap: 4 }}>
              {['outbound', 'inbound'].map((dir) => (
                <button
                  key={dir}
                  style={{
                    ...styles.directionBtn,
                    ...(noteDirection === dir ? styles.directionBtnActive : {}),
                  }}
                  onClick={() => setNoteDirection(dir)}
                >
                  {dir === 'outbound' ? '↗ Outbound' : '↙ Inbound'}
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
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Note text input */}
        <div className={forms.noteInputRow}>
          <input
            className={forms.noteInput}
            placeholder={isCommType ? 'What was discussed or attempted...' : noteType === 'note' ? 'Add an internal note...' : 'Add a note...'}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
          />
          <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleAddNote}>
            {isCommType ? 'Log' : 'Add'}
          </button>
        </div>
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#6B7B8F', fontWeight: 600, marginRight: 4 }}>Show:</span>
        {FILTER_OPTIONS.map((f) => (
          <button
            key={f.value}
            style={{
              padding: '3px 10px', borderRadius: 14, border: '1px solid',
              borderColor: filterType === f.value ? '#2E4E8D' : '#E2E8F0',
              background: filterType === f.value ? '#EBF0FA' : '#fff',
              color: filterType === f.value ? '#2E4E8D' : '#6B7B8F',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
            onClick={() => setFilterType(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading indicator */}
      {rcLoading && (
        <div style={styles.loadingRow}>
          <span style={styles.spinner} />
          Loading communication history...
        </div>
      )}

      {/* Error message */}
      {rcError && !rcLoading && (
        <div style={styles.errorRow}>⚠️ {rcError}</div>
      )}

      {/* Unified timeline */}
      <div className={cl.notesList} style={{ maxHeight: 500 }}>
        {mergedTimeline.map((entry) => {
          const isRC = entry.source === 'ringcentral';
          const typeInfo = getTypeInfo(entry.type);
          const outcome = outcomeInfo(entry.outcome);
          const isComm = COMM_TYPES.includes(entry.type) || entry.type === 'sms';
          const ts = entry.timestamp
            ? new Date(entry.timestamp).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })
            : '—';

          return (
            <div key={entry.id} className={cl.noteItem}>
              <div style={styles.entryHeader}>
                <div className={cl.noteTimestamp}>
                  {ts}
                  {entry.author && (
                    <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>
                      &mdash; {entry.author}
                    </span>
                  )}
                  {isRC && <span style={styles.rcBadge}>(RingCentral)</span>}
                </div>

                <div style={styles.badgeRow}>
                  {/* Type badge */}
                  {entry.type && entry.type !== 'note' && (
                    <span style={styles.typeBadge}>
                      {typeInfo?.icon || '📝'} {typeInfo?.label || entry.type}
                    </span>
                  )}

                  {/* Direction badge */}
                  {isComm && entry.direction && (
                    <span style={{
                      ...styles.directionBadge,
                      background: entry.direction === 'inbound' ? '#E8F5E9' : '#FFF8ED',
                      color: entry.direction === 'inbound' ? '#388E3C' : '#D97706',
                    }}>
                      {entry.direction === 'inbound' ? '↙ In' : '↗ Out'}
                    </span>
                  )}

                  {/* Outcome badge */}
                  {outcome && <span style={styles.outcomeBadge}>{outcome.label}</span>}

                  {/* Recording playback */}
                  {entry.hasRecording && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlayingRecordingId(playingRecordingId === entry.recordingId ? null : entry.recordingId);
                        setRecordingError(null);
                      }}
                      style={{
                        ...styles.recordingBtn,
                        ...(playingRecordingId === entry.recordingId ? styles.recordingBtnActive : {}),
                        opacity: entry.recordingId ? 1 : 0.5,
                        cursor: entry.recordingId ? 'pointer' : 'default',
                      }}
                      title={entry.recordingId ? 'Play/stop recording' : 'Recording ID unavailable'}
                      disabled={!entry.recordingId}
                    >
                      {playingRecordingId === entry.recordingId ? '⏹ Stop' : '▶ Play'}
                    </button>
                  )}
                </div>
              </div>
              <div className={cl.noteText}>{entry.text}</div>
              {playingRecordingId && playingRecordingId === entry.recordingId && (
                <div style={{ marginTop: 8, padding: '4px 0' }}>
                  <audio
                    controls
                    autoPlay
                    src={buildRecordingUrl(entry.recordingId, accessTokenRef.current)}
                    onError={() => setRecordingError(entry.recordingId)}
                    onEnded={() => setPlayingRecordingId(null)}
                    style={{ width: '100%', height: 36, borderRadius: 8 }}
                  />
                  {recordingError === entry.recordingId && (
                    <div style={{ color: '#DC3545', fontSize: 12, marginTop: 4 }}>
                      Failed to load recording. It may have expired or been removed.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {mergedTimeline.length === 0 && !rcLoading && (
          <div style={{ color: '#6B7B8F', fontSize: 13, padding: 24, textAlign: 'center', fontWeight: 500 }}>
            No activity yet. Log your outreach and communications here.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline Styles ──────────────────────────────────────────
const styles = {
  inputSection: {
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
  recordingBtn: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#E0F2FE',
    color: '#0284C7',
    fontWeight: 600,
    border: 'none',
    fontFamily: 'inherit',
  },
  recordingBtnActive: {
    background: '#0284C7',
    color: '#fff',
  },
  rcBadge: {
    marginLeft: 8,
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: 500,
  },
};
