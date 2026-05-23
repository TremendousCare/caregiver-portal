import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Check, X, Plus, CircleDot } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdWeekRecap } from './hooks/useBdWeekRecap';
import {
  getWeekRange,
  groupActivitiesByDay,
  groupPlansByDay,
  computeDaySummary,
  computeWeekSummary,
  formatShortDay,
  formatDayHeader,
  formatWeekRange,
  localIsoDate,
  noonLocalInputForIsoDate,
} from './lib/bdWeekRecap';
import { ACTIVITY_TYPE_LABELS } from './lib/bdQueries';
import { ActivityTypeIcon } from './lib/activityTypeIcon';
import s from './BdPortal.module.css';

// Formats spend cents → "$12.50". Returns "—" for zero so the UI can
// render a placeholder without conditional logic at the call site.
function formatSpend(cents) {
  if (!cents || cents === 0) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTimeOfDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Day-strip tile. Renders the abbreviated weekday, day-of-month, and a
// compact line showing total activities + plan completion ratio. Tiles
// are tappable buttons; the active tile is highlighted via .dayTileActive.
function DayTile({ iso, summary, active, onClick, isToday }) {
  const ratio = summary.planTotal > 0
    ? `${summary.planCompleted}/${summary.planTotal}`
    : null;
  const allDone = summary.planTotal > 0 && summary.planCompleted === summary.planTotal;
  return (
    <button
      type="button"
      className={`${s.dayTile} ${active ? s.dayTileActive : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <div className={s.dayTileWeekday}>{formatShortDay(iso)}{isToday ? ' · today' : ''}</div>
      <div className={s.dayTileDate}>{iso.split('-')[2].replace(/^0/, '')}</div>
      <div className={s.dayTileCounter}>
        {summary.counters.total === 0 ? '—' : summary.counters.total}
      </div>
      {ratio && (
        <div className={`${s.dayTileRatio} ${allDone ? s.dayTileRatioDone : ''}`}>
          {ratio}
        </div>
      )}
    </button>
  );
}

export function WeekRecap() {
  const navigate = useNavigate();
  const { accounts } = useBdAccounts();
  // Build an account lookup once. Used by both the planned-stop list
  // and unplanned-activity list to hydrate account names without an
  // extra query per row.
  const accountById = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  // Anchor week navigation in component state. Start at "this week" —
  // the rep usually wants to review the current week mid-week and the
  // prior week on Monday morning, both reachable in one tap.
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const range = useMemo(() => getWeekRange(anchorDate), [anchorDate]);

  const { loading, plans, activities, error } = useBdWeekRecap(anchorDate);

  // Default selected day: today if the rendered week contains today,
  // otherwise the Monday of that week. Re-resolve whenever the range
  // changes so prev/next-week navigation lands on a sensible day.
  const todayIso = useMemo(() => localIsoDate(new Date()), []);
  const [selectedDay, setSelectedDay] = useState(() => {
    return range.dates.includes(todayIso) ? todayIso : range.dates[0];
  });
  // If the user pages to a different week, re-anchor the selection
  // to today (when visible) or to the Monday of the new week.
  useEffect(() => {
    if (!range.dates.includes(selectedDay)) {
      setSelectedDay(range.dates.includes(todayIso) ? todayIso : range.dates[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  // Per-day summaries — computed once per (plans, activities, range).
  const summaries = useMemo(() => {
    const acts = groupActivitiesByDay(activities, range.dates);
    const plansByDate = groupPlansByDay(plans);
    const out = new Map();
    for (const iso of range.dates) {
      out.set(iso, computeDaySummary({
        plan:       plansByDate.get(iso) ?? null,
        activities: acts.get(iso) ?? [],
      }));
    }
    return out;
  }, [plans, activities, range]);

  const weekSummary = useMemo(
    () => computeWeekSummary({ plans, activities, weekDates: range.dates }),
    [plans, activities, range],
  );

  const selectedSummary = summaries.get(selectedDay) ?? computeDaySummary({ plan: null, activities: [] });

  const isPastOrToday = (iso) => iso <= todayIso;

  function goToWeekContaining(date) {
    setAnchorDate(date);
  }
  function prevWeek() {
    goToWeekContaining(new Date(new Date(anchorDate).setDate(anchorDate.getDate() - 7)));
  }
  function nextWeek() {
    goToWeekContaining(new Date(new Date(anchorDate).setDate(anchorDate.getDate() + 7)));
  }
  const showNextDisabled = range.end >= todayIso;

  function handleBackfill({ accountId = null, dayIso }) {
    // We pre-fill the QuickCapture's `When` field by passing the local
    // datetime via a query param. QuickCapture reads it and falls back
    // to "now" if absent — backwards-compatible with all existing entry
    // points.
    const when = encodeURIComponent(noonLocalInputForIsoDate(dayIso));
    const base = accountId ? `/bd/accounts/${accountId}/log` : '/bd/log';
    navigate(`${base}?when=${when}`);
  }

  return (
    <div>
      {/* Week navigation header */}
      <div className={s.weekNavRow}>
        <button
          type="button"
          className={s.weekNavBtn}
          onClick={prevWeek}
          aria-label="Previous week"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <div className={s.weekNavLabel}>{formatWeekRange(range)}</div>
        <button
          type="button"
          className={s.weekNavBtn}
          onClick={nextWeek}
          disabled={showNextDisabled}
          aria-label="Next week"
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>

      {error && (
        <div className={s.error}>Couldn&rsquo;t load this week: {error.message}</div>
      )}

      {/* Week summary KPIs */}
      <div className={s.weekSummaryRow}>
        <div className={s.weekSummaryStat}>
          <div className={s.weekSummaryValue}>{weekSummary.totalActivities}</div>
          <div className={s.weekSummaryLabel}>activities</div>
        </div>
        <div className={s.weekSummaryStat}>
          <div className={s.weekSummaryValue}>{weekSummary.totalAccountsTouched}</div>
          <div className={s.weekSummaryLabel}>accounts touched</div>
        </div>
        <div className={s.weekSummaryStat}>
          <div className={s.weekSummaryValue}>
            {weekSummary.totalCompleted}<span className={s.weekSummaryDenom}>/{weekSummary.totalPlanned}</span>
          </div>
          <div className={s.weekSummaryLabel}>plan hit</div>
        </div>
        <div className={s.weekSummaryStat}>
          <div className={s.weekSummaryValue}>{formatSpend(weekSummary.totalSpendCents)}</div>
          <div className={s.weekSummaryLabel}>spend</div>
        </div>
      </div>

      {/* Day strip */}
      <div className={s.dayStrip}>
        {range.dates.map((iso) => (
          <DayTile
            key={iso}
            iso={iso}
            summary={summaries.get(iso)}
            active={iso === selectedDay}
            isToday={iso === todayIso}
            onClick={() => setSelectedDay(iso)}
          />
        ))}
      </div>

      {/* Day detail */}
      <div className={s.card}>
        <div className={s.dayDetailHeader}>
          <h2 className={s.dayDetailTitle}>{formatDayHeader(selectedDay)}</h2>
          {isPastOrToday(selectedDay) && (
            <button
              type="button"
              className={s.routeBtn}
              onClick={() => handleBackfill({ dayIso: selectedDay })}
            >
              <Plus size={14} aria-hidden />
              <span>Log activity</span>
            </button>
          )}
        </div>

        {loading && plans.length === 0 && activities.length === 0 ? (
          <p className={s.muted}>Loading week…</p>
        ) : (
          <>
            {/* Plan vs actual */}
            {selectedSummary.planTotal > 0 && (
              <>
                <div className={s.sectionTitle}>Plan vs actual</div>
                <ul className={s.recapList}>
                  {selectedSummary.planned.map((stop) => {
                    const account = accountById.get(stop.account_id);
                    return (
                      <li key={`plan-${stop.account_id}`} className={s.recapRow}>
                        <span
                          className={stop.completed ? s.recapStatusOk : s.recapStatusMissed}
                          aria-hidden
                        >
                          {stop.completed ? <Check size={16} /> : <X size={16} />}
                        </span>
                        <button
                          type="button"
                          className={s.recapBody}
                          onClick={() => account && navigate(`/bd/accounts/${account.id}`)}
                          disabled={!account}
                        >
                          <div className={s.accountName}>
                            {account?.name ?? 'Unknown account'}
                          </div>
                          {stop.activities.length > 0 ? (
                            <div className={s.recapActivityLine}>
                              {stop.activities.map((a, i) => (
                                <span key={a.id ?? i} className={s.recapActivityChip}>
                                  <ActivityTypeIcon type={a.activity_type} size={12} />
                                  <span>{ACTIVITY_TYPE_LABELS[a.activity_type] ?? a.activity_type}</span>
                                  <span className={s.muted}>· {formatTimeOfDay(a.occurred_at)}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className={s.recapActivityLine}>
                              <span className={s.muted}>Not visited</span>
                            </div>
                          )}
                          {stop.activities.some((a) => a.notes) && (
                            <div className={s.recapNotes}>
                              {stop.activities.filter((a) => a.notes).map((a) => a.notes).join(' · ')}
                            </div>
                          )}
                        </button>
                        {!stop.completed && isPastOrToday(selectedDay) && (
                          <button
                            type="button"
                            className={s.recapBackfillBtn}
                            onClick={() => handleBackfill({ accountId: stop.account_id, dayIso: selectedDay })}
                            aria-label={`Log activity for ${account?.name ?? 'this account'}`}
                          >
                            <Plus size={14} aria-hidden />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {/* Unplanned activities */}
            {selectedSummary.unplanned.length > 0 && (
              <>
                <div className={s.sectionTitle} style={{ marginTop: 16 }}>
                  {selectedSummary.planTotal > 0 ? 'Unplanned activities' : 'Activities'}
                </div>
                <ul className={s.recapList}>
                  {selectedSummary.unplanned.map((a) => {
                    const account = accountById.get(a.account_id);
                    return (
                      <li key={`unplanned-${a.id}`} className={s.recapRow}>
                        <span className={s.recapStatusNeutral} aria-hidden>
                          <CircleDot size={16} />
                        </span>
                        <button
                          type="button"
                          className={s.recapBody}
                          onClick={() => account && navigate(`/bd/accounts/${a.account_id}`)}
                          disabled={!account}
                        >
                          <div className={s.accountName}>
                            {account?.name ?? 'Unknown account'}
                          </div>
                          <div className={s.recapActivityLine}>
                            <span className={s.recapActivityChip}>
                              <ActivityTypeIcon type={a.activity_type} size={12} />
                              <span>{ACTIVITY_TYPE_LABELS[a.activity_type] ?? a.activity_type}</span>
                              <span className={s.muted}>· {formatTimeOfDay(a.occurred_at)}</span>
                            </span>
                            {a.spend_cents > 0 && (
                              <span className={s.muted}>· {formatSpend(a.spend_cents)}</span>
                            )}
                          </div>
                          {a.notes && (
                            <div className={s.recapNotes}>{a.notes}</div>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {/* Empty state */}
            {selectedSummary.planTotal === 0 && selectedSummary.unplanned.length === 0 && (
              <p className={s.empty}>
                {selectedDay > todayIso
                  ? 'This day hasn’t happened yet.'
                  : 'No plan or logged activity for this day.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
