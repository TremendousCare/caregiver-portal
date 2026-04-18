import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  createTask,
  deleteTask,
  getTasksForVersion,
  updateTask,
} from './storage';
import { TASK_CATEGORIES, DAYS_OF_WEEK } from './sections';
import btn from '../../styles/buttons.module.css';
import s from './TaskEditor.module.css';

// ═══════════════════════════════════════════════════════════════
// TaskEditor
//
// Manages the care_plan_tasks rows for a single ADL / IADL section.
// Shows tasks grouped by category, lets the user add / edit / delete
// rows. Realtime subscription keeps the list in sync if a second
// editor (or AI in a later phase) touches the same version.
// ═══════════════════════════════════════════════════════════════

const SHIFT_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
  { key: 'overnight', label: 'Overnight' },
];

const PRIORITIES = [
  { key: 'standard', label: 'Standard' },
  { key: 'critical', label: 'Critical' },
  { key: 'optional', label: 'Optional' },
];

export function TaskEditor({ sectionId, version, disabled, currentUser, showToast }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!version?.id) return;
    try {
      const all = await getTasksForVersion(version.id);
      // Filter down to tasks whose category routes to THIS section.
      const mine = all.filter((t) => TASK_CATEGORIES[t.category]?.section === sectionId);
      setTasks(mine);
      setLoadError(null);
    } catch (e) {
      console.error('[TaskEditor] load error:', e);
      setLoadError(e.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [version?.id, sectionId]);

  useEffect(() => { load(); }, [load]);

  // Realtime subscription on this version's tasks.
  useEffect(() => {
    if (!supabase || !version?.id) return undefined;
    const channel = supabase
      .channel(`care-plan-tasks-${version.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'care_plan_tasks',
          filter: `version_id=eq.${version.id}`,
        },
        () => load(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [version?.id, load]);

  const userId = currentUser?.displayName || currentUser?.email || null;

  const handleUpdate = useCallback(async (taskId, patch) => {
    try {
      await updateTask(taskId, patch, { userId });
      // Realtime will re-fetch; optimistically update for snappiness.
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    } catch (e) {
      console.error('[TaskEditor] update failed:', e);
      showToast?.(`Couldn't update task: ${e.message}`);
    }
  }, [userId, showToast]);

  const handleDelete = useCallback(async (taskId) => {
    if (!window.confirm('Delete this task?')) return;
    try {
      await deleteTask(taskId, { userId });
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (e) {
      console.error('[TaskEditor] delete failed:', e);
      showToast?.(`Couldn't delete task: ${e.message}`);
    }
  }, [userId, showToast]);

  const categoriesForSection = Object.entries(TASK_CATEGORIES)
    .filter(([, meta]) => meta.section === sectionId);

  const handleAdd = useCallback(async (task) => {
    setAdding(false);
    try {
      const created = await createTask(version.id, task, { userId });
      if (created) {
        setTasks((prev) => [...prev, created]);
      }
    } catch (e) {
      console.error('[TaskEditor] create failed:', e);
      showToast?.(`Couldn't add task: ${e.message}`);
    }
  }, [version?.id, userId, showToast]);

  // Group tasks by category
  const byCategory = tasks.reduce((acc, task) => {
    if (!acc[task.category]) acc[task.category] = [];
    acc[task.category].push(task);
    return acc;
  }, {});

  if (loading) return <div className={s.loading}>Loading tasks…</div>;

  return (
    <div className={s.wrap}>
      {loadError && <div className={s.error}>Error: {loadError}</div>}

      {categoriesForSection.map(([category, meta]) => {
        const rows = byCategory[category] || [];
        return (
          <div key={category} className={s.categoryBlock}>
            <div className={s.categoryHeader}>{meta.label}</div>
            {rows.length === 0 ? (
              <div className={s.empty}>No tasks yet.</div>
            ) : (
              <ul className={s.rows}>
                {rows.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    disabled={disabled}
                    onUpdate={(patch) => handleUpdate(task.id, patch)}
                    onDelete={() => handleDelete(task.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {!disabled && (
        <div className={s.addRow}>
          {adding ? (
            <NewTaskForm
              sectionId={sectionId}
              onAdd={handleAdd}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button className={btn.secondaryBtn} onClick={() => setAdding(true)}>
              + Add task
            </button>
          )}
        </div>
      )}
    </div>
  );
}


// ─── TaskRow ────────────────────────────────────────────────────

function TaskRow({ task, disabled, onUpdate, onDelete }) {
  return (
    <li className={s.row}>
      <div className={s.rowMain}>
        <input
          type="text"
          className={s.nameInput}
          value={task.taskName || ''}
          disabled={disabled}
          onChange={(e) => onUpdate({ taskName: e.target.value })}
          placeholder="Task name"
        />
        <textarea
          className={s.descInput}
          rows={2}
          value={task.description || ''}
          disabled={disabled}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Description / instructions"
        />
        <textarea
          className={s.safetyInput}
          rows={1}
          value={task.safetyNotes || ''}
          disabled={disabled}
          onChange={(e) => onUpdate({ safetyNotes: e.target.value })}
          placeholder="Safety notes (optional)"
        />
      </div>

      <div className={s.rowControls}>
        <ChipGroup
          label="Shifts"
          options={SHIFT_OPTIONS}
          selected={task.shifts || ['all']}
          disabled={disabled}
          onChange={(next) => onUpdate({ shifts: next.length ? next : ['all'] })}
        />
        <ChipGroup
          label="Days"
          options={DAYS_OF_WEEK.map((d, i) => ({ key: i, label: d }))}
          selected={task.daysOfWeek || []}
          disabled={disabled}
          onChange={(next) => onUpdate({ daysOfWeek: next })}
          help={task.daysOfWeek?.length === 0 ? 'Every day' : undefined}
        />
        <PrioritySelect
          value={task.priority || 'standard'}
          disabled={disabled}
          onChange={(p) => onUpdate({ priority: p })}
        />

        {!disabled && (
          <button
            className={s.deleteBtn}
            onClick={onDelete}
            title="Delete task"
            aria-label="Delete task"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  );
}


function ChipGroup({ label, options, selected, disabled, onChange, help }) {
  const toggle = (k) => {
    if (selected.includes(k)) {
      onChange(selected.filter((v) => v !== k));
    } else {
      onChange([...selected, k]);
    }
  };
  return (
    <div className={s.chipGroup}>
      <div className={s.chipGroupLabel}>{label}</div>
      <div className={s.chips}>
        {options.map((opt) => (
          <button
            type="button"
            key={opt.key}
            className={`${s.chip} ${selected.includes(opt.key) ? s.chipActive : ''}`}
            disabled={disabled}
            onClick={() => toggle(opt.key)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {help && <div className={s.chipGroupHelp}>{help}</div>}
    </div>
  );
}


function PrioritySelect({ value, disabled, onChange }) {
  return (
    <div className={s.priorityGroup}>
      <div className={s.chipGroupLabel}>Priority</div>
      <div className={s.chips}>
        {PRIORITIES.map((p) => (
          <button
            type="button"
            key={p.key}
            className={`${s.priorityChip} ${s[`priority_${p.key}`] || ''} ${value === p.key ? s.priorityActive : ''}`}
            disabled={disabled}
            onClick={() => onChange(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}


// ─── NewTaskForm ───────────────────────────────────────────────

function NewTaskForm({ sectionId, onAdd, onCancel }) {
  const categoryOptions = Object.entries(TASK_CATEGORIES)
    .filter(([, meta]) => meta.section === sectionId);
  const [category, setCategory] = useState(categoryOptions[0]?.[0] || '');
  const [taskName, setTaskName] = useState('');
  const [description, setDescription] = useState('');
  const [shifts, setShifts] = useState(['all']);

  const handleSubmit = () => {
    if (!taskName.trim() || !category) return;
    onAdd({
      category,
      taskName: taskName.trim(),
      description: description.trim() || null,
      shifts,
      daysOfWeek: [],
      priority: 'standard',
    });
  };

  return (
    <div className={s.newForm}>
      <div className={s.newFormRow}>
        <select
          className={s.newFormSelect}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {categoryOptions.map(([key, meta]) => (
            <option key={key} value={key}>{meta.label}</option>
          ))}
        </select>
        <input
          type="text"
          className={s.newFormInput}
          placeholder="Task name (e.g. Assist with shower)"
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
          autoFocus
        />
      </div>
      <textarea
        className={s.newFormTextarea}
        rows={2}
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <ChipGroup
        label="Shifts"
        options={SHIFT_OPTIONS}
        selected={shifts}
        onChange={setShifts}
      />
      <div className={s.newFormActions}>
        <button className={btn.secondaryBtn} onClick={onCancel}>Cancel</button>
        <button
          className={btn.primaryBtn}
          onClick={handleSubmit}
          disabled={!taskName.trim()}
        >
          Add task
        </button>
      </div>
    </div>
  );
}
