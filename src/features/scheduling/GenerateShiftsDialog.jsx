import { useEffect, useMemo, useState } from 'react';
import { createShift, getShifts } from './storage';
import { expandRecurrence } from '../../lib/scheduling/recurrence';
import {
  GENERATE_WEEKS_DEFAULT,
  GENERATE_WEEKS_OPTIONS,
  describeRecurrencePattern,
  filterOutExistingInstances,
  hasRecurrencePattern,
} from './recurrenceHelpers';
import { formatLocalTimeShort } from './shiftHelpers';
import btn from '../../styles/buttons.module.css';
import s from './GenerateShiftsDialog.module.css';

// ═══════════════════════════════════════════════════════════════
// GenerateShiftsDialog — Phase 7
//
// Opens when the scheduler clicks "Generate shifts →" on an active
// care plan card that has a recurrence pattern. Shows:
//
//   - A weeks selector (2 / 4 / 8 / 12, default 4)
//   - A preview of the generated shifts (date list, count)
//   - A "Skipping N existing shifts" indicator so generating
//     twice doesn't produce duplicates
//   - Confirm → creates shifts in the database, all tagged with
//     recurrence_group_id = this care plan's id so future edits
//     can reason about the series.
//
// Generated shifts start as 'open' — the scheduler still handles
// assignment (manual or via the Phase 5 broadcast flow).
// ═══════════════════════════════════════════════════════════════

export function GenerateShiftsDialog({
  plan,
  client,
  currentUserName,
  onClose,
  onGenerated,
  showToast,
}) {
  const [weeksAhead, setWeeksAhead] = useState(GENERATE_WEEKS_DEFAULT);
  const [existingShifts, setExistingShifts] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Compute the generation window: now → now + weeksAhead weeks.
  // Use local-midnight boundaries so a shift starting at 8am today
  // counts as "today" regardless of when the user clicks Generate.
  const window = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(start.getTime() + weeksAhead * 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }, [weeksAhead]);

  // Fetch any existing shifts for this care plan in the window so
  // we can skip duplicates in the preview and the insert.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExisting(true);
      setLoadError(null);
      try {
        const rows = await getShifts({
          carePlanId: plan.id,
          startDate: window.start.toISOString(),
          endDate: window.end.toISOString(),
        });
        if (!cancelled) setExistingShifts(rows);
      } catch (e) {
        console.error('Failed to load existing shifts:', e);
        if (!cancelled) setLoadError(e.message || 'Failed to load existing shifts');
      } finally {
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, window.start.getTime(), window.end.getTime()]);

  // Expand the recurrence pattern into candidate instances
  const allInstances = useMemo(() => {
    if (!hasRecurrencePattern(plan.recurrencePattern)) return [];
    return expandRecurrence(plan.recurrencePattern, window.start, window.end);
  }, [plan.recurrencePattern, window.start, window.end]);

  // Filter out instances that already have a matching shift
  const newInstances = useMemo(
    () => filterOutExistingInstances(allInstances, existingShifts),
    [allInstances, existingShifts],
  );
  const skippedCount = allInstances.length - newInstances.length;

  // Build location string from the client's address for auto-fill
  const locationAddress = useMemo(() => {
    if (!client) return null;
    const parts = [client.address, client.city, client.state, client.zip].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }, [client]);

  const handleGenerate = async () => {
    if (newInstances.length === 0) {
      setSaveError('Nothing to generate. All shifts in this window already exist.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      let created = 0;
      for (const instance of newInstances) {
        await createShift({
          carePlanId: plan.id,
          clientId: plan.clientId,
          startTime: instance.start_time,
          endTime: instance.end_time,
          status: 'open',
          locationAddress,
          recurrenceGroupId: plan.id, // Use plan.id as the stable group id
          recurrenceRule: plan.recurrencePattern,
          createdBy: currentUserName || null,
        });
        created++;
      }
      onGenerated?.(created);
    } catch (e) {
      console.error('Generate failed:', e);
      setSaveError(e.message || 'Failed to generate shifts');
    } finally {
      setSaving(false);
    }
  };

  const patternLabel = describeRecurrencePattern(plan.recurrencePattern);

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="generate-shifts-title"
      >
        <header className={s.header}>
          <div>
            <h2 id="generate-shifts-title" className={s.title}>
              Generate shifts for {plan.title || 'this plan'}
            </h2>
            <div className={s.subtitle}>
              Pattern: <strong>{patternLabel}</strong>
            </div>
          </div>
          <button
            className={s.closeBtn}
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={s.body}>
          <div className={s.controlRow}>
            <div className={s.controlLabel}>How far ahead?</div>
            <div className={s.weeksToggle} role="tablist">
              {GENERATE_WEEKS_OPTIONS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`${s.weeksBtn} ${weeksAhead === w ? s.weeksBtnActive : ''}`}
                  onClick={() => setWeeksAhead(w)}
                  disabled={saving}
                >
                  {w} weeks
                </button>
              ))}
            </div>
          </div>

          {loadError && <div className={s.error}>{loadError}</div>}

          <div className={s.previewBox}>
            {loadingExisting ? (
              <div className={s.loading}>Computing preview…</div>
            ) : (
              <>
                <div className={s.previewSummary}>
                  <strong>
                    {newInstances.length} new shift{newInstances.length === 1 ? '' : 's'}
                  </strong>{' '}
                  will be created
                  {skippedCount > 0 && (
                    <span className={s.skippedNote}>
                      {' '}
                      ({skippedCount} already exist and will be skipped)
                    </span>
                  )}
                </div>
                {newInstances.length > 0 && (
                  <ul className={s.previewList}>
                    {newInstances.slice(0, 20).map((inst) => (
                      <li key={inst.start_time} className={s.previewItem}>
                        <span className={s.previewDate}>
                          {formatPreviewDate(inst.start_time)}
                        </span>
                        <span className={s.previewTime}>
                          {formatLocalTimeShort(new Date(inst.start_time))} –{' '}
                          {formatLocalTimeShort(new Date(inst.end_time))}
                        </span>
                      </li>
                    ))}
                    {newInstances.length > 20 && (
                      <li className={s.previewMore}>
                        … and {newInstances.length - 20} more
                      </li>
                    )}
                  </ul>
                )}
              </>
            )}
          </div>

          <div className={s.note}>
            All generated shifts start as <strong>Open</strong> (unassigned). Use the
            broadcast or pick workflow to assign caregivers.
          </div>

          {saveError && <div className={s.error}>{saveError}</div>}
        </div>

        <footer className={s.footer}>
          <button className={btn.secondaryBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className={btn.primaryBtn}
            onClick={handleGenerate}
            disabled={saving || loadingExisting || newInstances.length === 0}
          >
            {saving
              ? 'Generating…'
              : `Create ${newInstances.length} shift${newInstances.length === 1 ? '' : 's'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Format an ISO timestamp as "Mon, May 4" in local time for the
 * preview list.
 */
function formatPreviewDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
