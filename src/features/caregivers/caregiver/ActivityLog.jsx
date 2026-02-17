import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import cg from './caregiver.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';
import { NOTE_TYPES, NOTE_OUTCOMES } from './constants';

export function ActivityLog({ caregiver, onAddNote }) {
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('note');
  const [noteDirection, setNoteDirection] = useState('outbound');
  const [noteOutcome, setNoteOutcome] = useState('');
  const [rcData, setRcData] = useState({ sms: [], calls: [] });
  const [rcLoading, setRcLoading] = useState(false);
  const [showPortalOnly, setShowPortalOnly] = useState(false);

  // Fetch RingCentral communication data
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    let cancelled = false;
    setRcLoading(true);
    supabase.functions.invoke('get-communications', {
      body: { caregiver_id: caregiver.id, days_back: 90 },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        console.warn('RC fetch failed:', error);
        setRcData({ sms: [], calls: [] });
      } else {
        setRcData({ sms: data.sms || [], calls: data.calls || [] });
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('RC fetch error:', err);
        setRcData({ sms: [], calls: [] });
      }
    }).finally(() => {
      if (!cancelled) setRcLoading(false);
    });
    return () => { cancelled = true; };
  }, [caregiver?.id]);

  // Merge portal notes + RC data into unified timeline
  const mergedTimeline = useMemo(() => {
    const portalEntries = (caregiver.notes || []).map((n, i) => ({
      ...n,
      id: `portal-${i}`,
      source: n.source || 'portal',
      timestamp: n.timestamp || n.date,
    }));

    const rcEntries = [...rcData.sms, ...rcData.calls];

    // Deduplication: skip RC entries that match portal notes within 2 minutes
    const portalOutboundTexts = portalEntries.filter(
      (n) => n.type === 'text' && n.direction === 'outbound' && n.source === 'portal'
    );
    const portalRCNotes = portalEntries.filter((n) => n.source === 'ringcentral');
    const deduped = rcEntries.filter((rc) => {
      const rcTime = new Date(rc.timestamp).getTime();
      // Skip RC outbound texts matching portal outbound notes (automation-sent SMS)
      if (rc.type === 'text' && rc.direction === 'outbound') {
        if (portalOutboundTexts.some((pn) => Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000)) return false;
      }
      // Skip RC entries matching webhook-written notes (inbound SMS logged by webhook)
      if (portalRCNotes.some((pn) => {
        if (pn.type !== rc.type || pn.direction !== rc.direction) return false;
        return Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000;
      })) return false;
      return true;
    });

    return [...portalEntries, ...deduped].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [caregiver.notes, rcData]);

  const isCommunication = noteType !== 'note';

  const handleAddNote = () => {
    if (!noteText.trim()) return;
    const note = { text: noteText.trim(), type: noteType };
    if (isCommunication) {
      note.direction = noteDirection;
      if (noteOutcome) note.outcome = noteOutcome;
    }
    onAddNote(caregiver.id, note);
    setNoteText('');
    setNoteOutcome('');
  };

  return (
    <div className={cg.notesSection}>
      <h3 className={cg.notesSectionTitle}>📝 Activity Log</h3>

      {/* Type selector pills */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
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
        <span style={{ width: 1, height: 20, background: '#D1D5DB', margin: '0 4px' }} />
        <button
          style={{
            padding: '5px 12px', borderRadius: 20, border: '1px solid',
            borderColor: showPortalOnly ? '#2E4E8D' : '#D1D5DB',
            background: showPortalOnly ? '#EBF0FA' : '#FAFBFC',
            color: showPortalOnly ? '#2E4E8D' : '#6B7B8F',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
          onClick={() => setShowPortalOnly(!showPortalOnly)}
        >
          {showPortalOnly ? '✓ ' : ''}Internal Notes Only
        </button>
      </div>

      {/* Direction + Outcome row for communications */}
      {isCommunication && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {['outbound', 'inbound'].map((d) => (
              <button
                key={d}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: '1px solid',
                  borderColor: noteDirection === d ? '#1084C3' : '#D1D5DB',
                  background: noteDirection === d ? '#EBF5FB' : '#FAFBFC',
                  color: noteDirection === d ? '#1084C3' : '#6B7B8F',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                }}
                onClick={() => setNoteDirection(d)}
              >
                {d === 'outbound' ? '↗ Outbound' : '↙ Inbound'}
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
            {NOTE_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}

      {/* Note text input */}
      <div className={forms.noteInputRow}>
        <input className={forms.noteInput} placeholder={isCommunication ? 'What was discussed or attempted...' : 'Add an internal note...'} value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddNote()} />
        <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleAddNote}>Add</button>
      </div>

      {/* Merged timeline */}
      {rcLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', color: '#6B7B8F', fontSize: 13 }}>
          <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          Loading communication history...
        </div>
      )}
      <div className={cg.notesList}>
        {(showPortalOnly ? mergedTimeline.filter((n) => n.source !== 'ringcentral') : mergedTimeline).map((n) => {
          const typeInfo = NOTE_TYPES.find((t) => t.value === n.type);
          const outcomeInfo = NOTE_OUTCOMES.find((o) => o.value === n.outcome);
          const isRC = n.source === 'ringcentral';
          return (
            <div key={n.id} className={cg.noteItem}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <div className={cg.noteTimestamp}>
                  {new Date(n.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {n.author && <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>— {n.author}</span>}
                  {isRC && <span style={{ marginLeft: 8, color: '#9CA3AF', fontSize: 11, fontWeight: 500 }}>(RingCentral)</span>}
                </div>
                {(n.type && n.type !== 'note') && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#EBF0FA', color: '#2E4E8D', fontWeight: 600 }}>
                      {typeInfo?.icon || (n.type === 'call' ? '📞' : '💬')} {typeInfo?.label || (n.type === 'call' ? 'Phone Call' : 'Text Message')}
                    </span>
                    {n.direction && (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: n.direction === 'inbound' ? '#E8F5E9' : '#FFF8ED', color: n.direction === 'inbound' ? '#388E3C' : '#D97706', fontWeight: 600 }}>
                        {n.direction === 'inbound' ? '↙ In' : '↗ Out'}
                      </span>
                    )}
                    {outcomeInfo && (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#F5F5F5', color: '#556270', fontWeight: 600 }}>
                        {outcomeInfo.label}
                      </span>
                    )}
                    {n.hasRecording && (
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#E0F2FE', color: '#0284C7', fontWeight: 600 }}>
                        Recorded
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className={cg.noteText}>{n.text}</div>
            </div>
          );
        })}
        {mergedTimeline.length === 0 && !rcLoading && !showPortalOnly && (
          <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>No activity yet. Log your outreach and communications here.</div>
        )}
        {showPortalOnly && mergedTimeline.filter((n) => n.source !== 'ringcentral').length === 0 && (
          <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>No internal notes yet.</div>
        )}
      </div>
    </div>
  );
}
