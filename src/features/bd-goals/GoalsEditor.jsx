import { useEffect, useMemo, useState } from 'react';
import { useBdGoals } from './hooks/useBdGoals';
import {
  PERIODS,
  PERIOD_LABELS,
  todayIso,
  isGoalActive,
} from './lib/goalsQueries';
import { supabase } from '../../lib/supabase';
import s from './GoalsEditor.module.css';

function fmtDate(iso) { return iso ? iso : '—'; }
function fmtTarget(n) { return n === null || n === undefined ? '—' : String(n); }

export function GoalsEditor() {
  const { loading, goals, error, refresh, create, submitting } = useBdGoals();
  const [signedInEmail, setSignedInEmail] = useState('');

  const [assignee, setAssignee]       = useState('');
  const [period, setPeriod]           = useState('weekly');
  const [visits, setVisits]           = useState('35');
  const [referrals, setReferrals]     = useState('4');
  const [socs, setSocs]               = useState('2');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes]             = useState('');
  const [formError, setFormError]     = useState('');
  const [success, setSuccess]         = useState('');

  // Pre-fill the assignee field with the signed-in user's email
  // (most common case: owner setting goals for the rep, who is also
  // the owner during single-rep mode).
  useEffect(() => {
    let cancelled = false;
    supabase?.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled && session?.user?.email) {
        setAssignee((cur) => (cur ? cur : session.user.email));
      }
      if (!cancelled) setSignedInEmail(session?.user?.email ?? '');
    });
    return () => { cancelled = true; };
  }, []);

  const sortedGoals = useMemo(() => {
    return [...(goals ?? [])].sort((a, b) => {
      // Active first, then by period, then most-recent effective_from first.
      const aa = isGoalActive(a) ? 0 : 1;
      const bb = isGoalActive(b) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      if (a.period !== b.period) return a.period.localeCompare(b.period);
      return (b.effective_from ?? '').localeCompare(a.effective_from ?? '');
    });
  }, [goals]);

  function parseIntOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : v; // pass through a non-int so validation catches it
  }

  async function handleSave() {
    setFormError('');
    setSuccess('');
    const draft = {
      assignee_email:   assignee,
      period,
      visits_target:    parseIntOrNull(visits),
      referrals_target: parseIntOrNull(referrals),
      soc_target:       parseIntOrNull(socs),
      effective_from:   effectiveFrom,
      effective_to:     null,
      notes,
    };
    try {
      await create(draft);
      setSuccess('Saved. The previous active goal (if any) has been closed out.');
      setNotes('');
    } catch (e) {
      setFormError(e?.message ?? 'Could not save. Try again.');
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>BD Goals</h1>
        <p className={s.subtitle}>
          Set weekly and monthly targets for the BD rep. The Today screen and the Funnel report
          render counters as <strong>actual / target</strong> when an active goal exists.
        </p>
      </div>

      {error && <div className={s.error}>Couldn&rsquo;t load goals: {error.message}</div>}

      <div className={s.row2}>
        <div className={s.card}>
          <h2 className={s.cardTitle}>New goal</h2>
          <p className={s.cardSub}>Saving closes out the previous active goal for the same rep + period.</p>

          {formError && <div className={s.error}>{formError}</div>}
          {success && <div className={s.success}>{success}</div>}

          <div className={s.field}>
            <label className={s.fieldLabel}>Assignee email</label>
            <input
              className={s.input}
              type="email"
              autoComplete="email"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="rep@yourdomain.com"
            />
            {signedInEmail && assignee !== signedInEmail && (
              <p className={s.cardSub} style={{ margin: 0 }}>
                Your account is <strong>{signedInEmail}</strong>. Use the rep&rsquo;s actual email if it differs.
              </p>
            )}
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel}>Period</label>
            <select className={s.input} value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
              ))}
            </select>
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel}>Targets</label>
            <div className={s.threeUp}>
              <input
                className={s.input}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Visits"
                value={visits}
                onChange={(e) => setVisits(e.target.value)}
              />
              <input
                className={s.input}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Referrals"
                value={referrals}
                onChange={(e) => setReferrals(e.target.value)}
              />
              <input
                className={s.input}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="SOCs"
                value={socs}
                onChange={(e) => setSocs(e.target.value)}
              />
            </div>
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel}>Effective from</label>
            <input
              className={s.input}
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel}>Notes (optional)</label>
            <input
              className={s.input}
              type="text"
              placeholder="Why this target? (visible in goal history)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <button type="button" className={s.button} disabled={submitting} onClick={handleSave}>
            {submitting ? 'Saving…' : 'Save goal'}
          </button>
        </div>

        <div className={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className={s.cardTitle}>All goals</h2>
            <button type="button" className={s.refreshBtn} onClick={refresh}>Refresh</button>
          </div>
          <p className={s.cardSub}>Active goals appear first. Setting a new goal closes the prior one automatically.</p>
          {loading ? (
            <div className={s.empty}>Loading…</div>
          ) : sortedGoals.length === 0 ? (
            <div className={s.empty}>No goals yet. Create the first one on the left.</div>
          ) : (
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Assignee</th>
                  <th>Period</th>
                  <th className={s.numCell}>Visits</th>
                  <th className={s.numCell}>Refs</th>
                  <th className={s.numCell}>SOCs</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {sortedGoals.map((g) => (
                  <tr key={g.id}>
                    <td>
                      {g.assignee_email}
                      {isGoalActive(g) && <span className={s.activeBadge}>active</span>}
                    </td>
                    <td>{PERIOD_LABELS[g.period] ?? g.period}</td>
                    <td className={s.numCell}>{fmtTarget(g.visits_target)}</td>
                    <td className={s.numCell}>{fmtTarget(g.referrals_target)}</td>
                    <td className={s.numCell}>{fmtTarget(g.soc_target)}</td>
                    <td>{fmtDate(g.effective_from)}</td>
                    <td>{fmtDate(g.effective_to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
