import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { getObservationsForCarePlan } from './storage';
import {
  formatObservation,
  groupObservationsByShift,
} from '../../lib/carePlanObservationFormatting';
import s from './CarePlanActivity.module.css';

// ═══════════════════════════════════════════════════════════════
// CarePlanActivity — admin per-client timeline
//
// Renders inside CarePlanPanel as a "Recent activity" block. Lists
// the most recent observations across every shift for this care plan,
// grouped by shift and sorted newest-first. Resolves caregiver names
// (one batch query) and task names (a second batch query keyed off
// the version_ids that appear in the result).
//
// Read-only. Limit defaults to 50 entries — enough for a week of
// typical activity. Older entries are reachable via the per-shift
// drawer view; we don't paginate this surface in v1.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_LIMIT = 50;

export function CarePlanActivity({ carePlanId }) {
  const [observations, setObservations] = useState([]);
  const [caregiverMap, setCaregiverMap] = useState(new Map());
  const [taskMap, setTaskMap] = useState(new Map());
  const [shiftMap, setShiftMap] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!carePlanId) {
      setObservations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const obs = await getObservationsForCarePlan(carePlanId, { limit: DEFAULT_LIMIT });
      setObservations(obs);

      // Batch lookups for the IDs we'll need to resolve in the render.
      const cgIds = uniq(obs.map((o) => o.caregiverId).filter(Boolean));
      const taskIds = uniq(obs.map((o) => o.taskId).filter(Boolean));
      const shiftIds = uniq(obs.map((o) => o.shiftId).filter(Boolean));

      const [cgRes, taskRes, shiftRes] = await Promise.all([
        cgIds.length
          ? supabase.from('caregivers').select('id, first_name, last_name').in('id', cgIds)
          : Promise.resolve({ data: [] }),
        taskIds.length
          ? supabase.from('care_plan_tasks').select('id, task_name, category').in('id', taskIds)
          : Promise.resolve({ data: [] }),
        shiftIds.length
          ? supabase.from('shifts').select('id, start_time, end_time').in('id', shiftIds)
          : Promise.resolve({ data: [] }),
      ]);

      setCaregiverMap(new Map((cgRes.data || []).map((c) => [c.id, c])));
      setTaskMap(new Map(
        (taskRes.data || []).map((t) => [
          t.id,
          { id: t.id, taskName: t.task_name, category: t.category },
        ]),
      ));
      setShiftMap(new Map((shiftRes.data || []).map((sh) => [sh.id, sh])));
    } catch (e) {
      setError(e?.message || 'Could not load recent activity.');
    } finally {
      setLoading(false);
    }
  }, [carePlanId]);

  useEffect(() => { load(); }, [load]);

  const shiftGroups = useMemo(
    () => groupObservationsByShift(observations),
    [observations],
  );

  // ─── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <section className={s.panel}>
        <h4 className={s.title}>Recent activity</h4>
        <div className={s.muted}>Loading…</div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={s.panel}>
        <h4 className={s.title}>Recent activity</h4>
        <div className={s.errorBanner}>{error}</div>
        <button className={s.linkBtn} onClick={load}>Retry</button>
      </section>
    );
  }

  if (observations.length === 0) {
    return (
      <section className={s.panel}>
        <h4 className={s.title}>Recent activity</h4>
        <p className={s.muted}>
          No observations logged yet. Caregivers can log tasks, notes, and refusals from the
          shift detail screen on their app.
        </p>
      </section>
    );
  }

  const reachedCap = observations.length >= DEFAULT_LIMIT;

  return (
    <section className={s.panel}>
      <h4 className={s.title}>Recent activity</h4>
      <p className={s.subtitle}>
        Latest observations from caregiver shifts ({observations.length}
        {reachedCap ? '+' : ''} entries).
      </p>

      <ul className={s.shiftList}>
        {shiftGroups.map((group) => {
          const shiftRow = group.shiftId ? shiftMap.get(group.shiftId) : null;
          const cgIdsOnShift = uniq(group.observations.map((o) => o.caregiverId).filter(Boolean));
          const cgLabel = cgIdsOnShift
            .map((id) => caregiverDisplayName(caregiverMap.get(id)))
            .join(', ');

          return (
            <li key={group.shiftId || `none-${group.observations[0]?.id}`} className={s.shiftBlock}>
              <header className={s.shiftHeader}>
                <span className={s.shiftDate}>{formatShiftHeader(shiftRow)}</span>
                {cgLabel && <span className={s.shiftCaregiver}>{cgLabel}</span>}
              </header>
              <ul className={s.observationList}>
                {group.observations.map((obs) => {
                  const formatted = formatObservation(obs, taskMap);
                  if (!formatted) return null;
                  return (
                    <li key={obs.id} className={`${s.observationRow} ${s[`tone_${formatted.tone}`] || ''}`}>
                      <span className={s.icon}>{formatted.icon}</span>
                      <div className={s.body}>
                        <div className={s.label}>{formatted.label}</div>
                        {formatted.detail && <div className={s.detail}>{formatted.detail}</div>}
                      </div>
                      <span className={s.timestamp}>{formatTime(obs.loggedAt)}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      {reachedCap && (
        <div className={s.muted}>
          Showing the most recent {DEFAULT_LIMIT} entries. Older activity is visible on each
          shift's detail in the schedule.
        </div>
      )}
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

function uniq(arr) {
  return Array.from(new Set(arr));
}

function caregiverDisplayName(cg) {
  if (!cg) return 'Unknown caregiver';
  const first = cg.first_name || '';
  const last = cg.last_name || '';
  const full = `${first} ${last}`.trim();
  return full || 'Unknown caregiver';
}

function formatShiftHeader(shiftRow) {
  if (!shiftRow) return 'Unattributed';
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    return fmt.format(new Date(shiftRow.start_time));
  } catch {
    return shiftRow.start_time || '';
  }
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
