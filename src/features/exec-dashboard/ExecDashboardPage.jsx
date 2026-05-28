import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, RefreshCw, AlertCircle, ListChecks,
  TrendingUp, Activity, Eye,
} from 'lucide-react';
import { useApp } from '../../shared/context/AppContext';
import { useExecDashboard } from './hooks/useExecDashboard';
import {
  buildQuarterOptions,
  formatQuarterLabel,
} from '../exec-goals/lib/goalsHelpers';
import {
  summarizeGoal,
  findStaleKrs,
  findAtRiskGoals,
  findOverdueTasks,
  findMyTasksThisWeek,
  computeKpiStats,
  STALE_KR_DAYS,
} from './lib/dashboardHelpers';
import s from './ExecDashboardPage.module.css';

// ─── Tiny display helpers ─────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dueClass(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d.getTime() < today.getTime()) return s.dueOverdue;
  if (d.toDateString() === new Date().toDateString()) return s.dueToday;
  return s.dueSoon;
}

function dueLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return `Overdue · ${fmtDate(iso)}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= 7) return `In ${days} days`;
  return fmtDate(iso);
}

const STATUS_CLS = {
  draft:     s.statusDraft,
  active:    s.statusActive,
  achieved:  s.statusAchieved,
  missed:    s.statusMissed,
  cancelled: s.statusCancelled,
};

function fillClass(confidence) {
  if (confidence === 'red') return s.fillRed;
  if (confidence === 'yellow') return s.fillYellow;
  return s.fillGreen;
}

function dotClass(confidence) {
  if (confidence === 'red') return s.dotRed;
  if (confidence === 'yellow') return s.dotYellow;
  return s.dotGreen;
}

// ─── Page ─────────────────────────────────────────────────────

export function ExecDashboardPage() {
  const { currentOrgRole, currentUserEmail } = useApp();
  const readOnly = currentOrgRole !== 'owner';

  const {
    loading, goals, tasks, tasksAvailable, error,
    quarter, setQuarter, refresh,
  } = useExecDashboard();

  const quarterOptions = useMemo(() => {
    const opts = new Set(buildQuarterOptions(goals));
    if (quarter) opts.add(quarter);
    return Array.from(opts).sort((a, b) => b.localeCompare(a));
  }, [goals, quarter]);

  const kpi = useMemo(
    () => computeKpiStats({ goals, tasks, email: currentUserEmail }),
    [goals, tasks, currentUserEmail],
  );

  const activeGoals = useMemo(
    () => (goals ?? []).filter((g) => g.status === 'active' || g.status === 'draft'),
    [goals],
  );

  const myTasks    = useMemo(() => findMyTasksThisWeek(tasks, currentUserEmail), [tasks, currentUserEmail]);
  const overdue    = useMemo(() => findOverdueTasks(tasks), [tasks]);
  const staleKrs   = useMemo(() => findStaleKrs(goals), [goals]);
  const atRisk     = useMemo(() => findAtRiskGoals(goals), [goals]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>
            <LayoutDashboard size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Executive dashboard
            {readOnly && <span className={s.roBadge}>Read-only</span>}
          </h1>
          <p className={s.subtitle}>
            {readOnly
              ? `Snapshot of company goals for ${formatQuarterLabel(quarter)}.`
              : `Snapshot for ${formatQuarterLabel(quarter)}: goals, your tasks this week, and what needs attention.`}
          </p>
        </div>
        <div className={s.headerRight}>
          <div className={s.quarterPicker}>
            <span className={s.quarterPickerLabel}>Quarter</span>
            <select
              className={s.quarterPickerSelect}
              value={quarter ?? ''}
              onChange={(e) => setQuarter(e.target.value)}
            >
              {quarterOptions.map((q) => (
                <option key={q} value={q}>{formatQuarterLabel(q)}</option>
              ))}
            </select>
          </div>
          <button type="button" className={s.secondaryBtn} onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className={s.error}>
          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {error?.message ?? 'Could not load dashboard.'}
        </div>
      )}

      {/* ── KPI strip ── */}
      <div className={s.kpiGrid}>
        <KpiCard label="Active goals" value={activeGoals.length} hint={`of ${(goals ?? []).length} this quarter`} />
        {tasksAvailable && (
          <KpiCard
            label="My open tasks"
            value={kpi.my_this_week}
            hint={`due in next ${7} days`}
            warn={kpi.my_this_week > 0}
          />
        )}
        <KpiCard
          label="Overdue tasks"
          value={tasksAvailable ? kpi.overdue_tasks : '—'}
          hint={tasksAvailable ? 'past due, not done' : 'requires owner access'}
          alert={tasksAvailable && kpi.overdue_tasks > 0}
        />
        <KpiCard
          label="Stale check-ins"
          value={kpi.stale_krs}
          hint={`KRs > ${STALE_KR_DAYS} days`}
          warn={kpi.stale_krs > 0}
        />
      </div>

      {/* ── Two columns ── */}
      <div className={s.body}>
        <div>
          <div className={s.section}>
            <div className={s.sectionHeader}>
              <h2 className={s.sectionTitle}>
                <TrendingUp size={16} />
                Goals — {formatQuarterLabel(quarter)}
              </h2>
              <Link className={s.sectionLink} to="/exec/goals">View all →</Link>
            </div>
            {loading ? (
              <div className={s.sectionEmpty}>Loading…</div>
            ) : activeGoals.length === 0 ? (
              <div className={s.sectionEmpty}>
                No active goals for this quarter. {readOnly ? '' : <>Head to <Link className={s.sectionLink} to="/exec/goals">Goals</Link> to set them.</>}
              </div>
            ) : (
              activeGoals.map((g) => <GoalCard key={g.id} goal={g} />)
            )}
          </div>
        </div>

        <div>
          {tasksAvailable && (
            <div className={s.section}>
              <div className={s.sectionHeader}>
                <h2 className={s.sectionTitle}>
                  <ListChecks size={16} />
                  My tasks this week
                </h2>
                <Link className={s.sectionLink} to="/exec/tasks">All tasks →</Link>
              </div>
              {loading ? (
                <div className={s.sectionEmpty}>Loading…</div>
              ) : myTasks.length === 0 ? (
                <div className={s.sectionEmpty}>You&rsquo;re clear. Nothing due in the next 7 days.</div>
              ) : (
                myTasks.slice(0, 6).map((t) => (
                  <div key={t.id} className={s.listItem}>
                    <div className={s.listItemMain}>
                      <p className={s.listItemTitle}>{t.title}</p>
                      <p className={s.listItemMeta}>
                        {t.urgency} · {t.category}
                        {t.anchor_staff_email && <> · {t.anchor_staff_email}</>}
                      </p>
                    </div>
                    <span className={`${s.dueBadge} ${dueClass(t.due_at)}`}>{dueLabel(t.due_at)}</span>
                  </div>
                ))
              )}
            </div>
          )}

          <div className={s.section}>
            <div className={s.sectionHeader}>
              <h2 className={s.sectionTitle}>
                <Eye size={16} />
                Watchlist
              </h2>
            </div>
            <Watchlist
              atRisk={atRisk}
              staleKrs={staleKrs}
              overdue={overdue}
              tasksAvailable={tasksAvailable}
            />
          </div>

          <div className={s.section}>
            <div className={s.sectionHeader}>
              <h2 className={s.sectionTitle}>
                <Activity size={16} />
                Quick links
              </h2>
            </div>
            <p className={s.sectionEmpty} style={{ paddingBottom: 8 }}>
              <Link className={s.sectionLink} to="/exec/goals">Goals</Link>
              {tasksAvailable && <> · <Link className={s.sectionLink} to="/exec/tasks">Tasks</Link></>}
              {tasksAvailable && <> · <Link className={s.sectionLink} to="/exec/templates">Templates</Link></>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────

function KpiCard({ label, value, hint, alert, warn }) {
  const cardCls = alert ? s.kpiCardAlert : warn ? s.kpiCardWarn : '';
  const valCls  = alert ? s.kpiValueAlert : warn ? s.kpiValueWarn : '';
  return (
    <div className={`${s.kpiCard} ${cardCls}`}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={`${s.kpiValue} ${valCls}`}>{value}</div>
      {hint && <div className={s.kpiHint}>{hint}</div>}
    </div>
  );
}

function GoalCard({ goal }) {
  const sm = summarizeGoal(goal);
  const pctPct = Number.isFinite(sm.avgPct)
    ? Math.round(Math.min(1, Math.max(0, sm.avgPct)) * 100)
    : null;
  return (
    <div className={s.goalCard}>
      <div className={s.goalHead}>
        <div className={s.listItemMain}>
          <h3 className={s.goalTitle}>
            <span className={`${s.confidenceDot} ${dotClass(sm.worstConfidence)}`} />
            {goal.title}
            <span className={`${s.statusBadge} ${STATUS_CLS[goal.status] ?? ''}`}>{goal.status}</span>
          </h3>
          <p className={s.goalMeta}>
            {goal.owner_email} · {sm.krCount} KR{sm.krCount === 1 ? '' : 's'}
            {sm.achievedCount > 0 && <> · {sm.achievedCount} achieved</>}
          </p>
        </div>
        <div className={s.goalStats}>
          <div className={s.goalPct}>{pctPct !== null ? `${pctPct}%` : '—'}</div>
          <div>avg progress</div>
        </div>
      </div>
      {pctPct !== null && (
        <div className={s.progressBar}>
          <div
            className={`${s.progressFill} ${fillClass(sm.worstConfidence)}`}
            style={{ width: `${pctPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Watchlist({ atRisk, staleKrs, overdue, tasksAvailable }) {
  const hasAny = atRisk.length > 0 || staleKrs.length > 0 || (tasksAvailable && overdue.length > 0);
  if (!hasAny) {
    return <p className={s.sectionEmpty}>Nothing needs immediate attention. Nice.</p>;
  }
  return (
    <>
      {atRisk.map(({ goal, summary }) => (
        <div key={`at-risk-${goal.id}`} className={s.listItem}>
          <div className={s.listItemMain}>
            <p className={s.listItemTitle}>{goal.title}</p>
            <p className={s.listItemMeta}>
              At-risk goal · {summary.krCount} KR{summary.krCount === 1 ? '' : 's'}, worst confidence{' '}
              <span className={`${s.confidenceDot} ${dotClass(summary.worstConfidence)}`} />
              {summary.worstConfidence}
            </p>
          </div>
          <Link className={s.sectionLink} to="/exec/goals">View →</Link>
        </div>
      ))}
      {staleKrs.slice(0, 5).map((item) => (
        <div key={`stale-${item.kr_id}`} className={s.listItem}>
          <div className={s.listItemMain}>
            <p className={s.listItemTitle}>{item.kr_title}</p>
            <p className={s.listItemMeta}>
              {item.goal_title} · {item.days_since_checkin === null
                ? 'never checked in'
                : `${item.days_since_checkin} days since check-in`}
            </p>
          </div>
          <Link className={s.sectionLink} to="/exec/goals">Check in →</Link>
        </div>
      ))}
      {tasksAvailable && overdue.slice(0, 5).map((t) => (
        <div key={`overdue-${t.id}`} className={s.listItem}>
          <div className={s.listItemMain}>
            <p className={s.listItemTitle}>{t.title}</p>
            <p className={s.listItemMeta}>
              Overdue · {t.urgency} · {t.assigned_to || 'unassigned'}
            </p>
          </div>
          <span className={`${s.dueBadge} ${s.dueOverdue}`}>{dueLabel(t.due_at)}</span>
        </div>
      ))}
    </>
  );
}
