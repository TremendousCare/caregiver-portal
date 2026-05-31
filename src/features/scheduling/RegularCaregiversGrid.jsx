import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getRulesForServicePlan,
  setRegularCaregiverForDay,
  clearRegularCaregiverForDay,
  activeRulesByDayOfWeek,
} from './caregiverRulesStorage';
import { getActiveRulesForCaregiver } from './caregiverRulesStorage';
import { findRuleConflicts } from '../../lib/scheduling/ruleConflicts';
import { hasRecurrencePattern } from './recurrenceHelpers';
import { DAY_OF_WEEK_LABELS_SHORT } from './recurrenceHelpers';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { SearchableSelect } from '../../shared/components/SearchableSelect';
import s from './RegularCaregiversGrid.module.css';

// ═══════════════════════════════════════════════════════════════
// RegularCaregiversGrid
//
// Rendered inside the service plan card on the client detail page.
// Shows a Sun-Sat row of cells; each cell is editable iff the day
// is included in the plan's recurrence pattern. Picking a caregiver
// writes a rule via setRegularCaregiverForDay (closes the prior
// rule's effective range automatically). Clearing a cell expires
// the active rule for that day.
//
// Conflict checks fire client-side as soon as a caregiver is
// selected — we fetch their other rules and project the plan's
// time window against the existing assignments. Hard conflicts
// (same caregiver covering an overlapping time window elsewhere)
// show as inline warning chips; the form still saves (the team
// can override with their judgment).
//
// Pre-migration safety: caregiverRulesStorage returns empty arrays
// when the rules table doesn't exist yet, so this grid renders
// with all "—" cells until the migration is applied. Picking a
// caregiver in that state logs a console warning and no-ops.
// ═══════════════════════════════════════════════════════════════

export function RegularCaregiversGrid({
  plan,
  caregivers,
  currentUser,
  showToast,
}) {
  const patternDays = useMemo(() => {
    if (!plan?.recurrencePattern?.days_of_week) return new Set();
    return new Set(plan.recurrencePattern.days_of_week);
  }, [plan]);

  const patternEnabled = hasRecurrencePattern(plan?.recurrencePattern);

  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingDow, setSavingDow] = useState(null);
  const [conflictsByDow, setConflictsByDow] = useState({});

  const loadRules = useCallback(async () => {
    if (!plan?.id) {
      setRules([]);
      setLoading(false);
      return;
    }
    try {
      const rows = await getRulesForServicePlan(plan.id);
      setRules(rows);
    } catch (err) {
      console.error('RegularCaregiversGrid load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [plan?.id]);

  useEffect(() => {
    setLoading(true);
    loadRules();
  }, [loadRules]);

  // Realtime: react to rule changes from another tab/user so the
  // grid stays consistent without manual refresh.
  useEffect(() => {
    if (!supabase || !plan?.id || !isSupabaseConfigured()) return undefined;
    const channel = supabase
      .channel(`scpr-${plan.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'service_plan_caregiver_rules',
          filter: `service_plan_id=eq.${plan.id}`,
        },
        () => loadRules(),
      )
      .subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // Table may not exist yet; the channel never connected.
      }
    };
  }, [plan?.id, loadRules]);

  const activeByDow = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const ruleRows = rules.map((r) => ({
      id: r.id,
      day_of_week: r.dayOfWeek,
      caregiver_id: r.caregiverId,
      effective_from: r.effectiveFrom,
      effective_to: r.effectiveTo,
    }));
    return activeRulesByDayOfWeek(ruleRows, today);
  }, [rules]);

  const checkConflict = useCallback(
    async (dayOfWeek, caregiverId) => {
      if (!plan?.id || !caregiverId) {
        setConflictsByDow((prev) => ({ ...prev, [dayOfWeek]: [] }));
        return;
      }
      try {
        const otherRules = await getActiveRulesForCaregiver(caregiverId);
        // Decorate with pattern clocks. We only know our own plan's
        // pattern here; for other rules we'd need the full plans,
        // which is heavier. For v1 we check rule-vs-rule using THIS
        // plan's pattern times — same caregiver on same dow on a
        // different plan is a meaningful warning even before we
        // refine the time-window check.
        const decorated = otherRules
          .filter((r) => r.servicePlanId !== plan.id)
          .map((r) => ({
            id: r.id,
            service_plan_id: r.servicePlanId,
            day_of_week: r.dayOfWeek,
            caregiver_id: r.caregiverId,
            effective_from: r.effectiveFrom,
            effective_to: r.effectiveTo,
            // Best-effort: assume the other plan's pattern overlaps.
            // The grid surfaces "covering another plan on this day"
            // as a warning regardless of clock overlap, since the
            // team usually doesn't double-book by intention.
            pattern_start_clock: plan.recurrencePattern?.start_time,
            pattern_end_clock: plan.recurrencePattern?.end_time,
          }));
        const conflicts = findRuleConflicts(
          {
            caregiverId,
            servicePlanId: plan.id,
            dayOfWeek,
            startClock: plan.recurrencePattern?.start_time,
            endClock: plan.recurrencePattern?.end_time,
            effectiveFrom: new Date().toISOString().slice(0, 10),
          },
          decorated,
        );
        setConflictsByDow((prev) => ({ ...prev, [dayOfWeek]: conflicts }));
      } catch (err) {
        console.warn('checkConflict failed:', err);
        setConflictsByDow((prev) => ({ ...prev, [dayOfWeek]: [] }));
      }
    },
    [plan?.id, plan?.recurrencePattern?.start_time, plan?.recurrencePattern?.end_time],
  );

  const handlePick = async (dayOfWeek, caregiverId) => {
    if (!plan?.id || !plan?.orgId) {
      // org_id is required by the rule row. ServicePlansPanel passes
      // a plan object built from dbToServicePlan which doesn't
      // include orgId yet — we resolve it from the plan loader path.
      console.warn('RegularCaregiversGrid: plan.orgId missing; cannot save.');
      showToast?.('Cannot save: plan organization is missing.');
      return;
    }
    setSavingDow(dayOfWeek);
    try {
      if (!caregiverId) {
        await clearRegularCaregiverForDay({
          servicePlanId: plan.id,
          dayOfWeek,
        });
        showToast?.(
          `Cleared regular ${DAY_OF_WEEK_LABELS_SHORT[dayOfWeek]} caregiver`,
        );
      } else {
        await setRegularCaregiverForDay({
          servicePlanId: plan.id,
          orgId: plan.orgId,
          dayOfWeek,
          caregiverId,
          createdBy: currentUser || null,
        });
        const cg = caregivers?.find((c) => c.id === caregiverId);
        const name = cg
          ? `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || caregiverId
          : caregiverId;
        showToast?.(
          `${name} is now the regular ${DAY_OF_WEEK_LABELS_SHORT[dayOfWeek]} caregiver`,
        );
        await checkConflict(dayOfWeek, caregiverId);
      }
      await loadRules();
    } catch (err) {
      console.error('RegularCaregiversGrid save failed:', err);
      showToast?.(`Failed to save: ${err.message || err}`);
    } finally {
      setSavingDow(null);
    }
  };

  if (!patternEnabled) {
    // No recurrence pattern yet — the grid would be all greyed out.
    // Show a brief hint instead so the section is intentional and
    // not surprising.
    return (
      <div className={s.section}>
        <div className={s.title}>Regular caregivers</div>
        <div className={s.hint}>
          Set a recurring weekly pattern above to assign regular caregivers per day.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={s.section}>
        <div className={s.title}>Regular caregivers</div>
        <div className={s.loading}>Loading…</div>
      </div>
    );
  }

  // Caregiver options for the per-day pickers, sorted alphabetically by
  // display name. Built once and shared across all seven day cells.
  const caregiverOptions = useMemo(
    () =>
      (caregivers || [])
        .map((cg) => ({
          value: cg.id,
          label: `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || cg.id,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [caregivers],
  );

  return (
    <div className={s.section}>
      <div className={s.titleRow}>
        <div className={s.title}>Regular caregivers</div>
        <div className={s.subtitle}>
          Optional — set who covers each day. Future shifts generated by the cron will pre-assign these caregivers.
        </div>
      </div>
      <div className={s.grid}>
        {DAY_OF_WEEK_LABELS_SHORT.map((label, dow) => {
          const inPattern = patternDays.has(dow);
          const active = activeByDow[dow];
          const conflicts = conflictsByDow[dow] || [];
          return (
            <DayCell
              key={dow}
              label={label}
              dayOfWeek={dow}
              inPattern={inPattern}
              activeRule={active}
              caregiverOptions={caregiverOptions}
              onPick={(id) => handlePick(dow, id)}
              saving={savingDow === dow}
              conflicts={conflicts}
            />
          );
        })}
      </div>
    </div>
  );
}

function DayCell({
  label,
  dayOfWeek,
  inPattern,
  activeRule,
  caregiverOptions,
  onPick,
  saving,
  conflicts,
}) {
  if (!inPattern) {
    return (
      <div className={`${s.cell} ${s.cellDisabled}`}>
        <div className={s.cellLabel}>{label}</div>
        <div className={s.cellEmpty}>—</div>
      </div>
    );
  }

  const selectedId = activeRule?.caregiver_id || '';

  return (
    <div className={s.cell}>
      <div className={s.cellLabel}>{label}</div>
      <SearchableSelect
        value={selectedId}
        onChange={(id) => onPick(id || null)}
        options={caregiverOptions}
        emptyOption={{ value: '', label: '— none —' }}
        placeholder="Search caregivers…"
        ariaLabel={`Regular caregiver for ${label}`}
        disabled={saving}
      />
      {conflicts.length > 0 && (
        <div className={s.conflictWarn} title={`${conflicts.length} overlap${conflicts.length === 1 ? '' : 's'}`}>
          Also covers another plan on this day
        </div>
      )}
      {saving && <div className={s.savingLine}>Saving…</div>}
    </div>
  );
}
