import { useState } from 'react';
import cl from './client.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';

const NOTE_TYPES = [
  { value: 'note', label: 'Internal Note', icon: '📝' },
  { value: 'call', label: 'Phone Call', icon: '📞' },
  { value: 'text', label: 'Text Message', icon: '💬' },
  { value: 'email', label: 'Email', icon: '✉️' },
  { value: 'meeting', label: 'Meeting', icon: '🤝' },
  { value: 'auto', label: 'Auto', icon: '⚙️' },
];

export function ClientActivityLog({ client, onAddNote }) {
  const [noteText, setNoteText] = useState('');
  const [noteType, setNoteType] = useState('note');

  const handleAddNote = () => {
    if (!noteText.trim()) return;
    onAddNote(client.id, { text: noteText.trim(), type: noteType });
    setNoteText('');
  };

  // Sort notes in reverse chronological order
  const sortedNotes = [...(client.notes || [])].sort(
    (a, b) => new Date(b.timestamp || b.date || 0).getTime() - new Date(a.timestamp || a.date || 0).getTime()
  );

  return (
    <div className={cl.notesSection}>
      <h3 className={cl.notesSectionTitle}>📝 Activity Log</h3>

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

      {/* Note text input */}
      <div className={forms.noteInputRow}>
        <input
          className={forms.noteInput}
          placeholder={noteType !== 'note' ? 'What was discussed or attempted...' : 'Add an internal note...'}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
        />
        <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleAddNote}>Add</button>
      </div>

      {/* Notes timeline */}
      <div className={cl.notesList}>
        {sortedNotes.map((n, i) => {
          const typeInfo = NOTE_TYPES.find((t) => t.value === n.type);
          return (
            <div key={i} className={cl.noteItem}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <div className={cl.noteTimestamp}>
                  {new Date(n.timestamp || n.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {n.author && <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>— {n.author}</span>}
                </div>
                {n.type && n.type !== 'note' && (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#EBF0FA', color: '#2E4E8D', fontWeight: 600 }}>
                    {typeInfo?.icon || '📝'} {typeInfo?.label || n.type}
                  </span>
                )}
              </div>
              <div className={cl.noteText}>{n.text}</div>
            </div>
          );
        })}
        {sortedNotes.length === 0 && (
          <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>
            No activity yet. Log your outreach and communications here.
          </div>
        )}
      </div>
    </div>
  );
}
