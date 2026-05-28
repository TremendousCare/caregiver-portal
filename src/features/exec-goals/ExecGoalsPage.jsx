import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, TrendingUp, AlertCircle, BarChart3 } from 'lucide-react';
import { useApp } from '../../shared/context/AppContext';
import { useExecGoals } from './hooks/useExecGoals';
import {
  buildQuarterOptions,
  formatQuarterLabel,
  quarterFromDate,
  sortGoals,
  sortKrs,
  krProgress,
  daysSince,
} from './lib/goalsHelpers';
import { Modal } from './components/Modal';
import { ObjectiveForm } from './components/ObjectiveForm';
import { KeyResultForm } from './components/KeyResultForm';
import { CheckinForm } from './components/CheckinForm';
import s from './ExecGoalsPage.module.css';

// Days after a check-in is considered "stale" and the row badges it.
const STALE_AFTER_DAYS = 10;

function formatMetricValue(v, unit) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (unit) {
    case 'dollars': return `$${n.toLocaleString()}`;
    case 'percent': return `${n}%`;
    case 'rating':  return `${n}★`;
    default:        return n.toLocaleString();
  }
}

function fillClass(confidence) {
  if (confidence === 'green') return s.fillGreen;
  if (confidence === 'yellow') return s.fillYellow;
  if (confidence === 'red') return s.fillRed;
  return s.fillGreen;
}

function ConfidenceChip({ confidence }) {
  const cls = {
    green:  s.confidenceGreen,
    yellow: s.confidenceYellow,
    red:    s.confidenceRed,
  }[confidence] ?? s.confidenceGreen;
  const dot = {
    green:  s.dotGreen,
    yellow: s.dotYellow,
    red:    s.dotRed,
  }[confidence] ?? s.dotGreen;
  return (
    <span className={`${s.confidenceChip} ${cls}`}>
      <span className={`${s.confidenceDot} ${dot}`} />
      {confidence}
    </span>
  );
}

function StatusBadge({ status }) {
  const cls = {
    draft:     s.statusDraft,
    active:    s.statusActive,
    achieved:  s.statusAchieved,
    missed:    s.statusMissed,
    cancelled: s.statusCancelled,
  }[status] ?? s.statusDraft;
  return <span className={`${s.statusBadge} ${cls}`}>{status}</span>;
}

export function ExecGoalsPage() {
  const { currentOrgRole, currentUserEmail, showToast } = useApp();
  const readOnly = currentOrgRole !== 'owner';

  const [quarter, setQuarter] = useState(() => quarterFromDate(new Date()));
  const {
    loading, submitting, goals, error, refresh,
    createGoal, updateGoal, deleteGoal,
    createKr, updateKr, deleteKr,
    checkinKr,
  } = useExecGoals(quarter);

  const [editingGoal, setEditingGoal]   = useState(null);   // { mode: 'create'|'edit', goal? }
  const [editingKr, setEditingKr]       = useState(null);   // { mode, goalId, kr? }
  const [checkinTarget, setCheckinTarget] = useState(null); // kr

  const sortedGoals = useMemo(() => sortGoals(goals), [goals]);
  const quarterOptions = useMemo(() => buildQuarterOptions(goals), [goals]);
  const allQuarters = useMemo(() => {
    // Make sure the currently-selected quarter is in the options list
    // even if it has no goals yet (so the user can switch back to it).
    const set = new Set(quarterOptions);
    if (quarter) set.add(quarter);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [quarterOptions, quarter]);

  // ─── Mutation handlers ────────────────────────────────────
  async function handleSaveGoal(draft) {
    if (editingGoal?.mode === 'edit') {
      await updateGoal(editingGoal.goal.id, draft);
      showToast?.('Objective updated.');
    } else {
      await createGoal(draft);
      showToast?.('Objective created.');
    }
    setEditingGoal(null);
  }

  async function handleSaveKr(draft) {
    if (editingKr?.mode === 'edit') {
      await updateKr(editingKr.kr.id, draft);
      showToast?.('Key result updated.');
    } else {
      await createKr(draft);
      showToast?.('Key result added.');
    }
    setEditingKr(null);
  }

  async function handleSaveCheckin(draft) {
    await checkinKr(draft);
    showToast?.('Check-in recorded.');
    setCheckinTarget(null);
  }

  async function handleDeleteGoal(goal) {
    const krCount = (goal.exec_key_results ?? []).length;
    const msg = krCount > 0
      ? `Delete "${goal.title}" and its ${krCount} key result${krCount === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete "${goal.title}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteGoal(goal.id);
      showToast?.('Objective deleted.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not delete.');
    }
  }

  async function handleDeleteKr(kr) {
    if (!window.confirm(`Delete key result "${kr.title}"? This cannot be undone.`)) return;
    try {
      await deleteKr(kr.id);
      showToast?.('Key result deleted.');
    } catch (e) {
      window.alert(e?.message ?? 'Could not delete.');
    }
  }

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>
            <BarChart3 size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Goals
            {readOnly && <span className={s.roBadge}>Read-only</span>}
          </h1>
          <p className={s.subtitle}>
            Quarterly objectives and key results. {readOnly
              ? 'View-only access — owners set and update goals.'
              : 'Set 3–5 objectives per quarter with 2–4 measurable key results each.'}
          </p>
        </div>
        <div className={s.headerRight}>
          <div className={s.quarterPicker}>
            <span className={s.quarterPickerLabel}>Quarter</span>
            <select
              className={s.quarterPickerSelect}
              value={quarter ?? ''}
              onChange={(e) => setQuarter(e.target.value)}
            >
              {allQuarters.map((q) => (
                <option key={q} value={q}>{formatQuarterLabel(q)}</option>
              ))}
            </select>
          </div>
          <button type="button" className={s.secondaryBtn} onClick={refresh} aria-label="Refresh">
            <RefreshCw size={14} />
            Refresh
          </button>
          {!readOnly && (
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => setEditingGoal({ mode: 'create' })}
              disabled={submitting}
            >
              <Plus size={14} />
              New objective
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className={s.error}>
          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {error?.message ?? 'Could not load goals.'}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading…</div>
      ) : sortedGoals.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>No objectives for {formatQuarterLabel(quarter)} yet</div>
          <div style={{ marginBottom: 14 }}>
            {readOnly
              ? 'An owner has not set objectives for this quarter.'
              : 'Start with 3–5 objectives. Each should be qualitative and inspiring; the measurable progress goes in the key results.'}
          </div>
          {!readOnly && (
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => setEditingGoal({ mode: 'create' })}
              disabled={submitting}
            >
              <Plus size={14} />
              Create first objective
            </button>
          )}
        </div>
      ) : (
        <div className={s.goalsList}>
          {sortedGoals.map((g) => (
            <ObjectiveCard
              key={g.id}
              goal={g}
              readOnly={readOnly}
              onEdit={() => setEditingGoal({ mode: 'edit', goal: g })}
              onDelete={() => handleDeleteGoal(g)}
              onAddKr={() => setEditingKr({ mode: 'create', goalId: g.id })}
              onEditKr={(kr) => setEditingKr({ mode: 'edit', kr })}
              onDeleteKr={(kr) => handleDeleteKr(kr)}
              onCheckinKr={(kr) => setCheckinTarget(kr)}
            />
          ))}
        </div>
      )}

      {editingGoal && (
        <Modal
          title={editingGoal.mode === 'edit' ? 'Edit objective' : 'New objective'}
          onClose={() => setEditingGoal(null)}
        >
          <ObjectiveForm
            initial={editingGoal.goal}
            defaultQuarter={quarter}
            defaultOwner={currentUserEmail}
            submitting={submitting}
            onCancel={() => setEditingGoal(null)}
            onSave={handleSaveGoal}
          />
        </Modal>
      )}

      {editingKr && (
        <Modal
          title={editingKr.mode === 'edit' ? 'Edit key result' : 'New key result'}
          onClose={() => setEditingKr(null)}
        >
          <KeyResultForm
            initial={editingKr.kr}
            goalId={editingKr.goalId}
            defaultOwner={currentUserEmail}
            submitting={submitting}
            onCancel={() => setEditingKr(null)}
            onSave={handleSaveKr}
          />
        </Modal>
      )}

      {checkinTarget && (
        <Modal
          title="Weekly check-in"
          onClose={() => setCheckinTarget(null)}
        >
          <CheckinForm
            kr={checkinTarget}
            submitting={submitting}
            onCancel={() => setCheckinTarget(null)}
            onSave={handleSaveCheckin}
          />
        </Modal>
      )}
    </div>
  );
}

function ObjectiveCard({ goal, readOnly, onEdit, onDelete, onAddKr, onEditKr, onDeleteKr, onCheckinKr }) {
  const krs = sortKrs(goal.exec_key_results);

  return (
    <div className={s.objectiveCard}>
      <div className={s.objectiveHeader}>
        <div className={s.objectiveHeaderLeft}>
          <h3 className={s.objectiveTitle}>
            <TrendingUp size={18} />
            {goal.title}
            <StatusBadge status={goal.status} />
          </h3>
          <p className={s.objectiveMeta}>
            {goal.owner_email} · {krs.length} key result{krs.length === 1 ? '' : 's'}
          </p>
          {goal.description && <p className={s.objectiveDescription}>{goal.description}</p>}
        </div>
        {!readOnly && (
          <div className={s.objectiveActions}>
            <button
              type="button"
              className={s.iconBtn}
              onClick={onEdit}
              aria-label="Edit objective"
              title="Edit objective"
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              className={`${s.iconBtn} ${s.danger}`}
              onClick={onDelete}
              aria-label="Delete objective"
              title="Delete objective"
            >
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </div>

      <div className={s.krList}>
        {krs.length === 0 ? (
          <div style={{ fontSize: 13, color: '#5A6B85', padding: '8px 0' }}>
            No key results yet. {readOnly ? '' : 'Add 2–4 measurable KRs below.'}
          </div>
        ) : (
          krs.map((kr) => (
            <KeyResultRow
              key={kr.id}
              kr={kr}
              readOnly={readOnly}
              onEdit={() => onEditKr(kr)}
              onDelete={() => onDeleteKr(kr)}
              onCheckin={() => onCheckinKr(kr)}
            />
          ))
        )}

        {!readOnly && (
          <button type="button" className={s.addKrBtn} onClick={onAddKr}>
            <Plus size={14} />
            Add key result
          </button>
        )}
      </div>
    </div>
  );
}

function KeyResultRow({ kr, readOnly, onEdit, onDelete, onCheckin }) {
  const progress = krProgress(kr);
  const pctClamped = Math.min(100, Math.max(0, (progress.pct ?? 0) * 100));
  const stale = daysSince(kr.last_checked_in_at) === null
    ? null
    : daysSince(kr.last_checked_in_at);

  return (
    <div className={s.krRow}>
      <div>
        <h4 className={s.krTitle}>
          {kr.title}
          <ConfidenceChip confidence={kr.confidence} />
        </h4>
        <p className={s.krMeta}>
          {kr.owner_email} · {kr.direction === 'decrease' ? '↓' : '↑'}{' '}
          start {formatMetricValue(kr.start_value, kr.metric_unit)} →
          {' '}current {formatMetricValue(kr.current_value, kr.metric_unit)} →
          {' '}target {formatMetricValue(kr.target_value, kr.metric_unit)}
          {' '}({progress.label})
        </p>
        {stale !== null && stale > STALE_AFTER_DAYS && (
          <p className={s.staleHint}>
            <AlertCircle size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            No check-in in {stale} days
          </p>
        )}
        {stale === null && (
          <p className={s.staleHint}>
            <AlertCircle size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            No check-ins yet
          </p>
        )}
      </div>
      <div className={s.krProgress}>
        <div className={s.krProgressTop}>
          <span>{Math.round((progress.pct ?? 0) * 100)}%</span>
          <span>{progress.label}</span>
        </div>
        <div className={s.krProgressBar}>
          <div
            className={`${s.krProgressFill} ${fillClass(kr.confidence)}`}
            style={{ width: `${pctClamped}%` }}
          />
        </div>
      </div>
      {!readOnly && (
        <div className={s.krActions}>
          <button
            type="button"
            className={s.secondaryBtn}
            onClick={onCheckin}
            title="Weekly check-in"
          >
            Check in
          </button>
          <button
            type="button"
            className={s.iconBtn}
            onClick={onEdit}
            aria-label="Edit key result"
            title="Edit key result"
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className={`${s.iconBtn} ${s.danger}`}
            onClick={onDelete}
            aria-label="Delete key result"
            title="Delete key result"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

