import { useMemo, useState } from 'react';
import { Plus, RefreshCw, AlertCircle, CheckCircle2, Clock, RotateCcw, XCircle, ListChecks } from 'lucide-react';
import { useApp } from '../../shared/context/AppContext';
import { useExecTasks } from './hooks/useExecTasks';
import { Modal } from './components/Modal';
import { CompleteTaskForm } from './components/CompleteTaskForm';
import { AdHocTaskForm } from './components/AdHocTaskForm';
import s from './ExecTasksPage.module.css';

const STATUS_FILTERS = [
  { value: 'open',      label: 'Open' },
  { value: 'pending',   label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done',      label: 'Completed' },
  { value: 'snoozed',   label: 'Snoozed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all',       label: 'All' },
];

function fmtDue(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function dueClass(iso, status) {
  if (!iso || status === 'done' || status === 'cancelled') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d.getTime() < today.getTime()) return s.dueOverdue;
  if (d.toDateString() === new Date().toDateString()) return s.dueToday;
  return '';
}

function dueLabel(iso, status) {
  if (status === 'done' || status === 'cancelled') return fmtDue(iso);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms = d.getTime() - today.getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return `Overdue · ${fmtDue(iso)}`;
  if (days === 0) return `Due today · ${fmtDue(iso)}`;
  if (days === 1) return `Due tomorrow · ${fmtDue(iso)}`;
  if (days <= 7) return `Due in ${days} days`;
  return fmtDue(iso);
}

const URGENCY_CLS = { critical: s.uCritical, warning: s.uWarning, info: s.uInfo };
const STATUS_CLS  = {
  pending:     s.sPending,
  in_progress: s.sInProgress,
  done:        s.sDone,
  snoozed:     s.sSnoozed,
  cancelled:   s.sCancelled,
};

export function ExecTasksPage() {
  const { showToast } = useApp();
  const [statusFilter, setStatusFilter] = useState('open');
  const { loading, submitting, tasks, error, refresh,
    createTask, completeTask, snoozeTask, cancelTask, reopenTask,
  } = useExecTasks(statusFilter);

  const [completing, setCompleting] = useState(null);
  const [creating, setCreating]     = useState(false);

  const sortedTasks = useMemo(() => {
    return [...(tasks ?? [])].sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
  }, [tasks]);

  async function handleSubmitCompletion(payload) {
    await completeTask(completing.id, payload);
    showToast?.('Task completed.');
    setCompleting(null);
  }

  async function handleCreateAdHoc(draft) {
    await createTask(draft);
    showToast?.('Task created.');
    setCreating(false);
  }

  async function handleSnooze(task) {
    const ans = window.prompt('Snooze until (YYYY-MM-DD):');
    if (!ans) return;
    try {
      await snoozeTask(task.id, new Date(ans + 'T09:00:00').toISOString());
      showToast?.('Snoozed.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not snooze.');
    }
  }

  async function handleCancel(task) {
    const reason = window.prompt('Cancellation reason (optional):');
    if (reason === null) return; // user clicked Cancel
    try {
      await cancelTask(task.id, reason);
      showToast?.('Task cancelled.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not cancel.');
    }
  }

  async function handleReopen(task) {
    try {
      await reopenTask(task.id);
      showToast?.('Task reopened.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not reopen.');
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>
            <ListChecks size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Executive tasks
          </h1>
          <p className={s.subtitle}>
            Lifecycle check-ins, recurring exec responsibilities, and ad-hoc work. The daily
            generator (10:00 UTC) materializes instances from active templates.
          </p>
        </div>
        <div className={s.headerRight}>
          <button type="button" className={s.secondaryBtn} onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button type="button" className={s.primaryBtn} onClick={() => setCreating(true)} disabled={submitting}>
            <Plus size={14} />
            New task
          </button>
        </div>
      </div>

      <div className={s.filters} role="tablist" aria-label="Status filter">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={statusFilter === f.value}
            className={`${s.filterBtn} ${statusFilter === f.value ? s.active : ''}`}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className={s.error}>
          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {error?.message ?? 'Could not load tasks.'}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading tasks…</div>
      ) : sortedTasks.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>No tasks in this view</div>
          <div>
            {statusFilter === 'open'
              ? 'Nothing on the docket right now. Enable a template on the Templates page or create an ad-hoc task.'
              : `No ${statusFilter} tasks.`}
          </div>
        </div>
      ) : (
        <div className={s.taskList}>
          {sortedTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              submitting={submitting}
              onComplete={() => setCompleting(t)}
              onSnooze={() => handleSnooze(t)}
              onCancel={() => handleCancel(t)}
              onReopen={() => handleReopen(t)}
            />
          ))}
        </div>
      )}

      {completing && (
        <Modal title={`Complete — ${completing.title}`} onClose={() => setCompleting(null)}>
          {completing.exec_task_templates?.structured_questions?.length > 0 && (
            <p className={s.taskMeta} style={{ marginBottom: 12 }}>
              Fill in the structured questions, then click Mark complete.
            </p>
          )}
          {completing.description && (
            <div style={{ fontSize: 13, color: '#3A4A66', marginBottom: 14, lineHeight: 1.45 }}>
              {completing.description}
            </div>
          )}
          <CompleteTaskForm
            task={completing}
            submitting={submitting}
            onCancel={() => setCompleting(null)}
            onSubmit={handleSubmitCompletion}
          />
        </Modal>
      )}

      {creating && (
        <Modal title="New ad-hoc task" onClose={() => setCreating(false)}>
          {/* defaultAssignee intentionally omitted — blank fans out
              to every owner when the task comes due, matching the
              recurring/lifecycle default behavior. */}
          <AdHocTaskForm
            submitting={submitting}
            onCancel={() => setCreating(false)}
            onSave={handleCreateAdHoc}
          />
        </Modal>
      )}
    </div>
  );
}

function TaskRow({ task, submitting, onComplete, onSnooze, onCancel, onReopen }) {
  const isDone = task.status === 'done';
  const isCancelled = task.status === 'cancelled';
  const isTerminal = isDone || isCancelled;

  return (
    <div className={s.taskRow}>
      <div>
        <h3 className={s.taskTitle}>
          {task.title}
          <span className={`${s.statusBadge} ${STATUS_CLS[task.status] ?? ''}`}>{task.status}</span>
          <span className={`${s.urgencyBadge} ${URGENCY_CLS[task.urgency] ?? ''}`}>{task.urgency}</span>
        </h3>
        <p className={s.taskMeta}>
          <span className={`${s.dueBadge} ${dueClass(task.due_at, task.status)}`}>{dueLabel(task.due_at, task.status)}</span>
          {' · '}
          {task.assigned_to || 'all owners'}
          {task.anchor_staff_email && <> · For {task.anchor_staff_email}</>}
          {task.recurrence_period && <> · {task.recurrence_period}</>}
        </p>
        {task.description && <p className={s.taskDescription}>{task.description}</p>}
        {isDone && task.completion_notes && (
          <p className={s.taskMeta} style={{ marginTop: 6 }}>
            Notes: {task.completion_notes}
          </p>
        )}
      </div>
      <div className={s.taskActions}>
        {!isTerminal && (
          <button type="button" className={s.primaryBtn} onClick={onComplete} disabled={submitting}>
            <CheckCircle2 size={14} />
            Complete
          </button>
        )}
        {!isTerminal && (
          <button type="button" className={s.iconBtn} onClick={onSnooze} disabled={submitting} title="Snooze">
            <Clock size={16} />
          </button>
        )}
        {!isTerminal && (
          <button type="button" className={`${s.iconBtn} ${s.danger}`} onClick={onCancel} disabled={submitting} title="Cancel">
            <XCircle size={16} />
          </button>
        )}
        {isDone && (
          <button type="button" className={s.secondaryBtn} onClick={onReopen} disabled={submitting} title="Reopen">
            <RotateCcw size={14} />
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}
