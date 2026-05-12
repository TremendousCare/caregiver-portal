// Phase 1.5 — Retrospective grading UI.
//
// Admin-only route at `/agent-grading`. Sidebar entry under the
// "AI Agents" section in `AppShell.jsx`. Operator picks an agent +
// filters, then grades each ai_suggestions row good / bad / harmful
// with optional rationale. Bulk-grade applies the same verdict to a
// multi-selection. Keyboard shortcuts: g / b / h on the focused row.
//
// Writes go through `upsert_ai_suggestion_grade_v1` (SECURITY DEFINER,
// admin-gated). The table itself has INSERT/UPDATE/DELETE revoked from
// authenticated — the RPC is the only write path.
//
// Re-grading appends a new row; the latest `graded_at` per
// suggestion_id is the current verdict. Phase 1.2's autonomy v2 reads
// the same grades during promotion evaluation (see
// `mergeGradesIntoActions` in `_shared/operations/autonomy.ts`).
//
// Exit criterion (per `docs/AGENT_PLATFORM.md` Phase 1.5):
//   "Owner can grade ≥ 50 suggestions in an afternoon, verdicts
//    persist, autonomy-v2 algorithm reads them."

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useApp } from '../../shared/context/AppContext';
import { useAgentGrading } from './useAgentGrading';
import {
  latestGradeBySuggestion,
  applyUngradedFilter,
  uniqueActionTypes,
  truncate,
  gradeBreakdown,
  verdictClass,
  VERDICTS,
} from './gradingHelpers';
import styles from './AgentGradingPage.module.css';

const WINDOW_OPTIONS = [
  { id: 7, label: 'Last 7 days' },
  { id: 30, label: 'Last 30 days' },
  { id: 90, label: 'Last 90 days' },
  { id: 0, label: 'All time' },
];

const SOURCE_TYPES = [
  { id: '', label: 'All sources' },
  { id: 'proactive', label: 'Proactive' },
  { id: 'inbound_sms', label: 'Inbound SMS' },
  { id: 'inbound_email', label: 'Inbound email' },
  { id: 'outcome', label: 'Outcome' },
];

export function AgentGradingPage() {
  const { currentUserEmail, showToast } = useApp();
  const [agentId, setAgentId] = useState(null);
  const [sourceType, setSourceType] = useState('');
  const [actionType, setActionType] = useState('');
  const [windowDays, setWindowDays] = useState(30);
  const [ungradedOnly, setUngradedOnly] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [rationale, setRationale] = useState('');
  const [bulkRationale, setBulkRationale] = useState('');
  const [grading, setGrading] = useState(false);
  const tableRef = useRef(null);

  const {
    loading, error,
    agents, agent,
    suggestions, grades,
    gradeOne, gradeMany,
  } = useAgentGrading({
    agentId,
    sourceType,
    actionType,
    windowDays,
    limit: 200,
  });

  // Default to the first agent once loaded.
  useEffect(() => {
    if (!agentId && agents.length > 0) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const latestGrades = useMemo(() => latestGradeBySuggestion(grades), [grades]);
  const actionTypeOptions = useMemo(() => uniqueActionTypes(suggestions), [suggestions]);
  const visible = useMemo(
    () => applyUngradedFilter(suggestions, latestGrades, ungradedOnly),
    [suggestions, latestGrades, ungradedOnly],
  );
  const breakdown = useMemo(
    () => gradeBreakdown(suggestions, latestGrades),
    [suggestions, latestGrades],
  );

  // Reset focus + selection when the visible set changes.
  useEffect(() => {
    setFocusedIdx(0);
    setSelected((prev) => {
      const visibleIds = new Set(visible.map((s) => s.id));
      const next = new Set();
      for (const id of prev) if (visibleIds.has(id)) next.add(id);
      return next;
    });
  }, [visible]);

  const handleGrade = useCallback(async (suggestionId, verdict) => {
    if (grading) return;
    setGrading(true);
    try {
      await gradeOne({
        suggestionId,
        verdict,
        rationale: rationale.trim() || null,
        gradedBy: currentUserEmail ? `user:${currentUserEmail}` : 'user',
      });
      setRationale('');
      if (showToast) showToast(`Marked ${verdict}`);
    } catch (e) {
      if (showToast) showToast(`Grade failed: ${e.message || e}`);
    } finally {
      setGrading(false);
    }
  }, [gradeOne, rationale, currentUserEmail, showToast, grading]);

  const handleBulkGrade = useCallback(async (verdict) => {
    if (grading || selected.size === 0) return;
    setGrading(true);
    try {
      await gradeMany({
        suggestionIds: Array.from(selected),
        verdict,
        rationale: bulkRationale.trim() || null,
        gradedBy: currentUserEmail ? `user:${currentUserEmail}` : 'user',
      });
      setBulkRationale('');
      setSelected(new Set());
      if (showToast) showToast(`Bulk-marked ${selected.size} as ${verdict}`);
    } catch (e) {
      if (showToast) showToast(`Bulk grade failed: ${e.message || e}`);
    } finally {
      setGrading(false);
    }
  }, [gradeMany, selected, bulkRationale, currentUserEmail, showToast, grading]);

  // Keyboard shortcuts: g / b / h on the focused row when not typing.
  // ArrowUp / ArrowDown to navigate.
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toUpperCase();
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (isTyping) return;
      if (visible.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        const s = visible[focusedIdx];
        if (s) handleGrade(s.id, 'good');
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        const s = visible[focusedIdx];
        if (s) handleGrade(s.id, 'bad');
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        const s = visible[focusedIdx];
        if (s) handleGrade(s.id, 'harmful');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, focusedIdx, handleGrade]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === visible.length) setSelected(new Set());
    else setSelected(new Set(visible.map((s) => s.id)));
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>AI Suggestion Grading</h1>
          <p className={styles.subtitle}>
            Retrospectively grade agent suggestions to calibrate the autonomy promotion algorithm.
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
              <option key={a.id} value={a.id}>{a.name} ({a.slug})</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            aria-label="Source type"
          >
            {SOURCE_TYPES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            aria-label="Action type"
          >
            <option value="">All actions</option>
            {actionTypeOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            aria-label="Time window"
          >
            {WINDOW_OPTIONS.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </select>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={ungradedOnly}
              onChange={(e) => setUngradedOnly(e.target.checked)}
            />
            Ungraded only
          </label>
        </div>
      </div>

      {error && (
        <div className={styles.errorState}>
          Failed to load suggestions: {String(error.message || error)}
        </div>
      )}

      {agent && (agent.kill_switch || agent.shadow_mode || agent.read_only_mode) && (
        <div className={styles.statusBanner}>
          Agent is currently
          {agent.kill_switch ? ' killed' : agent.shadow_mode ? ' in shadow mode' : ' read-only'}
          {' '}— historical grades still feed the autonomy algorithm when it next runs.
        </div>
      )}

      <div className={styles.summaryBar}>
        <div className={styles.summaryItem}>
          <span><strong>{suggestions.length}</strong> suggestions in window</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryDot} ${styles.good}`} /> Good: <strong>{breakdown.good}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryDot} ${styles.bad}`} /> Bad: <strong>{breakdown.bad}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryDot} ${styles.harmful}`} /> Harmful: <strong>{breakdown.harmful}</strong>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryDot} ${styles.ungraded}`} /> Ungraded: <strong>{breakdown.ungraded}</strong>
        </div>
      </div>

      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selected.size} selected</span>
          <input
            type="text"
            className={styles.textInput}
            placeholder="Bulk rationale (optional)"
            value={bulkRationale}
            onChange={(e) => setBulkRationale(e.target.value)}
            style={{ flex: '1 1 240px' }}
          />
          {VERDICTS.map((v) => (
            <button
              key={v}
              type="button"
              className={`${styles.verdictBtn} ${styles[`active${v.charAt(0).toUpperCase() + v.slice(1)}`]}`}
              onClick={() => handleBulkGrade(v)}
              disabled={grading}
            >
              Mark {v}
            </button>
          ))}
          <button
            type="button"
            className={styles.verdictBtn}
            onClick={() => setSelected(new Set())}
            disabled={grading}
          >
            Clear
          </button>
        </div>
      )}

      <div className={styles.controls} style={{ marginBottom: 12 }}>
        <input
          type="text"
          className={styles.textInput}
          placeholder="Per-row rationale (optional, applies to next grade click / shortcut)"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          style={{ flex: '1 1 280px' }}
        />
      </div>

      {loading ? (
        <div className={styles.loadingState}>Loading suggestions…</div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>
          {ungradedOnly
            ? 'No ungraded suggestions in the selected window. Try a longer window, or untoggle "Ungraded only".'
            : 'No suggestions in the selected window for this agent.'}
        </div>
      ) : (
        <div className={styles.tableWrap} ref={tableRef}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === visible.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </th>
                <th>Suggestion</th>
                <th style={{ width: 120 }}>Entity</th>
                <th style={{ width: 80 }}>Level</th>
                <th style={{ width: 100 }}>Status</th>
                <th style={{ width: 140 }}>Current grade</th>
                <th style={{ width: 180 }}>Grade</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s, idx) => {
                const grade = latestGrades.get(s.id);
                const isSelected = selected.has(s.id);
                const isFocused = idx === focusedIdx;
                const cls = `${isFocused ? styles.focused : ''} ${isSelected ? styles.selected : ''} ${grade ? styles.gradedRow : ''}`.trim();
                return (
                  <tr
                    key={s.id}
                    className={cls}
                    onClick={() => setFocusedIdx(idx)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(s.id)}
                        aria-label="Select row"
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.title || '(untitled)'}</div>
                      {s.drafted_content && (
                        <div className={styles.drafted}>"{truncate(s.drafted_content, 200)}"</div>
                      )}
                      <div className={styles.metaLine}>
                        {s.source_type && <span className={styles.metaTag}>{s.source_type}</span>}
                        {s.action_type && <span className={styles.metaTag}>{s.action_type}</span>}
                        {s.intent && <span className={styles.metaTag}>intent: {s.intent}</span>}
                        <span className={styles.metaTag}>{new Date(s.created_at).toLocaleDateString()}</span>
                      </div>
                    </td>
                    <td>
                      <div>{s.entity_name || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--tc-text-muted)' }}>{s.entity_type || ''}</div>
                    </td>
                    <td>{s.autonomy_level}</td>
                    <td>{s.status}</td>
                    <td>
                      <div className={`${styles.currentGrade} ${styles[verdictClass(grade?.verdict)]}`}>
                        {grade ? grade.verdict : 'ungraded'}
                      </div>
                      {grade?.rationale && (
                        <div className={styles.rationale} title={grade.rationale}>{grade.rationale}</div>
                      )}
                      {grade?.graded_by && (
                        <div style={{ fontSize: 11, color: 'var(--tc-text-muted)' }}>
                          by {grade.graded_by}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className={styles.verdictGroup}>
                        <button
                          type="button"
                          className={`${styles.verdictBtn} ${grade?.verdict === 'good' ? styles.activeGood : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleGrade(s.id, 'good'); }}
                          disabled={grading}
                          title="Good (g)"
                        >Good</button>
                        <button
                          type="button"
                          className={`${styles.verdictBtn} ${grade?.verdict === 'bad' ? styles.activeBad : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleGrade(s.id, 'bad'); }}
                          disabled={grading}
                          title="Bad (b)"
                        >Bad</button>
                        <button
                          type="button"
                          className={`${styles.verdictBtn} ${grade?.verdict === 'harmful' ? styles.activeHarmful : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleGrade(s.id, 'harmful'); }}
                          disabled={grading}
                          title="Harmful (h)"
                        >Harmful</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.hint}>
        Keyboard: <span className={styles.kbd}>↑</span> / <span className={styles.kbd}>↓</span> navigate,
        {' '}<span className={styles.kbd}>g</span> good,
        {' '}<span className={styles.kbd}>b</span> bad,
        {' '}<span className={styles.kbd}>h</span> harmful.
        Re-grading appends a new row; previous grades are preserved for audit.
      </div>
    </div>
  );
}
