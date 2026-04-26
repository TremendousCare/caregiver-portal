import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  loadCarePlanForShift,
  logTaskObservation,
  logShiftNote,
  logRefusal,
  indexLatestTaskCompletions,
  pickLatestShiftNote,
  listRefusals,
} from '../../lib/carePlanShift';
import {
  filterTasksForShift,
  groupTasksByCategory,
  categoryLabel,
} from '../../lib/shiftTaskFilter';
import s from './CarePlanChecklist.module.css';

// ─── Care plan checklist ──────────────────────────────────────
// Renders the active care plan's tasks for this shift, lets the
// caregiver mark each task done / partial / not done, log a refusal
// reason per task, and add free-form shift notes.
//
// Three lifecycle states:
//   - Read-only preview  (shift status: assigned | confirmed)
//   - Interactive log    (shift status: in_progress)
//   - Locked history     (shift status: completed)
// Other statuses (cancelled, no_show) hide the panel entirely — the
// caller is expected to render nothing instead of mounting this.
//
// All writes are append-only into care_plan_observations. The latest
// task_completion per task is the "current rating"; the latest
// shift_note is the "current note"; refusals are listed individually.

const TASK_STATUSES = ['assigned', 'confirmed', 'in_progress', 'completed'];

export function CarePlanChecklist({ shift, caregiver }) {
  const [loadState, setLoadState] = useState('loading'); // loading | ready | error | hidden
  const [data, setData] = useState({ plan: null, version: null, tasks: [], observations: [] });
  const [errorMsg, setErrorMsg] = useState(null);

  // Ephemeral UI state — keyed by task id so two tasks don't clobber each other.
  const [submittingTaskId, setSubmittingTaskId] = useState(null);
  const [taskNoteEditingId, setTaskNoteEditingId] = useState(null);
  const [taskNoteDraft, setTaskNoteDraft] = useState('');
  const [refusalEditingId, setRefusalEditingId] = useState(null);
  const [refusalDraft, setRefusalDraft] = useState('');
  const [shiftNoteDraft, setShiftNoteDraft] = useState('');
  const [shiftNoteSaving, setShiftNoteSaving] = useState(false);
  const [shiftNoteError, setShiftNoteError] = useState(null);

  // Load on mount and whenever the shift identity changes.
  const refresh = useCallback(async () => {
    if (!shift?.id) {
      setLoadState('hidden');
      return;
    }
    if (!TASK_STATUSES.includes(shift.status)) {
      setLoadState('hidden');
      return;
    }
    setLoadState('loading');
    setErrorMsg(null);
    try {
      const result = await loadCarePlanForShift(shift);
      if (!result) {
        setLoadState('hidden');
        return;
      }
      setData(result);
      // Seed the shift-note draft with the most recent saved note so
      // the caregiver can edit instead of retyping when they reopen.
      const latestNote = pickLatestShiftNote(result.observations);
      setShiftNoteDraft(latestNote?.note || '');
      setLoadState('ready');
    } catch (err) {
      setErrorMsg(err?.message || 'Could not load the care plan.');
      setLoadState('error');
    }
  }, [shift]);

  useEffect(() => { refresh(); }, [refresh]);

  // Derived: tasks for this shift, grouped by category.
  const groupedTasks = useMemo(() => {
    if (!data.tasks?.length) return [];
    const filtered = filterTasksForShift(data.tasks, shift);
    return groupTasksByCategory(filtered);
  }, [data.tasks, shift]);

  // Latest task_completion per task so we can highlight the current rating.
  const taskRatings = useMemo(
    () => indexLatestTaskCompletions(data.observations),
    [data.observations],
  );

  const refusals = useMemo(() => listRefusals(data.observations), [data.observations]);
  const latestShiftNote = useMemo(
    () => pickLatestShiftNote(data.observations),
    [data.observations],
  );

  const editable = shift?.status === 'in_progress';
  const locked = shift?.status === 'completed';

  // ─── Action handlers ────────────────────────────────────────

  const handleRate = async (task, rating) => {
    if (!editable || !data.plan || !data.version || submittingTaskId) return;
    setSubmittingTaskId(task.id);
    setErrorMsg(null);
    try {
      await logTaskObservation({
        carePlanId: data.plan.id,
        versionId: data.version.id,
        taskId: task.id,
        shiftId: shift.id,
        caregiverId: caregiver?.id,
        rating,
      });
      await refresh();
    } catch (err) {
      setErrorMsg(err?.message || 'Could not save. Try again.');
    } finally {
      setSubmittingTaskId(null);
    }
  };

  const handleSaveTaskNote = async (task) => {
    const trimmed = taskNoteDraft.trim();
    if (!trimmed || !editable || !data.plan || !data.version) return;
    setSubmittingTaskId(task.id);
    setErrorMsg(null);
    try {
      // Re-log the task with the current rating + note. If no rating yet,
      // default to 'partial' so the note has somewhere to live.
      const currentRating = taskRatings.get(task.id)?.rating || 'partial';
      await logTaskObservation({
        carePlanId: data.plan.id,
        versionId: data.version.id,
        taskId: task.id,
        shiftId: shift.id,
        caregiverId: caregiver?.id,
        rating: currentRating,
        note: trimmed,
      });
      setTaskNoteEditingId(null);
      setTaskNoteDraft('');
      await refresh();
    } catch (err) {
      setErrorMsg(err?.message || 'Could not save note. Try again.');
    } finally {
      setSubmittingTaskId(null);
    }
  };

  const handleSaveRefusal = async (task) => {
    const trimmed = refusalDraft.trim();
    if (!trimmed || !editable || !data.plan || !data.version) return;
    setSubmittingTaskId(task.id);
    setErrorMsg(null);
    try {
      await logRefusal({
        carePlanId: data.plan.id,
        versionId: data.version.id,
        taskId: task.id,
        shiftId: shift.id,
        caregiverId: caregiver?.id,
        note: trimmed,
      });
      setRefusalEditingId(null);
      setRefusalDraft('');
      await refresh();
    } catch (err) {
      setErrorMsg(err?.message || 'Could not save refusal. Try again.');
    } finally {
      setSubmittingTaskId(null);
    }
  };

  const handleSaveShiftNote = async () => {
    const trimmed = shiftNoteDraft.trim();
    if (!trimmed || !editable || !data.plan || !data.version) return;
    setShiftNoteSaving(true);
    setShiftNoteError(null);
    try {
      await logShiftNote({
        carePlanId: data.plan.id,
        versionId: data.version.id,
        shiftId: shift.id,
        caregiverId: caregiver?.id,
        note: trimmed,
      });
      await refresh();
    } catch (err) {
      setShiftNoteError(err?.message || 'Could not save. Try again.');
    } finally {
      setShiftNoteSaving(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────

  if (loadState === 'hidden') return null;

  if (loadState === 'loading') {
    return (
      <section className={s.card}>
        <div className={s.muted}>Loading care plan…</div>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section className={s.card}>
        <div className={s.errorBanner}>{errorMsg || 'Could not load care plan.'}</div>
        <button className={s.linkBtn} onClick={refresh}>Tap to retry</button>
      </section>
    );
  }

  // Ready, but no plan exists for this client.
  if (!data.plan) {
    return (
      <section className={s.card}>
        <div className={s.cardTitle}>Care plan</div>
        <div className={s.muted}>
          No care plan set up for this client yet. Contact your coordinator if you need
          guidance on this shift.
        </div>
      </section>
    );
  }

  // Plan exists, but no published version (admin still drafting).
  if (!data.version || data.version.status !== 'published') {
    return (
      <section className={s.card}>
        <div className={s.cardTitle}>Care plan</div>
        <div className={s.muted}>
          The care plan for this client is still being prepared. Contact your coordinator
          if you need guidance on this shift.
        </div>
      </section>
    );
  }

  // Plan + version, but no tasks for this shift.
  if (groupedTasks.length === 0) {
    return (
      <section className={s.card}>
        <div className={s.cardTitle}>Care plan</div>
        <div className={s.muted}>
          No tasks scheduled for this shift period. Free-form shift notes are still available below.
        </div>
        <ShiftNotesSection
          editable={editable}
          locked={locked}
          shiftNoteDraft={shiftNoteDraft}
          setShiftNoteDraft={setShiftNoteDraft}
          onSave={handleSaveShiftNote}
          saving={shiftNoteSaving}
          errorMsg={shiftNoteError}
          latestNote={latestShiftNote}
        />
      </section>
    );
  }

  return (
    <>
      <section className={s.card}>
        <div className={s.cardHeader}>
          <span className={s.cardTitle}>Care plan</span>
          <span className={s.versionBadge}>v{data.version.versionNumber}</span>
        </div>
        {!editable && !locked && (
          <div className={s.helperBanner}>
            Preview only — clock in to start logging tasks.
          </div>
        )}
        {locked && (
          <div className={s.helperBanner}>
            Shift completed. Task log is locked. Contact your coordinator to make changes.
          </div>
        )}
        {errorMsg && <div className={s.errorBanner}>{errorMsg}</div>}

        {groupedTasks.map(({ category, tasks }) => (
          <div key={category} className={s.categoryGroup}>
            <h3 className={s.categoryHeader}>{categoryLabel(category)}</h3>
            <ul className={s.taskList}>
              {tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  rating={taskRatings.get(task.id)}
                  editable={editable}
                  submitting={submittingTaskId === task.id}
                  onRate={handleRate}
                  isNoteEditing={taskNoteEditingId === task.id}
                  noteDraft={taskNoteEditingId === task.id ? taskNoteDraft : ''}
                  onOpenNote={() => {
                    setTaskNoteEditingId(task.id);
                    setRefusalEditingId(null);
                    setTaskNoteDraft(taskRatings.get(task.id)?.note || '');
                  }}
                  onCloseNote={() => { setTaskNoteEditingId(null); setTaskNoteDraft(''); }}
                  onChangeNote={setTaskNoteDraft}
                  onSaveNote={handleSaveTaskNote}
                  isRefusalEditing={refusalEditingId === task.id}
                  refusalDraft={refusalEditingId === task.id ? refusalDraft : ''}
                  onOpenRefusal={() => {
                    setRefusalEditingId(task.id);
                    setTaskNoteEditingId(null);
                    setRefusalDraft('');
                  }}
                  onCloseRefusal={() => { setRefusalEditingId(null); setRefusalDraft(''); }}
                  onChangeRefusal={setRefusalDraft}
                  onSaveRefusal={handleSaveRefusal}
                />
              ))}
            </ul>
          </div>
        ))}
      </section>

      {refusals.length > 0 && (
        <section className={s.card}>
          <div className={s.cardTitle}>Refusals logged this shift</div>
          <ul className={s.refusalList}>
            {refusals.map((r) => {
              const taskName = data.tasks.find((t) => t.id === r.taskId)?.taskName;
              return (
                <li key={r.id}>
                  {taskName && <strong>{taskName}: </strong>}
                  <span>{r.note}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className={s.card}>
        <ShiftNotesSection
          editable={editable}
          locked={locked}
          shiftNoteDraft={shiftNoteDraft}
          setShiftNoteDraft={setShiftNoteDraft}
          onSave={handleSaveShiftNote}
          saving={shiftNoteSaving}
          errorMsg={shiftNoteError}
          latestNote={latestShiftNote}
        />
      </section>
    </>
  );
}

// ─── TaskItem (one row in the checklist) ─────────────────────

function TaskItem({
  task, rating, editable, submitting,
  onRate,
  isNoteEditing, noteDraft, onOpenNote, onCloseNote, onChangeNote, onSaveNote,
  isRefusalEditing, refusalDraft, onOpenRefusal, onCloseRefusal, onChangeRefusal, onSaveRefusal,
}) {
  const currentRating = rating?.rating || null;
  const currentNote = rating?.note || null;
  const priority = task.priority || 'standard';

  return (
    <li className={`${s.taskItem} ${priority === 'optional' ? s.taskOptional : ''}`}>
      <div className={s.taskHeader}>
        <span className={s.taskName}>{task.taskName}</span>
        {priority === 'critical' && <span className={s.priorityCritical}>Critical</span>}
        {priority === 'optional' && <span className={s.priorityOptional}>Optional</span>}
      </div>

      {task.description && (
        <div className={s.taskDescription}>{task.description}</div>
      )}
      {task.safetyNotes && (
        <div className={s.safetyNote}>
          <span className={s.safetyIcon}>⚠</span>
          <span>{task.safetyNotes}</span>
        </div>
      )}

      <div className={s.ratingRow}>
        <RateButton
          label="Done"
          symbol="✓"
          active={currentRating === 'done'}
          variant="done"
          disabled={!editable || submitting}
          onClick={() => onRate(task, 'done')}
        />
        <RateButton
          label="Partial"
          symbol="◐"
          active={currentRating === 'partial'}
          variant="partial"
          disabled={!editable || submitting}
          onClick={() => onRate(task, 'partial')}
        />
        <RateButton
          label="Not done"
          symbol="✗"
          active={currentRating === 'not_done'}
          variant="not-done"
          disabled={!editable || submitting}
          onClick={() => onRate(task, 'not_done')}
        />
      </div>

      {currentNote && !isNoteEditing && (
        <div className={s.taskNotePreview}>{currentNote}</div>
      )}

      {!isNoteEditing && !isRefusalEditing && editable && (
        <div className={s.taskActions}>
          <button className={s.linkBtn} onClick={onOpenNote}>
            {currentNote ? 'Edit note' : 'Add note'}
          </button>
          <button className={s.linkBtnDanger} onClick={onOpenRefusal}>
            Log refusal
          </button>
        </div>
      )}

      {isNoteEditing && (
        <div className={s.inlineEditor}>
          <textarea
            className={s.textarea}
            rows={2}
            placeholder="Add a quick note (optional)"
            maxLength={500}
            value={noteDraft}
            onChange={(e) => onChangeNote(e.target.value)}
          />
          <div className={s.row}>
            <button
              className={s.secondaryBtn}
              onClick={() => onSaveNote(task)}
              disabled={!noteDraft.trim() || submitting}
            >
              {submitting ? 'Saving…' : 'Save note'}
            </button>
            <button className={s.linkBtn} onClick={onCloseNote}>Cancel</button>
          </div>
        </div>
      )}

      {isRefusalEditing && (
        <div className={s.inlineEditor}>
          <label className={s.refusalLabel}>Refusal reason</label>
          <textarea
            className={s.textarea}
            rows={2}
            placeholder="What did the client say? (e.g. felt nauseous, will try later)"
            maxLength={500}
            value={refusalDraft}
            onChange={(e) => onChangeRefusal(e.target.value)}
          />
          <div className={s.row}>
            <button
              className={s.dangerBtn}
              onClick={() => onSaveRefusal(task)}
              disabled={refusalDraft.trim().length < 3 || submitting}
            >
              {submitting ? 'Saving…' : 'Log refusal'}
            </button>
            <button className={s.linkBtn} onClick={onCloseRefusal}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

function RateButton({ label, symbol, active, variant, disabled, onClick }) {
  const cls = [
    s.rateBtn,
    active ? s[`rateBtnActive_${variant}`] : '',
    disabled ? s.rateBtnDisabled : '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-pressed={active}>
      <span className={s.rateSymbol}>{symbol}</span>
      <span className={s.rateLabel}>{label}</span>
    </button>
  );
}

// ─── ShiftNotesSection ───────────────────────────────────────

function ShiftNotesSection({
  editable, locked, shiftNoteDraft, setShiftNoteDraft, onSave, saving, errorMsg, latestNote,
}) {
  const trimmed = shiftNoteDraft.trim();
  const unchanged = trimmed === (latestNote?.note || '').trim();
  return (
    <div className={s.shiftNotes}>
      <div className={s.cardTitle}>Shift notes</div>
      <p className={s.muted}>
        Anything you want your coordinator to know — observations, family interactions, things
        that came up during the visit.
      </p>
      <textarea
        className={s.textarea}
        rows={4}
        maxLength={2000}
        placeholder={editable
          ? 'How did the visit go?'
          : 'Clock in to add notes for this shift.'}
        value={shiftNoteDraft}
        onChange={(e) => setShiftNoteDraft(e.target.value)}
        disabled={!editable}
      />
      <div className={s.shiftNotesFooter}>
        <span className={s.muted}>{shiftNoteDraft.length} / 2000</span>
        {editable && (
          <button
            className={s.primaryBtn}
            onClick={onSave}
            disabled={!trimmed || unchanged || saving}
          >
            {saving ? 'Saving…' : (latestNote ? 'Update note' : 'Save note')}
          </button>
        )}
      </div>
      {errorMsg && <div className={s.error}>{errorMsg}</div>}
      {latestNote && !editable && !locked && (
        <div className={s.helper}>Saved {formatTime(latestNote.loggedAt)}.</div>
      )}
      {locked && latestNote && (
        <div className={s.helper}>Last saved {formatTime(latestNote.loggedAt)}.</div>
      )}
    </div>
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
