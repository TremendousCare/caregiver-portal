import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { FieldRenderer, shouldRender } from './FieldRenderer';
import { useAutosave } from './useAutosave';
import { saveDraft } from './storage';
import {
  getFieldsForGroup,
  sectionHasGroups,
  sectionUsesTasks,
} from './sections';
import { migrateSectionData } from './carePlanMigrations';
import { TaskEditor } from './TaskEditor';
import { createTask } from './storage';
import { VoiceCaptureModal } from './voice/VoiceCaptureModal';
import { sectionSupportsVoiceCapture } from './voice/voiceFieldSchema';
import btn from '../../styles/buttons.module.css';
import s from './SectionEditor.module.css';

// ═══════════════════════════════════════════════════════════════
// SectionEditor
//
// Slide-in drawer for editing a single care plan section. Every
// field change is debounced (1s) and persisted via saveDraft.
// An auto-dismissing "Saved" indicator tells the user the latest
// change landed without requiring an explicit Save button.
//
// Closing the drawer flushes any pending save so we don't lose the
// last keystroke.
//
// For sections that declare `groups` (ADL / IADL), each group is
// rendered as a collapsible accordion card containing its own
// structured fields and a scoped task list with an inline
// "+ Add task" button. Sections without `groups` fall back to the
// original flat field list followed by a single TaskEditor.
// ═══════════════════════════════════════════════════════════════

export function SectionEditor({
  section,
  version,
  currentUser,
  clientId,
  onClose,
  onSaved,
  showToast,
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Local editing state — seeded from the version's saved data,
  // then run through any per-section migrations (e.g., legacy
  // bathing_method arrays of strings become {method, level} rows).
  const initialSectionData = useMemo(
    () => migrateSectionData(section.id, (version?.data && version.data[section.id]) || {}),
    [section?.id, version?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [values, setValues] = useState(initialSectionData);
  // Reset local state if the user switches sections without closing.
  useEffect(() => {
    setValues(initialSectionData);
  }, [initialSectionData]);

  // Keep a ref of the latest accumulated patch so batched saves see
  // everything the user's typed since the last successful save.
  const pendingPatchRef = useRef({});

  const saveFn = useCallback(async (patch) => {
    const userId = currentUser?.displayName || currentUser?.email || null;
    const updated = await saveDraft(version.id, section.id, patch, { userId });
    pendingPatchRef.current = {};
    onSaved?.(updated);
    return updated;
  }, [currentUser, section?.id, version?.id, onSaved]);

  const { trigger, flush, state, error } = useAutosave(saveFn, { delay: 1000 });

  // Flush pending saves on unmount / close so the last change lands.
  useEffect(() => () => { flush(); }, [flush]);

  const handleFieldChange = useCallback((fieldId, newValue) => {
    setValues((prev) => ({ ...prev, [fieldId]: newValue }));
    pendingPatchRef.current = { ...pendingPatchRef.current, [fieldId]: newValue };
    trigger({ ...pendingPatchRef.current });
  }, [trigger]);

  // Apply a batch of voice-extracted field values plus (Phase 3)
  // a list of accepted task drafts. The modal calls this with shape
  // { fields, tasks }. Fields go through the existing autosave path;
  // tasks are created via the existing createTask helper, one row
  // per accepted draft. We intentionally do not parallelize task
  // inserts — sequential keeps the event log readable and total
  // task count is small in practice.
  const handleApplyVoiceExtraction = useCallback(async ({ fields, tasks } = {}) => {
    const fieldCount = fields ? Object.keys(fields).length : 0;
    if (fieldCount > 0) {
      setValues((prev) => ({ ...prev, ...fields }));
      pendingPatchRef.current = { ...pendingPatchRef.current, ...fields };
      trigger({ ...pendingPatchRef.current });
    }

    let tasksCreated = 0;
    if (Array.isArray(tasks) && tasks.length > 0 && version?.id) {
      const userId = currentUser?.displayName || currentUser?.email || null;
      for (const draft of tasks) {
        try {
          await createTask(
            version.id,
            {
              category:    draft.category,
              taskName:    draft.task_name,
              description: draft.description ?? null,
              shifts:      Array.isArray(draft.shifts) && draft.shifts.length > 0
                ? draft.shifts
                : ['all'],
              daysOfWeek:  Array.isArray(draft.days_of_week) ? draft.days_of_week : [],
              priority:    draft.priority || 'standard',
              safetyNotes: draft.safety_notes ?? null,
            },
            { userId },
          );
          tasksCreated += 1;
        } catch (e) {
          // One bad task shouldn't abort the rest. Surface the error
          // via toast but keep iterating.
          // eslint-disable-next-line no-console
          console.error('[voice] task create failed:', e?.message || e);
          showToast?.(`Couldn't create task "${draft.task_name}": ${e?.message || 'unknown error'}`);
        }
      }
    }

    if (fieldCount > 0 || tasksCreated > 0) {
      const bits = [];
      if (fieldCount > 0)   bits.push(`${fieldCount} field${fieldCount === 1 ? '' : 's'} updated`);
      if (tasksCreated > 0) bits.push(`${tasksCreated} task${tasksCreated === 1 ? '' : 's'} added`);
      showToast?.(`Voice capture: ${bits.join(', ')}.`);
    }
  }, [trigger, showToast, version?.id, currentUser]);

  const handleClose = useCallback(async () => {
    await flush();
    onClose?.();
  }, [flush, onClose]);

  const readOnly = version?.status !== 'draft';
  const disabled = readOnly;

  const indicator = useMemo(() => {
    if (error) return { label: 'Couldn\'t save — try again', tone: 'error' };
    switch (state) {
      case 'idle':    return { label: null,            tone: 'idle' };
      case 'pending': return { label: 'Change queued', tone: 'pending' };
      case 'saving':  return { label: 'Saving…',       tone: 'saving' };
      case 'saved':   return { label: 'Saved',         tone: 'saved' };
      case 'error':   return { label: 'Save failed',   tone: 'error' };
      default:        return { label: null,            tone: 'idle' };
    }
  }, [state, error]);

  const usesTasks = sectionUsesTasks(section);
  const useGroups = sectionHasGroups(section);

  return (
    <div className={s.backdrop} onClick={handleClose}>
      <aside
        className={s.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Edit ${section.label}`}
      >
        <header className={s.header}>
          <div>
            <div className={s.eyebrow}>
              Editing v{version?.versionNumber ?? '?'} draft
              {section.isAutoGenerated && ' · AI-generated'}
            </div>
            <h2 className={s.title}>{section.label}</h2>
            <p className={s.description}>{section.description}</p>
          </div>
          <div className={s.headerActions}>
            {!disabled && sectionSupportsVoiceCapture(section) && (
              <button
                type="button"
                className={s.voiceBtn}
                onClick={() => setVoiceOpen(true)}
                aria-label={`Fill ${section.label} with voice`}
                title="Fill with voice"
              >
                <Mic size={14} />
                <span>Voice</span>
              </button>
            )}
            <button
              className={s.closeBtn}
              onClick={handleClose}
              aria-label="Close drawer"
            >
              ✕
            </button>
          </div>
        </header>

        <div className={s.body}>
          {readOnly && (
            <div className={s.readOnlyBanner}>
              This version is {version?.status}. To make changes, start a new draft.
            </div>
          )}

          {error && (
            <div className={s.errorBanner}>
              Save failed: {error.message || 'Unknown error'}. Your changes are still in this drawer — try editing any field to retry.
            </div>
          )}

          {/* Grouped sections (ADL / IADL): accordion cards per group */}
          {useGroups ? (
            <div className={s.groupsWrap}>
              {section.groups.map((group) => (
                <GroupAccordion
                  key={group.id}
                  section={section}
                  group={group}
                  values={values}
                  version={version}
                  disabled={disabled}
                  currentUser={currentUser}
                  showToast={showToast}
                  onFieldChange={handleFieldChange}
                />
              ))}
            </div>
          ) : (
            <>
              {/* Flat fields */}
              <div className={s.fields}>
                {section.fields
                  .filter((f) => !f.readOnly || usesTasks /* snapshot's readOnly field still renders */)
                  .map((field) => (
                    <FieldRenderer
                      key={field.id}
                      field={field}
                      value={values[field.id]}
                      onChange={(v) => handleFieldChange(field.id, v)}
                      disabled={disabled}
                      siblingValues={values}
                    />
                  ))}
              </div>

              {/* Task editor for legacy ADL / IADL paths (no groups declared) */}
              {usesTasks && (
                <div className={s.tasksRegion}>
                  <h3 className={s.tasksTitle}>Tasks</h3>
                  <p className={s.tasksDescription}>
                    Specific shift-by-shift tasks the caregiver performs for this activity area.
                  </p>
                  <TaskEditor
                    sectionId={section.id}
                    version={version}
                    disabled={disabled}
                    currentUser={currentUser}
                    showToast={showToast}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <footer className={s.footer}>
          <div className={`${s.indicator} ${s[`tone_${indicator.tone}`] || ''}`}>
            {indicator.label && <span>{indicator.label}</span>}
          </div>
          <button className={btn.primaryBtn} onClick={handleClose}>
            Done
          </button>
        </footer>
      </aside>

      {voiceOpen && (
        <VoiceCaptureModal
          section={section}
          currentValues={values}
          versionId={version?.id}
          clientId={clientId}
          currentUser={currentUser}
          onApply={handleApplyVoiceExtraction}
          onClose={() => setVoiceOpen(false)}
        />
      )}
    </div>
  );
}


// ─── GroupAccordion ────────────────────────────────────────────
// One collapsible card per group on a grouped section (ADL / IADL).
// Collapsed by default; click to expand. The header shows a
// filled-field count derived from the current local values so the
// user gets a quick "what's done here" signal without opening it.

function GroupAccordion({
  section, group, values, version, disabled, currentUser, showToast, onFieldChange,
}) {
  const [open, setOpen] = useState(false);

  const fields = useMemo(() => getFieldsForGroup(section, group.id), [section, group.id]);

  // Filled count: only fields that are currently visible (conditional
  // gates respected) AND have a non-empty value.
  const filledCount = useMemo(() => {
    let count = 0;
    for (const f of fields) {
      if (!shouldRender(f, values)) continue;
      if (isFilled(values[f.id])) count += 1;
    }
    return count;
  }, [fields, values]);

  const visibleFieldCount = useMemo(
    () => fields.filter((f) => shouldRender(f, values)).length,
    [fields, values],
  );

  return (
    <div className={`${s.group} ${open ? s.groupOpen : ''}`}>
      <button
        type="button"
        className={s.groupHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className={s.groupHeaderText}>
          <div className={s.groupLabel}>{group.label}</div>
          {group.description && (
            <div className={s.groupDescription}>{group.description}</div>
          )}
        </div>
        <div className={s.groupMeta}>
          {visibleFieldCount > 0 && (
            <span className={s.groupCount}>
              {filledCount} / {visibleFieldCount} filled
            </span>
          )}
          <span className={s.groupChevron} aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {open && (
        <div className={s.groupBody}>
          {fields.length > 0 && (
            <div className={s.fields}>
              {fields.map((field) => (
                <FieldRenderer
                  key={field.id}
                  field={field}
                  value={values[field.id]}
                  onChange={(v) => onFieldChange(field.id, v)}
                  disabled={disabled}
                  siblingValues={values}
                />
              ))}
            </div>
          )}

          {group.taskCategory && (
            <div className={s.groupTasksRegion}>
              <div className={s.groupTasksLabel}>Tasks</div>
              <TaskEditor
                sectionId={section.id}
                version={version}
                disabled={disabled}
                currentUser={currentUser}
                showToast={showToast}
                categoryFilter={group.taskCategory}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Helpers ───────────────────────────────────────────────────

// True if a stored value would render as "something" to the user.
// Empty strings, null, undefined, and empty arrays all count as
// unfilled. Booleans count as filled (false IS an answer here for
// fields like "Needs reminders").
export function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    // YN shape: { answer, note } — filled when answer is set
    if ('answer' in value) return Boolean(value.answer);
    // PRN shape: { flag, option } — filled when flag is set
    if ('flag' in value) return Boolean(value.flag);
    // Fallback: any non-empty key with a non-null value
    return Object.values(value).some((v) => v != null && v !== '');
  }
  return true;
}
