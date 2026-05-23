// Inline "Upcoming follow-ups" panel — drops onto the caregiver or
// client detail page so staff working a single record can see (and
// dispatch) follow-ups without bouncing to the Tasks dashboard.
//
// Reads from FollowUpContext so it stays in sync with the dashboard
// and realtime updates. Filtered to the current entity.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, AlertTriangle, X } from 'lucide-react';
import { useFollowUps } from '../../shared/context/FollowUpContext';

/**
 * @param {object} props
 * @param {'caregiver'|'client'} props.kind
 * @param {string} props.entityId — caregivers.id or clients.id
 */
export function UpcomingFollowUpsPanel({ kind, entityId }) {
  const { tasks, loaded, markDone, snooze } = useFollowUps();
  const [expandedId, setExpandedId] = useState(null);

  const mine = useMemo(() => {
    if (!entityId) return [];
    const key = kind === 'caregiver' ? 'caregiverId' : 'clientId';
    return tasks
      .filter((t) => t[key] === entityId && t.status === 'pending')
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .slice(0, 5); // top 5 most urgent; full list lives on /tasks
  }, [tasks, kind, entityId]);

  if (!loaded) {
    return null;
  }
  if (mine.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={headerStyle}>Upcoming follow-ups</div>
        <div style={emptyStyle}>No pending follow-ups for this {kind}.</div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        Upcoming follow-ups
        <Link to="/tasks" style={viewAllLinkStyle}>View all →</Link>
      </div>
      {mine.map((t) => (
        <Row
          key={t.id}
          task={t}
          expanded={expandedId === t.id}
          onToggle={() => setExpandedId((c) => c === t.id ? null : t.id)}
          onMarkDone={(note) => markDone(t.id, note)}
          onSnooze={() => snooze(t.id, new Date(Date.now() + 24 * 60 * 60 * 1000))}
        />
      ))}
    </div>
  );
}

function Row({ task, expanded, onToggle, onMarkDone, onSnooze }) {
  const [note, setNote] = useState('');
  return (
    <div style={rowStyle(task.urgency)}>
      <div style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={onToggle}>
        <UrgencyIcon urgency={task.urgency} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{task.template?.name ?? 'Follow-up'}</div>
          <div style={{ fontSize: 11, color: '#5D6B7F' }}>{formatDueLabel(task.dueAt)}</div>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          {task.template?.guidance && (
            <div style={{ fontSize: 12, color: '#3D4A5D', marginBottom: 8, whiteSpace: 'pre-wrap' }}>
              {task.template.guidance}
            </div>
          )}
          <input
            type="text"
            placeholder="Optional note..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={noteInputStyle}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" style={btnPrimaryStyle} onClick={() => { onMarkDone(note); setNote(''); }}>
              <CheckCircle2 size={12} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
              Done
            </button>
            <button type="button" style={btnSecondaryStyle} onClick={onSnooze}>
              <Clock size={12} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
              Snooze 1d
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDueLabel(iso) {
  if (!iso) return '';
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDiff = Math.floor((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDiff < 0) return `${Math.abs(dayDiff)} days overdue`;
  if (dayDiff === 0) return 'Due today';
  if (dayDiff === 1) return 'Due tomorrow';
  if (dayDiff < 7) return `Due in ${dayDiff} days`;
  return `Due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function UrgencyIcon({ urgency }) {
  if (urgency === 'critical') return <AlertTriangle size={14} style={{ color: '#DC3545', marginRight: 8 }} />;
  if (urgency === 'warning')  return <Clock size={14} style={{ color: '#D97706', marginRight: 8 }} />;
  return <CheckCircle2 size={14} style={{ color: '#1084C3', marginRight: 8 }} />;
}

// ─── Inline styles ─────────────────────────────────────────

const cardStyle = {
  background: '#fff', borderRadius: 12, border: '1px solid #E0E4EA',
  padding: 16, marginBottom: 16,
};
const headerStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: 11, fontWeight: 700, color: '#5D6B7F',
  textTransform: 'uppercase', letterSpacing: '1.2px',
  marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #EDF0F4',
};
const viewAllLinkStyle = {
  fontSize: 12, fontWeight: 600, color: 'var(--tc-cyan)',
  textTransform: 'none', letterSpacing: 0, textDecoration: 'none',
};
const emptyStyle = { fontSize: 12, color: '#7A8BA0', padding: '8px 0' };

function rowStyle(urgency) {
  return {
    padding: '10px 0',
    borderBottom: '1px solid #F2F4F8',
    background: urgency === 'critical' ? 'rgba(220,53,69,0.03)' : 'transparent',
  };
}

const noteInputStyle = {
  width: '100%', padding: '6px 10px', border: '1px solid #E0E4EA',
  borderRadius: 6, fontSize: 12, boxSizing: 'border-box',
};
const btnPrimaryStyle = {
  padding: '4px 10px', border: 'none', borderRadius: 6,
  background: 'var(--tc-navy)', color: '#fff', fontSize: 12, cursor: 'pointer',
};
const btnSecondaryStyle = {
  padding: '4px 10px', border: '1px solid #E0E4EA', borderRadius: 6,
  background: '#fff', color: 'var(--tc-text-secondary)', fontSize: 12, cursor: 'pointer',
};
