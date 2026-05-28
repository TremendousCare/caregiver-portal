import { useEffect, useMemo, useState } from 'react';
import { createShifts, getShifts, updateServicePlan } from './storage';
import { getRulesForServicePlan } from './caregiverRulesStorage';
import { resolveAssignmentForInstance } from '../../lib/scheduling/caregiverRules';
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
// Days that have a "regular caregiver" rule (set in the grid on the
// service plan card) are pre-assigned to that caregiver and created
// already 'confirmed', so the scheduler doesn't have to assign + confirm
// each one by hand. Days with no rule fall back to 'open' (unassigned)
// for the broadcast / manual pick flow. The bulk insert deliberately
// skips per-shift assignment automations — see createShifts.
// ═══════════════════════════════════════════════════════════════

export function GenerateShiftsDialog({
  plan,
  client,
  caregivers,
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
  const [rules, setRules] = useState([]);
  const [loadingRules, setLoadingRules] = useState(true);
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

  // Load the plan's regular-caregiver rules once so each generated
  // shift can be pre-assigned to the right caregiver. Returns [] when
  // the rules table doesn't exist yet (pre-migration) or none are set,
  // in which case every shift falls back to 'open'.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingRules(true);
      try {
        const rows = await getRulesForServicePlan(plan.id);
        if (!cancelled) setRules(rows);
      } catch (e) {
        // Non-fatal: without rules we just generate 'open' shifts, the
        // pre-feature behavior. Surface nothing blocking to the user.
        console.warn('Failed to load caregiver rules for generation:', e);
        if (!cancelled) setRules([]);
      } finally {
        if (!cancelled) setLoadingRules(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan.id]);

  // Rules from storage are camelCase; the pure resolver expects the
  // snake_case DB shape. Map once.
  const rulesPlain = useMemo(
    () =>
      rules.map((r) => ({
        id: r.id,
        day_of_week: r.dayOfWeek,
        caregiver_id: r.caregiverId,
        effective_from: r.effectiveFrom,
        effective_to: r.effectiveTo,
      })),
    [rules],
  );

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

  // Caregiver name lookup for the preview chips.
  const caregiverNameById = useMemo(() => {
    const map = new Map();
    for (const cg of caregivers || []) {
      const name = `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || cg.id;
      map.set(cg.id, name);
    }
    return map;
  }, [caregivers]);

  // Resolve each new instance to its regular caregiver + initial status,
  // keyed by start_time so the preview and the insert stay in lockstep.
  const assignmentByStart = useMemo(() => {
    const map = new Map();
    for (const inst of newInstances) {
      map.set(inst.start_time, resolveAssignmentForInstance(inst, rulesPlain));
    }
    return map;
  }, [newInstances, rulesPlain]);

  const preAssignedCount = useMemo(
    () => Array.from(assignmentByStart.values()).filter((a) => a.caregiverId).length,
    [assignmentByStart],
  );

  // Build location string from the client's address for auto-fill
  const locationAddress = useMemo(() => {
    if (!client) return null;
    const parts = [client.address, client.city, client.state, client.zip].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }, [client]);

  // True when the user changed the Ongoing toggle relative to the
  // plan's persisted state. Used so the Save button stays enabled
  // even when the visible window has zero new shifts to insert —
  // otherwise a scheduler couldn't enable/disable Ongoing on a plan
  // whose 12 weeks are already fully materialized.
  const ongoingChanged = isOngoing !== (plan?.isOngoing === true);

  const handleGenerate = async () => {
    if (newInstances.length === 0 && !ongoingChanged) {
      setSaveError('Nothing to generate. All shifts in this window already exist.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // Build every row up front, then bulk-insert in one request.
      // Days with a regular-caregiver rule are pre-assigned and created
      // 'confirmed'; the rest stay 'open'. createShifts skips per-shift
      // assignment automations so generating a long series doesn't text
      // the caregiver once per shift.
      const shiftRows = newInstances.map((instance) => {
        const { caregiverId, status } =
          assignmentByStart.get(instance.start_time) || { caregiverId: null, status: 'open' };
        return {
          servicePlanId: plan.id,
          clientId: plan.clientId,
          assignedCaregiverId: caregiverId,
          startTime: instance.start_time,
          endTime: instance.end_time,
          status,
          locationAddress,
          recurrenceGroupId: plan.id, // Use plan.id as the stable group id
          recurrenceRule: plan.recurrencePattern,
          createdBy: currentUserName || null,
        };
      });
      await createShifts(shiftRows);
      const created = shiftRows.length;

      // Persist ongoing-related state on the plan row only when it
      // changed or is currently set. Pure finite-mode generation on a
      // non-ongoing plan leaves the row untouched, matching the
      // pre-feature behavior — and avoiding the
      // is_ongoing / last_generated_through columns entirely so the
      // code keeps working before the 20260507000000 migration has
      // been applied.
      const needsServicePlanUpdate = ongoingChanged || isOngoing;
      if (needsServicePlanUpdate) {
        const newestEnd = latestEndTime([
          ...newInstances,
          ...existingShifts.map((s) => ({ end_time: s.endTime })),
        ]);
        const priorEnd = plan.lastGeneratedThrough
          ? new Date(plan.lastGeneratedThrough).getTime()
          : 0;
        const candidateEnd = newestEnd ? new Date(newestEnd).getTime() : 0;
        const lastGeneratedThrough = candidateEnd > priorEnd ? newestEnd : plan.lastGeneratedThrough;

        const patch = {};
        if (ongoingChanged) patch.isOngoing = isOngoing;
        // Only stamp the bookkeeping marker for ongoing plans —
        // finite-mode plans have no rolling window for the cron to
        // top up.
        if (isOngoing && lastGeneratedThrough) {
          patch.lastGeneratedThrough = lastGeneratedThrough;
        }

        try {
          await updateServicePlan(plan.id, patch);
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
            {loadingExisting || loadingRules ? (
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
                    {newInstances.slice(0, 20).map((inst) => {
                      const assignment = assignmentByStart.get(inst.start_time);
                      const cgName = assignment?.caregiverId
                        ? caregiverNameById.get(assignment.caregiverId) || assignment.caregiverId
                        : null;
                      return (
                        <li key={inst.start_time} className={s.previewItem}>
                          <span className={s.previewLeft}>
                            <span className={s.previewDate}>
                              {formatPreviewDate(inst.start_time)}
                            </span>
                            <span className={s.previewTime}>
                              {formatLocalTimeShort(new Date(inst.start_time), DEFAULT_APP_TIMEZONE)} –{' '}
                              {formatLocalTimeShort(new Date(inst.end_time), DEFAULT_APP_TIMEZONE)}
                            </span>
                          </span>
                          {cgName ? (
                            <span className={s.previewCaregiver}>{cgName} · Confirmed</span>
                          ) : (
                            <span className={s.previewOpen}>Open</span>
                          )}
                        </li>
                      );
                    })}
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
            {preAssignedCount > 0 ? (
              <>
                {preAssignedCount} of {newInstances.length} shift
                {newInstances.length === 1 ? '' : 's'} will be pre-assigned to the day's
                regular caregiver and created <strong>Confirmed</strong>. The rest start
                as <strong>Open</strong> — use the broadcast or pick workflow to assign
                them. (Caregivers are not texted for generated shifts.)
              </>
            ) : (
              <>
                All generated shifts start as <strong>Open</strong> (unassigned). Set
                regular caregivers on the plan above to have matching days pre-assigned
                and confirmed automatically. Otherwise use the broadcast or pick workflow
                to assign caregivers.
              </>
            )}
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
            disabled={
              saving ||
              loadingExisting ||
              loadingRules ||
              (newInstances.length === 0 && !ongoingChanged)
            }
          >
            {saving
              ? 'Generating…'
              : newInstances.length === 0 && ongoingChanged
                ? isOngoing
                  ? 'Turn on Ongoing'
                  : 'Turn off Ongoing'
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
