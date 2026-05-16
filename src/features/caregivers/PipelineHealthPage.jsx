// ─── Pipeline Health (Phase 1.5 follow-up — replaces AI Priorities) ───
//
// Daily-driver surface for "where is my pipeline stuck, who needs me?"
// Phase-grouped table of caregivers, sorted by days-in-phase.
// AI suggestions surface as small inline badges (click for reasoning,
// no action buttons — operators act through the regular UI, which
// PR #347 already closes the loop on).
//
// Spec: docs/AGENT_PLATFORM_PIPELINE_HEALTH_SPEC.md (decisions §8 D1-D5
// locked 2026-05-15). Read-only V1; no new schema, no new edge function.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import { PHASES } from '../../lib/constants';
import {
  STALL_AMBER_DAYS,
  STALL_RED_DAYS,
  groupCaregiversByPhase,
  medianDaysInPhase,
  indexSuggestionsByEntity,
  filterPipelineGroups,
} from '../../lib/pipelineHealth';

// ─── Action-type display ───
const ACTION_LABELS = {
  send_sms: 'Send SMS',
  send_email: 'Send email',
  add_note: 'Add note',
  update_phase: 'Move phase',
  complete_task: 'Complete task',
  create_calendar_event: 'Schedule event',
  send_docusign_envelope: 'Send DocuSign',
  task_create: 'Create task',
};

// ─── Event-type display ───
const EVENT_LABELS = {
  sms_sent:       'SMS sent',
  sms_received:   'SMS received',
  email_sent:     'Email sent',
  email_received: 'Email received',
  note_added:     'Note added',
  phase_changed:  'Phase changed',
  task_completed: 'Task completed',
  docusign_sent:  'DocuSign sent',
  docusign_completed: 'DocuSign completed',
  calendar_event_created: 'Event created',
};

function formatRelative(iso) {
  if (!iso) return '';
  const elapsedMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(elapsedMs) || elapsedMs < 0) return '';
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1)  return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ═══════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════

export function PipelineHealthPage() {
  const navigate = useNavigate();
  const { onboardingCaregivers, tasksVersion } = useCaregivers();

  // ─── Filter state ───
  // Per spec §2: phase multi-select pills (all on by default),
  // stalled-only toggle (off by default — D5), has-AI-suggestion
  // toggle (off by default).
  const [phaseFilter, setPhaseFilter] = useState(
    () => new Set(PHASES.map((p) => p.id)),
  );
  const [stalledOnly, setStalledOnly] = useState(false);
  const [hasAiOnly, setHasAiOnly]     = useState(false);

  // ─── Pending AI suggestions (independent fetch + realtime) ───
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const channelRef = useRef(null);

  const fetchSuggestions = useCallback(async () => {
    const { data, error } = await supabase
      .from('ai_suggestions')
      .select('id, entity_id, entity_type, action_type, title, detail, drafted_content, source_type, created_at, expires_at')
      .eq('status', 'pending')
      .eq('entity_type', 'caregiver')
      .not('entity_id', 'is', null)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (!error && Array.isArray(data)) setAiSuggestions(data);
  }, []);

  useEffect(() => {
    fetchSuggestions();
    const ch = supabase
      .channel('pipeline-health-suggestions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => fetchSuggestions(),
      )
      .subscribe();
    channelRef.current = ch;
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, [fetchSuggestions]);

  // ─── Latest event per visible caregiver (one-shot fetch) ───
  // Per spec §3, this is the "last operator action" column. We fetch
  // the freshest event per entity in a 30-day window and reduce to a
  // map. Refreshed on focus / on caregiver list change.
  const [latestEventByEntity, setLatestEventByEntity] = useState(new Map());

  const visibleCaregiverIds = useMemo(
    () => onboardingCaregivers.map((c) => c.id),
    [onboardingCaregivers],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (visibleCaregiverIds.length === 0) {
        if (!cancelled) setLatestEventByEntity(new Map());
        return;
      }
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('events')
        .select('entity_id, event_type, actor, created_at')
        .eq('entity_type', 'caregiver')
        .in('entity_id', visibleCaregiverIds)
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false });
      if (cancelled || error || !Array.isArray(data)) return;
      // Reduce to freshest per entity.
      const map = new Map();
      for (const row of data) {
        if (!map.has(row.entity_id)) map.set(row.entity_id, row);
      }
      setLatestEventByEntity(map);
    }
    load();
    return () => { cancelled = true; };
  }, [visibleCaregiverIds, tasksVersion]);

  // ─── Derived data ───
  const grouped = useMemo(
    () => groupCaregiversByPhase(onboardingCaregivers),
    [onboardingCaregivers, tasksVersion],
  );

  const suggestionByEntity = useMemo(
    () => indexSuggestionsByEntity(aiSuggestions),
    [aiSuggestions],
  );

  const filtered = useMemo(
    () => filterPipelineGroups(grouped, {
      phaseFilter,
      stalledOnly,
      hasAiSuggestion: hasAiOnly,
      suggestionByEntity,
    }),
    [grouped, phaseFilter, stalledOnly, hasAiOnly, suggestionByEntity],
  );

  const totalVisible = useMemo(
    () => Object.values(filtered).reduce((acc, rows) => acc + rows.length, 0),
    [filtered],
  );

  const togglePhase = (phaseId) => {
    setPhaseFilter((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) next.delete(phaseId);
      else next.add(phaseId);
      return next;
    });
  };

  // ═════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1F2937' }}>Pipeline Health</h1>
        <span style={{ fontSize: 13, color: '#6B7280' }}>
          {totalVisible} caregiver{totalVisible === 1 ? '' : 's'} shown
        </span>
      </div>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: '#6B7280', maxWidth: 760 }}>
        Caregivers grouped by their current onboarding phase, sorted by how long they've been stalled.
        Rows in amber have been in the same phase for {STALL_AMBER_DAYS}+ days; red marks {STALL_RED_DAYS}+
        days. AI suggestions show as small badges — click for the AI's reasoning.
      </p>

      {/* ─── Filter bar ─── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
        padding: '12px 14px', background: '#F8FAFC', border: '1px solid #E2E8F0',
        borderRadius: 8, marginBottom: 18,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#4A5568' }}>Phase:</span>
        {PHASES.map((p) => {
          const on = phaseFilter.has(p.id);
          return (
            <button
              key={p.id}
              onClick={() => togglePhase(p.id)}
              style={{
                padding: '4px 10px', borderRadius: 16,
                border: '1px solid', borderColor: on ? p.color : '#CBD5E1',
                background: on ? `${p.color}18` : '#FFFFFF',
                color: on ? p.color : '#6B7280',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {p.icon} {p.short}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4A5568', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={stalledOnly}
            onChange={(e) => setStalledOnly(e.target.checked)}
          />
          Stalled only ({STALL_AMBER_DAYS}+ days)
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4A5568', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hasAiOnly}
            onChange={(e) => setHasAiOnly(e.target.checked)}
          />
          Has AI suggestion
        </label>
      </div>

      {/* ─── Phase sections ─── */}
      {PHASES.map((p) => {
        if (!phaseFilter.has(p.id)) return null;
        const rows = filtered[p.id] || [];
        const all  = grouped[p.id] || [];
        return (
          <section key={p.id} style={{ marginBottom: 22 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 10,
              padding: '8px 12px', background: `${p.color}10`, borderRadius: 8,
              borderLeft: `4px solid ${p.color}`, marginBottom: 8,
            }}>
              <span style={{ fontSize: 16 }}>{p.icon}</span>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: p.color }}>
                {p.label}
              </h2>
              <span style={{ fontSize: 12, color: '#64748B' }}>
                {rows.length === all.length
                  ? `(${rows.length})`
                  : `(${rows.length} of ${all.length})`}
              </span>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>
                · median {medianDaysInPhase(all)}d in phase
              </span>
            </div>

            {rows.length === 0 ? (
              <div style={{ fontSize: 13, color: '#94A3B8', padding: '12px 14px', fontStyle: 'italic' }}>
                {all.length === 0
                  ? `(0 caregivers in ${p.short})`
                  : '(no caregivers match the current filters)'}
              </div>
            ) : (
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
                <PipelineRowsTable
                  rows={rows}
                  suggestionByEntity={suggestionByEntity}
                  latestEventByEntity={latestEventByEntity}
                  onSelect={(id) => navigate(`/caregiver/${id}`)}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Rows table
// ═══════════════════════════════════════════════════════════════

function PipelineRowsTable({ rows, suggestionByEntity, latestEventByEntity, onSelect }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#F1F5F9', textAlign: 'left' }}>
          <th style={th}>Caregiver</th>
          <th style={{ ...th, width: 110 }}>Days in phase</th>
          <th style={{ ...th, width: 120 }}>Last activity</th>
          <th style={th}>Last operator action</th>
          <th style={{ ...th, width: 200 }}>AI</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <PipelineRow
            key={r.caregiver.id}
            row={r}
            suggestion={suggestionByEntity.get(r.caregiver.id) || null}
            latestEvent={latestEventByEntity.get(r.caregiver.id) || null}
            onSelect={onSelect}
            isLast={idx === rows.length - 1}
          />
        ))}
      </tbody>
    </table>
  );
}

const th = {
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 600,
  color: '#475569',
  borderBottom: '1px solid #E2E8F0',
};

const td = {
  padding: '8px 12px',
  borderBottom: '1px solid #F1F5F9',
  verticalAlign: 'middle',
};

// ═══════════════════════════════════════════════════════════════
// One pipeline row
// ═══════════════════════════════════════════════════════════════

function PipelineRow({ row, suggestion, latestEvent, onSelect, isLast }) {
  const [expanded, setExpanded] = useState(false);
  const { caregiver, daysInPhase, daysSinceActivity, severity } = row;
  const name = [caregiver.first_name || caregiver.firstName, caregiver.last_name || caregiver.lastName]
    .filter(Boolean).join(' ').trim() || 'Unknown';

  const rowBg = severity === 'red'   ? '#FEF2F2'
              : severity === 'amber' ? '#FFFBEB'
              : '#FFFFFF';

  const daysInPhaseColor = severity === 'red'   ? '#B91C1C'
                         : severity === 'amber' ? '#B45309'
                         : '#1F2937';

  const lastEventText = (() => {
    if (!latestEvent) return '—';
    const label = EVENT_LABELS[latestEvent.event_type] || latestEvent.event_type;
    const actor = latestEvent.actor ? latestEvent.actor.replace(/^user:/, '').replace(/^system:/, '') : '';
    return `${label} ${formatRelative(latestEvent.created_at)}${actor ? ` by ${actor}` : ''}`;
  })();

  const lastActivityText = daysSinceActivity == null ? '—'
    : daysSinceActivity === 0 ? 'today'
    : daysSinceActivity === 1 ? '1d ago'
    : `${daysSinceActivity}d ago`;

  return (
    <>
      <tr
        style={{ background: rowBg, cursor: 'pointer' }}
        onClick={() => onSelect(caregiver.id)}
      >
        <td style={{ ...td, ...(isLast && !expanded ? { borderBottom: 'none' } : {}) }}>
          <span style={{ fontWeight: 600, color: '#1F2937' }}>{name}</span>
        </td>
        <td style={{ ...td, color: daysInPhaseColor, fontWeight: severity !== 'none' ? 600 : 400 }}>
          {daysInPhase}d
        </td>
        <td style={td}>{lastActivityText}</td>
        <td style={{ ...td, color: '#475569' }}>{lastEventText}</td>
        <td style={td}>
          {suggestion ? (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              style={{
                padding: '3px 10px', borderRadius: 12,
                border: '1px solid #CBD5E1', background: '#F8FAFC',
                color: '#475569', fontSize: 11, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
              title="Show the AI's reasoning"
            >
              {ACTION_LABELS[suggestion.action_type] || suggestion.action_type}
              <span style={{ marginLeft: 6, color: '#94A3B8' }}>
                {expanded ? '▾' : '▸'}
              </span>
            </button>
          ) : (
            <span style={{ color: '#CBD5E1' }}>—</span>
          )}
        </td>
      </tr>
      {expanded && suggestion && (
        <tr style={{ background: '#FAFBFC' }}>
          <td colSpan={5} style={{ ...td, ...(isLast ? { borderBottom: 'none' } : {}), padding: '10px 16px' }}>
            <div style={{ fontSize: 12, color: '#4A5568' }}>
              <strong style={{ color: '#1F2937' }}>{suggestion.title || 'AI suggestion'}</strong>
              {suggestion.detail && (
                <div style={{ marginTop: 4 }}>{suggestion.detail}</div>
              )}
              {suggestion.drafted_content && (
                <div style={{ marginTop: 6, padding: '6px 10px', background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 6, fontFamily: 'monospace', fontSize: 11 }}>
                  {suggestion.drafted_content}
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: 11, color: '#94A3B8' }}>
                Action through the caregiver's profile — the AI's loop closes automatically when you do.
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
