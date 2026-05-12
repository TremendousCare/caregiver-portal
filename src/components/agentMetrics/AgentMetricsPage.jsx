// Phase 1.4 — Per-agent metrics dashboard.
//
// Admin-only route at `/agent-metrics`. Sidebar entry added in
// `AppShell.jsx`. Reads-only (no writes) — every chart pulls from
// `agent_actions` (Phase 1.1) and `action_outcomes` (Phase 0.2),
// scoped to the selected agent + time window.
//
// Exit criterion (per `docs/AGENT_PLATFORM.md` Phase 1.4):
//   "Owner can answer 'is this agent earning its keep?' in under a
//    minute."
//
// The layout is intentionally simple: a per-agent selector, a
// time-window control (Day / Week / 30d), four data cards, and one
// placeholder for drift events (deferred — the consolidation pipeline
// it depends on doesn't exist yet).

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useAgentMetrics } from './useAgentMetrics';
import {
  TIME_WINDOWS,
  aggregateTokenSpend,
  aggregateLatency,
  aggregateSuggestionVolume,
  aggregateVerifiedOutcomeRate,
  costPerVerifiedOutcome,
  totals,
} from './metricsAggregation';
import { exportAgentMetricsCsv } from './csvExport';
import styles from './AgentMetricsPage.module.css';

const NUMBER = new Intl.NumberFormat('en-US');
const DOLLAR = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const DOLLAR_PRECISE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

export function AgentMetricsPage() {
  const [agentId, setAgentId] = useState(null);
  const [windowId, setWindowId] = useState('week');

  const {
    loading, error, agents, agent, actions, outcomes, window,
  } = useAgentMetrics({ agentId, windowId });

  // Default to the first agent once loaded.
  useEffect(() => {
    if (!agentId && agents.length > 0) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const tokenSpend = useMemo(
    () => aggregateTokenSpend(actions, { bucket: window.bucket }),
    [actions, window.bucket],
  );
  const latency = useMemo(
    () => aggregateLatency(actions, { bucket: window.bucket }),
    [actions, window.bucket],
  );
  const volume = useMemo(() => aggregateSuggestionVolume(actions), [actions]);
  const outcomeRate = useMemo(
    () => aggregateVerifiedOutcomeRate(actions, outcomes),
    [actions, outcomes],
  );
  const headlineTotals = useMemo(() => totals(actions), [actions]);
  const cpo = useMemo(
    () => costPerVerifiedOutcome(actions, outcomes),
    [actions, outcomes],
  );

  const handleExport = useCallback(() => {
    if (!agent) return;
    exportAgentMetricsCsv({ agent, window, actions, outcomes });
  }, [agent, window, actions, outcomes]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>AI Agent Metrics</h1>
          <p className={styles.subtitle}>
            Token spend, suggestion volume, and verified-outcome rate for each agent.
          </p>
        </div>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={agentId || ''}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="Select agent"
          >
            {agents.length === 0 && <option value="">No agents</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.slug})
              </option>
            ))}
          </select>
          <div className={styles.segmented} role="group" aria-label="Time window">
            {TIME_WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWindowId(w.id)}
                className={`${styles.segmentedButton} ${w.id === windowId ? styles.segmentedButtonActive : ''}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.exportButton}
            onClick={handleExport}
            disabled={!agent || actions.length === 0}
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.errorState}>
          Failed to load metrics: {String(error.message || error)}
        </div>
      )}

      {agent && (agent.kill_switch || agent.shadow_mode || agent.read_only_mode) && (
        <div className={`${styles.statusBanner} ${agent.kill_switch ? styles.statusBannerKill : ''}`}>
          {agent.kill_switch && <>Kill switch engaged — agent is dormant. Metrics still update if other writers exist.</>}
          {!agent.kill_switch && agent.shadow_mode && <>Shadow mode — confirm-tier actions suppressed. These metrics still update.</>}
          {!agent.kill_switch && !agent.shadow_mode && agent.read_only_mode && <>Read-only mode — all tool calls suppressed. These metrics still update.</>}
        </div>
      )}

      {loading ? (
        <div className={styles.loadingState}>Loading metrics…</div>
      ) : actions.length === 0 ? (
        <div className={styles.empty}>
          No agent activity in the selected window. Try a longer window, or wait for the agent to record actions.
        </div>
      ) : (
        <>
          <div className={styles.kpiGrid}>
            <KpiCard label="Total Spend" value={DOLLAR.format(headlineTotals.dollars)} sub={`${NUMBER.format(headlineTotals.input_tokens)} in / ${NUMBER.format(headlineTotals.output_tokens)} out`} />
            <KpiCard label="Invocations" value={NUMBER.format(headlineTotals.invocations_total)} sub={`${NUMBER.format(headlineTotals.invocations_with_cost)} with cost data`} />
            <KpiCard
              label="Cost / Verified Outcome"
              value={cpo.cost_per === null ? '—' : DOLLAR_PRECISE.format(cpo.cost_per)}
              sub={cpo.cost_per === null ? 'No verified outcomes yet' : `${NUMBER.format(cpo.verified)} verified`}
            />
            <KpiCard
              label="Avg Latency"
              value={
                latency.length === 0
                  ? '—'
                  : `${NUMBER.format(Math.round(latency.reduce((s, l) => s + l.avg_ms, 0) / latency.length))} ms`
              }
              sub={`${window.label} avg per call`}
            />
          </div>

          <div className={styles.chartGrid}>
            <div className={styles.chartCard}>
              <h2 className={styles.chartTitle}>Token Spend</h2>
              <p className={styles.chartSubtitle}>Input + output tokens per {window.bucket === 'hour' ? 'hour' : 'day'}.</p>
              <div className={styles.chartBody}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={tokenSpend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value, name) => [NUMBER.format(value), name === 'input_tokens' ? 'Input' : 'Output']}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="input_tokens" stackId="t" fill="#29BEE4" name="Input" />
                    <Bar dataKey="output_tokens" stackId="t" fill="#2E4E8D" name="Output" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className={styles.chartCard}>
              <h2 className={styles.chartTitle}>Average Latency</h2>
              <p className={styles.chartSubtitle}>End-to-end duration per Claude call, ms.</p>
              <div className={styles.chartBody}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={latency}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value) => [`${NUMBER.format(value)} ms`, 'Avg']} />
                    <Line type="monotone" dataKey="avg_ms" stroke="#2E4E8D" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className={styles.chartCard}>
              <h2 className={styles.chartTitle}>Suggestion Volume</h2>
              <p className={styles.chartSubtitle}>Count of agent_actions by phase.</p>
              <div className={styles.chartBody}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={volume}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value) => [NUMBER.format(value), 'Count']} />
                    <Bar dataKey="count" fill="#29BEE4" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className={styles.chartCard}>
              <h2 className={styles.chartTitle}>Verified Outcome Rate by Action Type</h2>
              <p className={styles.chartSubtitle}>Success rate among actions with a third-party-verified outcome.</p>
              <table className={styles.outcomeTable}>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Total</th>
                    <th>Verified</th>
                    <th>Success Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomeRate.length === 0 && (
                    <tr><td colSpan={4} style={{ color: 'var(--tc-text-muted)', textAlign: 'center', padding: 24 }}>No actions recorded</td></tr>
                  )}
                  {outcomeRate.map((r) => (
                    <tr key={r.action_type}>
                      <td>{r.action_type}</td>
                      <td>{NUMBER.format(r.total)}</td>
                      <td>{NUMBER.format(r.verified)}</td>
                      <td>
                        {r.success_rate === null ? (
                          <span style={{ color: 'var(--tc-text-muted)' }}>—</span>
                        ) : (
                          <div className={styles.rateBar}>
                            <div className={styles.rateBarTrack}>
                              <div className={styles.rateBarFill} style={{ width: `${Math.round(r.success_rate * 100)}%` }} />
                            </div>
                            <span>{PERCENT.format(r.success_rate)}</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.chartCard}>
              <h2 className={styles.chartTitle}>Drift Events</h2>
              <p className={styles.chartSubtitle}>Pattern shifts detected by the consolidation pipeline.</p>
              <div className={styles.placeholder}>
                <div className={styles.placeholderTitle}>Not yet instrumented</div>
                <div>The consolidation pipeline that produces drift events ships in a later phase.</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
