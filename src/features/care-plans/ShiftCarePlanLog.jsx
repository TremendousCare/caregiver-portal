import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  getObservationsForShift,
  getTasksForVersion,
} from './storage';
import {
  formatObservation,
  groupObservationsByTask,
  indexLatestRatings,
  pickLatestShiftNote,
} from '../../lib/carePlanObservationFormatting';
import { categoryLabel } from '../../lib/shiftTaskFilter';
import s from './ShiftCarePlanLog.module.css';

// ═══════════════════════════════════════════════════════════════
// ShiftCarePlanLog — admin per-shift view
//
// Renders inside ShiftDrawer below the clock-events panel. Shows
// what the caregiver logged during this specific shift:
//   - Per-task latest rating (Done / Partial / Not done)
//   - Refusals (each is its own event)
//   - Latest shift note (with full edit history collapsible)
//
// Read-only — admin doesn't edit caregiver observations from here.
// Corrections happen via the existing care_plan_observations admin
// path (out of scope for this component).
//
// Quietly hides itself for shifts with no observations yet so the
// drawer doesn't show an empty section every time.
// ═══════════════════════════════════════════════════════════════

export function ShiftCarePlanLog({ shiftId }) {
  const [observations, setObservations] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!shiftId) {
      setObservations([]);
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const obs = await getObservationsForShift(shiftId);
      setObservations(obs);

      // For task-name lookups, use whichever version_id appears most in
      // the observations. In practice every observation on a single
      // shift will share a version_id (the version active when the
      // caregiver logged), so the first observation is enough.
      const versionId = obs[0]?.versionId;
      if (versionId) {
        const versionTasks = await getTasksForVersion(versionId);
        setTasks(versionTasks);
      } else {
        setTasks([]);
      }
    } catch (e) {
      setError(e?.message || 'Could not load care plan log.');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  // ─── Derived ───────────────────────────────────────────────

  const taskMap = useMemo(() => {
    const m = new Map();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const latestRatings = useMemo(() => indexLatestRatings(observations), [observations]);
  const groupedByTask = useMemo(() => groupObservationsByTask(observations), [observations]);
  const refusals = useMemo(
    () => observations.filter((o) => o.observationType === 'refusal'),
    [observations],
  );
  const latestShiftNote = useMemo(() => pickLatestShiftNote(observations), [observations]);
  const allShiftNotes = useMemo(
    () => observations
      .filter((o) => o.observationType === 'shift_note')
      .sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt)),
    [observations],
  );

  // ─── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <section className={s.panel}>
        <h4 className={s.title}>Care plan log</h4>
        <div className={s.muted}>Loading…</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={s.panel}>
        <h4 className={s.title}>Care plan log</h4>
        <div className={s.errorBanner}>{error}</div>
        <button className={s.linkBtn} onClick={load}>Retry</button>
      </section>
    );
  }

  // Don't show an empty panel — keep the drawer tight.
  if (observations.length === 0) return null;

  // Group rated tasks by category so the per-shift log mirrors the
  // structure caregivers see. Every task with any rating shows; tasks
  // without observations on this shift are omitted (the activity log
  // is for what happened, not what didn't).
  const tasksWithActivity = tasks
    .filter((t) => groupedByTask.has(t.id))
    .map((t) => ({ task: t, latest: latestRatings.get(t.id) }));
  const taskGroupsByCategory = new Map();
  for (const entry of tasksWithActivity) {
    const cat = entry.task.category || 'other';
    if (!taskGroupsByCategory.has(cat)) taskGroupsByCategory.set(cat, []);
    taskGroupsByCategory.get(cat).push(entry);
  }

  return (
    <section className={s.panel}>
      <h4 className={s.title}>Care plan log</h4>
      <p className={s.subtitle}>
        What the caregiver logged during this visit.
      </p>

      {/* ── Tasks rated this shift ── */}
      {tasksWithActivity.length > 0 && (
        <div className={s.section}>
          {Array.from(taskGroupsByCategory.entries()).map(([category, entries]) => (
            <div key={category} className={s.categoryGroup}>
              <h5 className={s.categoryHeader}>{categoryLabel(category)}</h5>
              <ul className={s.taskList}>
                {entries.map(({ task, latest }) => {
                  const formatted = formatObservation(latest, taskMap);
                  return (
                    <li key={task.id} className={`${s.taskRow} ${s[`tone_${formatted.tone}`] || ''}`}>
                      <span className={s.icon}>{formatted.icon}</span>
                      <div className={s.taskBody}>
                        <div className={s.taskLabel}>{formatted.label}</div>
                        {formatted.detail && (
                          <div className={s.taskDetail}>{formatted.detail}</div>
                        )}
                      </div>
                      <span className={s.timestamp}>{formatTime(latest.loggedAt)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── Refusals ── */}
      {refusals.length > 0 && (
        <div className={s.section}>
          <h5 className={s.sectionHeader}>Refusals ({refusals.length})</h5>
          <ul className={s.refusalList}>
            {refusals.map((r) => {
              const formatted = formatObservation(r, taskMap);
              return (
                <li key={r.id} className={`${s.refusalItem} ${s.tone_danger}`}>
                  <span className={s.icon}>{formatted.icon}</span>
                  <div className={s.taskBody}>
                    <div className={s.taskLabel}>{formatted.label}</div>
                    {formatted.detail && (
                      <div className={s.taskDetail}>{formatted.detail}</div>
                    )}
                  </div>
                  <span className={s.timestamp}>{formatTime(r.loggedAt)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── Shift note ── */}
      {latestShiftNote && (
        <div className={s.section}>
          <h5 className={s.sectionHeader}>Shift note</h5>
          <div className={s.shiftNote}>{latestShiftNote.note}</div>
          <div className={s.muted}>
            Saved {formatTime(latestShiftNote.loggedAt)}
            {allShiftNotes.length > 1 && (
              <> · {allShiftNotes.length - 1} earlier {allShiftNotes.length - 1 === 1 ? 'revision' : 'revisions'}</>
            )}
          </div>
          {allShiftNotes.length > 1 && (
            <details className={s.history}>
              <summary className={s.historySummary}>
                Show edit history
              </summary>
              <ul className={s.historyList}>
                {allShiftNotes.slice(0, -1).map((n) => (
                  <li key={n.id} className={s.historyItem}>
                    <div className={s.muted}>{formatTime(n.loggedAt)}</div>
                    <div>{n.note}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}
