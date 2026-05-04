import { useEffect, useMemo, useState } from 'react';
import { createShift, getShifts, updateServicePlan } from './storage';
import { expandRecurrence } from '../../lib/scheduling/recurrence';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import {
  GENERATE_NUMBER_DEFAULT,
  GENERATE_NUMBER_OPTIONS,
  GENERATE_UNIT_DEFAULT,
  GENERATE_UNIT_OPTIONS,
  ONGOING_INITIAL_DAYS,
  describeRecurrencePattern,
  durationToDays,
  filterOutExistingInstances,
  hasRecurrencePattern,
} from './recurrenceHelpers';
import { latestEndTime } from '../../lib/scheduling/ongoingExtension';
import { formatLocalTimeShort } from './shiftHelpers';
import btn from '../../styles/buttons.module.css';
import s from './GenerateShiftsDialog.module.css';

// ═══════════════════════════════════════════════════════════════
// GenerateShiftsDialog
//
// Opens when the scheduler clicks "Generate shifts →" on an active
// service plan card that has a recurrence pattern. Shows:
//
//   - A duration picker: number dropdown × unit dropdown
//     (days / weeks / months-as-30-days), or an "Ongoing" toggle
//     that hands the plan to the weekly extension cron.
//   - A preview of the generated shifts (date list, count)
//   - A "Skipping N existing shifts" indicator so generating
//     twice doesn't produce duplicates
//   - Confirm → creates shifts in the database, all tagged with
//     recurrence_group_id = this service plan's id so future edits
//     can reason about the series. When ongoing is checked it also
//     flips `service_plans.is_ongoing` and stamps
//     `last_generated_through` so the cron picks the plan up next
//     run.
//
// Generated shifts start as 'open' — the scheduler still handles
// assignment (manual or via the broadcast flow).
// ═══════════════════════════════════════════════════════════════

export function GenerateShiftsDialog({
  plan,
  client,
  currentUserName,
  onClose,
  onGenerated,
  showToast,
}) {
  const [generateNumber, setGenerateNumber] = useState(GENERATE_NUMBER_DEFAULT);
  const [generateUnit, setGenerateUnit] = useState(GENERATE_UNIT_DEFAULT);
  const [isOngoing, setIsOngoing] = useState(plan?.isOngoing === true);
  const [existingShifts, setExistingShifts] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Compute the generation window. Ongoing plans always materialize
  // ONGOING_INITIAL_DAYS up front so the user sees a real preview;
  // the cron handles all subsequent extension. Otherwise it's just
  // (number × unit) days from local midnight.
  const window = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const days = isOngoing ? ONGOING_INITIAL_DAYS : durationToDays(generateNumber, generateUnit);
    const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
    return { start, end };
  }, [isOngoing, generateNumber, generateUnit]);

  // Fetch any existing shifts for this service plan in the window so
  // we can skip duplicates in the preview and the insert.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExisting(true);
      setLoadError(null);
      try {
        const rows = await getShifts({
          servicePlanId: plan.id,
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
    return expandRecurrence(plan.recurrencePattern, window.start, window.end, {
      timezone: DEFAULT_APP_TIMEZONE,
    });
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
          servicePlanId: plan.id,
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

      // Persist the ongoing flag + the bookkeeping marker the cron
      // reads from. We always write the flag (so toggling off clears
      // it), and we update last_generated_through whenever we
      // actually pushed shifts that extend it forward.
      const newestEnd = latestEndTime([...newInstances, ...existingShifts.map((s) => ({
        end_time: s.endTime,
      }))]);
      const priorEnd = plan.lastGeneratedThrough
        ? new Date(plan.lastGeneratedThrough).getTime()
        : 0;
      const candidateEnd = newestEnd ? new Date(newestEnd).getTime() : 0;
      const lastGeneratedThrough = candidateEnd > priorEnd ? newestEnd : plan.lastGeneratedThrough;

      try {
        await updateServicePlan(plan.id, {
          isOngoing,
          lastGeneratedThrough: lastGeneratedThrough ?? null,
        });
      } catch (e) {
        // Don't fail the whole generation just because the bookkeeping
        // update couldn't write — the shifts already exist. Surface
        // the error so the user can retry; the cron will still pick
        // the plan up if `is_ongoing` is already true server-side.
        console.warn('Service plan ongoing-flag update failed:', e);
        if (showToast) {
          showToast('Shifts created, but ongoing flag may not have saved.');
        }
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
            <div className={s.durationRow}>
              <select
                className={s.durationSelect}
                value={generateNumber}
                onChange={(e) => setGenerateNumber(Number(e.target.value))}
                disabled={saving || isOngoing}
                aria-label="Number"
              >
                {GENERATE_NUMBER_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <select
                className={s.durationSelect}
                value={generateUnit}
                onChange={(e) => setGenerateUnit(e.target.value)}
                disabled={saving || isOngoing}
                aria-label="Unit"
              >
                {GENERATE_UNIT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <label className={s.ongoingRow}>
              <input
                type="checkbox"
                checked={isOngoing}
                onChange={(e) => setIsOngoing(e.target.checked)}
                disabled={saving}
              />
              <span className={s.ongoingLabel}>
                <strong>Ongoing</strong> — keep generating shifts in perpetuity
                {' '}
                <span className={s.ongoingHint}>
                  (creates the next 12 weeks now; a weekly job tops the window
                  back up to 12 weeks until you turn this off or end the plan)
                </span>
              </span>
            </label>
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
                          {formatLocalTimeShort(new Date(inst.start_time), DEFAULT_APP_TIMEZONE)} –{' '}
                          {formatLocalTimeShort(new Date(inst.end_time), DEFAULT_APP_TIMEZONE)}
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
