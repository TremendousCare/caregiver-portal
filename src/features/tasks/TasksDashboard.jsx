// Tasks dashboard — single inbox view of follow-up tasks (migration
// 20260525000000), grouped by urgency.
//
// Layout decided 2026-05-23 with the owner:
//   • One scrolling list, sorted urgency-first
//   • Date-divider headers: OVERDUE / TODAY / TOMORROW / THIS WEEK / LATER
//   • Filter chips at the top: All / Mine / Caregiver / Client
//   • Each row is one line collapsed; click to expand guidance + actions
//
// Existing per-entity "action item rules" stay on the Caregiver and
// Client dashboards — they are NOT mirrored here, per the locked
// scope decision. This page is concrete tasks only.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock, AlertTriangle, ChevronDown, ChevronUp, X, User, Home } from 'lucide-react';
import { useFollowUps } from '../../shared/context/FollowUpContext';
import { useApp } from '../../shared/context/AppContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import { useClients } from '../../shared/context/ClientContext';
import { bucketFollowUps } from '../../lib/followUpTasks';
import layout from '../../styles/layout.module.css';
import btn from '../../styles/buttons.module.css';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'caregiver', label: 'Caregiver-side' },
  { id: 'client', label: 'Client-side' },
];

export function TasksDashboard() {
  const { tasks, loaded, markDone, snooze, cancel } = useFollowUps();
  const { currentUserName } = useApp();
  const { caregivers } = useCaregivers();
  const { clients } = useClients();
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  // Index entities for fast name lookup in each task card.
  const caregiverById = useMemo(() => {
    const m = new Map();
    for (const c of caregivers || []) m.set(c.id, c);
    return m;
  }, [caregivers]);
  const clientById = useMemo(() => {
    const m = new Map();
    for (const c of clients || []) m.set(c.id, c);
    return m;
  }, [clients]);

  // Apply the active filter chip. Snoozed tasks are hidden by default
  // (they re-emerge once snoozed_until passes — a v2 cron will flip
  // them back to 'pending', but the dashboard already excludes them
  // from the visible buckets so today's UX is correct).
  const filtered = useMemo(() => {
    let list = tasks.filter((t) => t.status === 'pending');
    if (filter === 'mine') {
      list = list.filter((t) => (t.assignedTo || '').toLowerCase() === (currentUserName || '').toLowerCase());
    } else if (filter === 'caregiver') {
      list = list.filter((t) => t.template?.targetType === 'caregiver' || t.template?.targetType === 'both');
    } else if (filter === 'client') {
      list = list.filter((t) => t.template?.targetType === 'client' || t.template?.targetType === 'both');
    }
    return list;
  }, [tasks, filter, currentUserName]);

  const buckets = useMemo(() => bucketFollowUps(filtered), [filtered]);

  if (!loaded) {
    return <div style={loadingStyle}>Loading tasks...</div>;
  }

  const totalOpen = filtered.length;
  const overdueCount = buckets.overdue.length;
  const todayCount = buckets.today.length;

  return (
    <div>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Tasks</h1>
          <p className={layout.pageSubtitle}>
            {totalOpen === 0
              ? 'You’re all caught up. New follow-ups appear here automatically when caregivers are matched to clients.'
              : `${overdueCount} overdue · ${todayCount} due today · ${totalOpen} open total`}
          </p>
        </div>
      </div>

      <div style={chipRowStyle}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            style={chipStyle(filter === f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {totalOpen === 0 ? (
        <EmptyState />
      ) : (
        <div style={listWrapStyle}>
          <Section
            label="Overdue"
            count={buckets.overdue.length}
            tone="critical"
            tasks={buckets.overdue}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            caregiverById={caregiverById}
            clientById={clientById}
            onMarkDone={markDone}
            onSnooze={snooze}
            onCancel={cancel}
          />
          <Section
            label="Today"
            count={buckets.today.length}
            tone="warning"
            tasks={buckets.today}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            caregiverById={caregiverById}
            clientById={clientById}
            onMarkDone={markDone}
            onSnooze={snooze}
            onCancel={cancel}
          />
          <Section
            label="Tomorrow"
            count={buckets.tomorrow.length}
            tasks={buckets.tomorrow}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            caregiverById={caregiverById}
            clientById={clientById}
            onMarkDone={markDone}
            onSnooze={snooze}
            onCancel={cancel}
          />
          <Section
            label="This week"
            count={buckets.thisWeek.length}
            tasks={buckets.thisWeek}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            caregiverById={caregiverById}
            clientById={clientById}
            onMarkDone={markDone}
            onSnooze={snooze}
            onCancel={cancel}
          />
          <Section
            label="Later"
            count={buckets.later.length}
            tasks={buckets.later}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            caregiverById={caregiverById}
            clientById={clientById}
            onMarkDone={markDone}
            onSnooze={snooze}
            onCancel={cancel}
          />
        </div>
      )}
    </div>
  );
}

// ─── Section ───────────────────────────────────────────────

function Section({ label, count, tone, tasks, expandedId, setExpandedId, caregiverById, clientById, onMarkDone, onSnooze, onCancel }) {
  if (!tasks || tasks.length === 0) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={sectionHeaderStyle(tone)}>
        {label} <span style={sectionCountStyle}>{count}</span>
      </div>
      <div>
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            expanded={expandedId === t.id}
            onToggle={() => setExpandedId((cur) => cur === t.id ? null : t.id)}
            caregiver={caregiverById.get(t.caregiverId)}
            client={clientById.get(t.clientId)}
            onMarkDone={onMarkDone}
            onSnooze={onSnooze}
            onCancel={onCancel}
          />
        ))}
      </div>
    </div>
  );
}

// ─── TaskRow ───────────────────────────────────────────────

function TaskRow({ task, expanded, onToggle, caregiver, client, onMarkDone, onSnooze, onCancel }) {
  const navigate = useNavigate();
  const [note, setNote] = useState('');

  const cgName = caregiver ? `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim() || caregiver.id : task.caregiverId;
  const clName = client ? `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.id : task.clientId;

  const dueLabel = formatDueLabel(task.dueAt);

  return (
    <div style={rowWrapStyle(task.urgency)}>
      <div style={rowSummaryStyle} onClick={onToggle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={rowTitleStyle}>
            <UrgencyIcon urgency={task.urgency} />
            <span style={{ fontWeight: 600 }}>{task.template?.name ?? 'Follow-up'}</span>
          </div>
          <div style={rowMetaStyle}>
            <span>{cgName} <span style={{ opacity: 0.5 }}>↔</span> {clName}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{dueLabel}</span>
            {task.assignedTo && (
              <>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>Assigned to {task.assignedTo}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ marginLeft: 8 }}>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>

      {expanded && (
        <div style={rowExpandedStyle} onClick={(e) => e.stopPropagation()}>
          {task.template?.guidance && (
            <div style={guidanceStyle}>{task.template.guidance}</div>
          )}

          <div style={contextLinksStyle}>
            <button
              type="button"
              style={contextLinkBtnStyle}
              onClick={() => navigate(`/caregiver/${task.caregiverId}`)}
            >
              <User size={14} /> Caregiver: {cgName}
            </button>
            <button
              type="button"
              style={contextLinkBtnStyle}
              onClick={() => navigate(`/clients/${task.clientId}`)}
            >
              <Home size={14} /> Client: {clName}
            </button>
          </div>

          <div style={noteRowStyle}>
            <input
              type="text"
              placeholder="Optional note for the completion log..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={noteInputStyle}
            />
          </div>

          <div style={actionsRowStyle}>
            <button
              type="button"
              className={btn.primaryBtn}
              onClick={() => { onMarkDone(task.id, note); setNote(''); }}
            >
              <CheckCircle2 size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              Mark done
            </button>
            <button
              type="button"
              className={btn.secondaryBtn}
              onClick={() => onSnooze(task.id, addHours(new Date(), 24))}
            >
              <Clock size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              Snooze 1 day
            </button>
            <button
              type="button"
              className={btn.secondaryBtn}
              onClick={() => {
                const reason = window.prompt('Cancel this task — why?');
                if (reason !== null && reason !== '') onCancel(task.id, reason);
              }}
            >
              <X size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────

function addHours(d, h) {
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

function formatDueLabel(iso) {
  if (!iso) return '';
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDiff = Math.floor((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const time = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (dayDiff < 0) return `${Math.abs(dayDiff)}d overdue`;
  if (dayDiff === 0) return `today · ${time}`;
  if (dayDiff === 1) return `tomorrow · ${time}`;
  if (dayDiff < 7) return due.toLocaleDateString(undefined, { weekday: 'short' });
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function UrgencyIcon({ urgency }) {
  if (urgency === 'critical') return <AlertTriangle size={14} style={{ color: '#DC3545', marginRight: 6, verticalAlign: 'text-bottom' }} />;
  if (urgency === 'warning')  return <Clock size={14} style={{ color: '#D97706', marginRight: 6, verticalAlign: 'text-bottom' }} />;
  return <CheckCircle2 size={14} style={{ color: '#1084C3', marginRight: 6, verticalAlign: 'text-bottom' }} />;
}

function EmptyState() {
  return (
    <div style={emptyStateStyle}>
      <CheckCircle2 size={32} style={{ color: '#15803D', marginBottom: 8 }} />
      <div style={{ fontWeight: 600, marginBottom: 4 }}>No open follow-ups.</div>
      <div style={{ fontSize: 13, color: '#7A8BA0' }}>
        New tasks appear here automatically when a caregiver is matched to a new client.
      </div>
    </div>
  );
}

// ─── Inline styles ─────────────────────────────────────────

const loadingStyle = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40vh', color: '#7A8BA0' };

const chipRowStyle = { display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' };

function chipStyle(selected) {
  return {
    padding: '6px 14px',
    borderRadius: 999,
    border: selected ? '1px solid var(--tc-cyan)' : '1px solid #E0E4EA',
    background: selected ? 'rgba(41,190,228,0.12)' : '#fff',
    color: selected ? 'var(--tc-navy)' : 'var(--tc-text-secondary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  };
}

const listWrapStyle = { background: '#fff', borderRadius: 12, border: '1px solid #E0E4EA', overflow: 'hidden' };

function sectionHeaderStyle(tone) {
  const palette = tone === 'critical'
    ? { bg: 'rgba(220,53,69,0.06)', fg: '#DC3545' }
    : tone === 'warning'
    ? { bg: 'rgba(217,119,6,0.06)', fg: '#D97706' }
    : { bg: '#F7F9FB', fg: '#5D6B7F' };
  return {
    padding: '10px 16px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1.2px',
    color: palette.fg,
    background: palette.bg,
    borderBottom: '1px solid #EDF0F4',
  };
}

const sectionCountStyle = { marginLeft: 8, padding: '1px 8px', borderRadius: 999, background: '#fff', fontSize: 11 };

function rowWrapStyle(urgency) {
  return {
    borderBottom: '1px solid #EDF0F4',
    background: urgency === 'critical' ? 'rgba(220,53,69,0.02)' : '#fff',
  };
}

const rowSummaryStyle = { display: 'flex', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' };
const rowTitleStyle = { fontSize: 14, marginBottom: 2 };
const rowMetaStyle = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5D6B7F', flexWrap: 'wrap' };

const rowExpandedStyle = { padding: '4px 16px 16px', borderTop: '1px solid #F2F4F8', background: '#FAFBFC' };
const guidanceStyle = { fontSize: 13, color: '#3D4A5D', padding: '10px 0', whiteSpace: 'pre-wrap' };

const contextLinksStyle = { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' };
const contextLinkBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '4px 10px', border: '1px solid #E0E4EA', borderRadius: 6,
  background: '#fff', color: 'var(--tc-navy)', fontSize: 12, cursor: 'pointer',
};

const noteRowStyle = { marginBottom: 12 };
const noteInputStyle = {
  width: '100%', padding: '8px 12px', border: '1px solid #E0E4EA',
  borderRadius: 8, fontSize: 13, background: '#fff', boxSizing: 'border-box',
};

const actionsRowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap' };

const emptyStateStyle = {
  background: '#fff', borderRadius: 12, border: '1px solid #E0E4EA',
  padding: 40, textAlign: 'center',
};
