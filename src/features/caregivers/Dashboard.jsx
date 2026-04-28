import { useState, useEffect, useRef } from 'react';
import { PHASES, DEFAULT_BOARD_COLUMNS } from '../../lib/constants';
import { getCurrentPhase, getOverallProgress, getDaysSinceApplication, isGreenLight, getPhaseProgress, sortCaregiversForDashboard, isAwaitingInterviewResponse, getDaysSinceInterviewLinkSent, isAwaitingHcaVerification, getDaysSinceInterviewEvaluation } from '../../lib/utils';
import { generateActionItems } from '../../lib/actionItemEngine';
import { loadBoardColumns } from '../../lib/storage';
import { exportToCSV } from '../../lib/export';
import { supabase } from '../../lib/supabase';
import { resolveCaregiverMergeFields, normalizePhone } from '../../lib/mergeFields';
import { OrientationBanner } from './KanbanBoard';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import progress from '../../styles/progress.module.css';
import layout from '../../styles/layout.module.css';
import d from './Dashboard.module.css';
import { AIPrioritiesPanel } from './AIPrioritiesPanel';
import { useCommunicationRoutes } from '../../shared/hooks/useCommunicationRoutes';
import { RouteSelectorChip, RouteSummaryLine } from '../../shared/components/RouteSelectorChip';

// ─── EXPORT BUTTON ───────────────────────────────────────────
function ExportButton({ filterPhase, filteredCount, totalCount, onExportFiltered, onExportAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={btn.exportBtn}
        onClick={() => setOpen(!open)}
      >
        📥 Export
      </button>
      {open && (
        <div className={layout.exportDropdown}>
          <div className={layout.exportDropdownTitle}>Export to Excel</div>
          {filterPhase !== 'all' && (
            <button
              className={layout.exportDropdownItem}
              onClick={() => { onExportFiltered(); setOpen(false); }}
            >
              <div className={layout.exportItemLabel}>
                📋 Current View ({filteredCount})
              </div>
              <div className={layout.exportItemDesc}>
                {filterPhase === 'intake_pending'
                  ? 'Pending Interview caregivers only'
                  : filterPhase === 'interview_pending_hca'
                  ? 'Pending HCA caregivers only'
                  : `${PHASES.find((p) => p.id === filterPhase)?.label} caregivers only`}
              </div>
            </button>
          )}
          <button
            className={layout.exportDropdownItem}
            onClick={() => { onExportAll(); setOpen(false); }}
          >
            <div className={layout.exportItemLabel}>
              👥 All Caregivers ({totalCount})
            </div>
            <div className={layout.exportItemDesc}>
              Full pipeline with task detail, notes & summary
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── STAT CARD ───────────────────────────────────────────────
function StatCard({ label, value, accent, icon }) {
  return (
    <div className={cards.statCard}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 24 }}>{icon}</span>
        <span className={cards.statValue} style={{ color: accent }}>{value}</span>
      </div>
      <div className={cards.statLabel}>{label}</div>
    </div>
  );
}

// ─── CAREGIVER CARD ──────────────────────────────────────────
function CaregiverCard({ caregiver, onClick, isSelected, onToggleSelect, selectionMode, surveyStatus, urgent }) {
  const phase = getCurrentPhase(caregiver);
  const phaseInfo = PHASES.find((p) => p.id === phase);
  const progressPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const greenLight = isGreenLight(caregiver);
  const awaitingInterview = isAwaitingInterviewResponse(caregiver);
  const linkDaysAgo = awaitingInterview ? getDaysSinceInterviewLinkSent(caregiver) : null;
  const linkAgoLabel = linkDaysAgo == null ? '' : linkDaysAgo === 0 ? 'today' : `${linkDaysAgo}d ago`;
  const awaitingHca = isAwaitingHcaVerification(caregiver);
  const evalDaysAgo = awaitingHca ? getDaysSinceInterviewEvaluation(caregiver) : null;
  const evalAgoLabel = evalDaysAgo == null ? '' : evalDaysAgo === 0 ? 'today' : `${evalDaysAgo}d ago`;

  return (
    <button
      className={`${cards.cgCard} ${urgent ? cards.cgCardUrgent : ''} ${isSelected ? d.cgCardSelected : ''}`}
      onClick={onClick}
    >
      {/* Selection checkbox */}
      <div
        className={`${d.cardCheckbox} ${isSelected ? d.cardCheckboxChecked : ''} ${selectionMode ? d.cardCheckboxVisible : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      >
        {isSelected && '✓'}
      </div>

      <div className={cards.cgCardHeader}>
        <div className={cards.cgAvatar}>
          {caregiver.firstName?.[0]}
          {caregiver.lastName?.[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div className={cards.cgName}>
            {caregiver.firstName} {caregiver.lastName}
          </div>
          <div className={cards.cgMeta}>
            {caregiver.phone || 'No phone'} {caregiver.perId ? `· PER ${caregiver.perId}` : ''}
          </div>
        </div>
        {greenLight && <span className={progress.greenLightBadge}>🟢 Green Light</span>}
        {urgent && !greenLight && <span className={progress.urgentBadge}>⚠️ Attention</span>}
        {surveyStatus === 'disqualified' && (
          <span style={{
            background: 'linear-gradient(135deg, #FEF2F2, #FEE2E2)', color: '#DC2626',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #FECACA',
          }}>
            🚫 Disqualified
          </span>
        )}
        {surveyStatus === 'flagged' && (
          <span style={{
            background: 'linear-gradient(135deg, #FFFBEB, #FEF3C7)', color: '#A16207',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #FDE68A',
          }}>
            ⚠️ Flagged
          </span>
        )}
        {surveyStatus === 'qualified' && phase === 'intake' && (
          <span style={{
            background: 'linear-gradient(135deg, #F0FDF4, #DCFCE7)', color: '#15803D',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #BBF7D0',
          }}>
            ✅ Passed Screening
          </span>
        )}
      </div>

      <div className={cards.cgPhaseRow}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            className={progress.phaseBadge}
            style={{
              background: `${phaseInfo.color}18`,
              color: phaseInfo.color,
              border: `1px solid ${phaseInfo.color}30`,
            }}
          >
            {phaseInfo.icon} {phaseInfo.short}
          </span>
          {awaitingInterview && (
            <span
              style={{
                background: '#FFF8ED',
                color: '#A16207',
                border: '1px solid #FDE68A',
                padding: '2px 8px',
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
              title="Interview link sent, awaiting response"
            >
              ⏳ Link sent{linkAgoLabel ? ` · ${linkAgoLabel}` : ''}
            </span>
          )}
          {awaitingHca && (
            <span
              style={{
                background: '#FFF8ED',
                color: '#A16207',
                border: '1px solid #FDE68A',
                padding: '2px 8px',
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
              title="Interview evaluation complete, awaiting HCA verification"
            >
              ⏳ Pending HCA{evalAgoLabel ? ` · ${evalAgoLabel}` : ''}
            </span>
          )}
        </span>
        <span className={cards.cgDays}>Day {days}</span>
      </div>

      {/* Mini Progress */}
      <div className={progress.miniProgressTrack}>
        {PHASES.map((p) => {
          const { pct } = getPhaseProgress(caregiver, p.id);
          return (
            <div key={p.id} className={progress.miniSegment}>
              <div
                className={progress.miniSegmentFill}
                style={{
                  width: `${pct}%`,
                  background: p.color,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className={progress.miniProgressLabel}>{progressPct}% complete</div>
    </button>
  );
}

// ─── CAREGIVER LIST ROW ──────────────────────────────────────
// Compact alternative to CaregiverCard. Renders one caregiver as a table row
// with the same data the card surfaces (phase, screening, link-sent, day,
// progress) so the screening-survey tags remain visible in either view.
function CaregiverListRow({ caregiver, isSelected, onToggleSelect, onSelect, surveyStatus, urgent }) {
  const phase = getCurrentPhase(caregiver);
  const phaseInfo = PHASES.find((p) => p.id === phase);
  const progressPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const awaitingInterview = isAwaitingInterviewResponse(caregiver);
  const linkDaysAgo = awaitingInterview ? getDaysSinceInterviewLinkSent(caregiver) : null;
  const linkAgoLabel = linkDaysAgo == null ? '' : linkDaysAgo === 0 ? 'today' : `${linkDaysAgo}d ago`;
  const awaitingHca = isAwaitingHcaVerification(caregiver);
  const evalDaysAgo = awaitingHca ? getDaysSinceInterviewEvaluation(caregiver) : null;
  const evalAgoLabel = evalDaysAgo == null ? '' : evalDaysAgo === 0 ? 'today' : `${evalDaysAgo}d ago`;
  const greenLight = isGreenLight(caregiver);

  return (
    <tr
      onClick={onSelect}
      style={{
        borderBottom: '1px solid #F3F4F6',
        transition: 'background 0.1s',
        background: isSelected ? '#F0F4FA' : 'transparent',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#F9FAFB'; }}
      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
    >
      <td
        style={{ padding: '12px 8px', textAlign: 'center' }}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          readOnly
          style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
        />
      </td>
      <td style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #2E4E8D, #1084C3)',
            color: '#fff', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: 700, fontSize: 12,
            flexShrink: 0,
          }}>
            {caregiver.firstName?.[0]}{caregiver.lastName?.[0]}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, color: '#0F1724', fontSize: 14 }}>
                {caregiver.firstName} {caregiver.lastName}
              </span>
              {greenLight && (
                <span style={{
                  background: '#DCFCE7', color: '#15803D',
                  padding: '1px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}>Green Light</span>
              )}
              {urgent && !greenLight && (
                <span style={{
                  background: '#FEF2F0', color: '#DC3545',
                  padding: '1px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}>Attention</span>
              )}
            </div>
            {caregiver.perId && (
              <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }}>PER {caregiver.perId}</div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding: '12px 16px', color: '#374151', fontWeight: 500, whiteSpace: 'nowrap' }}>
        {caregiver.phone || '—'}
      </td>
      <td style={{ padding: '12px 16px' }}>
        <span
          className={progress.phaseBadge}
          style={{
            background: `${phaseInfo.color}18`,
            color: phaseInfo.color,
            border: `1px solid ${phaseInfo.color}30`,
          }}
        >
          {phaseInfo.icon} {phaseInfo.short}
        </span>
      </td>
      <td style={{ padding: '12px 16px' }}>
        {surveyStatus === 'disqualified' && (
          <span style={{
            background: 'linear-gradient(135deg, #FEF2F2, #FEE2E2)', color: '#DC2626',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #FECACA',
          }}>🚫 Disqualified</span>
        )}
        {surveyStatus === 'flagged' && (
          <span style={{
            background: 'linear-gradient(135deg, #FFFBEB, #FEF3C7)', color: '#A16207',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #FDE68A',
          }}>⚠️ Flagged</span>
        )}
        {surveyStatus === 'qualified' && phase === 'intake' && (
          <span style={{
            background: 'linear-gradient(135deg, #F0FDF4, #DCFCE7)', color: '#15803D',
            padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
            whiteSpace: 'nowrap', border: '1px solid #BBF7D0',
          }}>✅ Passed Screening</span>
        )}
        {!surveyStatus && <span style={{ color: '#9CA3AF' }}>—</span>}
        {surveyStatus === 'qualified' && phase !== 'intake' && (
          <span style={{ color: '#9CA3AF' }}>—</span>
        )}
      </td>
      <td style={{ padding: '12px 16px' }}>
        {awaitingInterview ? (
          <span style={{
            background: '#FFF8ED', color: '#A16207',
            border: '1px solid #FDE68A', padding: '2px 8px',
            borderRadius: 8, fontSize: 11, fontWeight: 600,
            whiteSpace: 'nowrap',
          }} title="Interview link sent, awaiting response">
            ⏳ {linkAgoLabel}
          </span>
        ) : awaitingHca ? (
          <span style={{
            background: '#FFF8ED', color: '#A16207',
            border: '1px solid #FDE68A', padding: '2px 8px',
            borderRadius: 8, fontSize: 11, fontWeight: 600,
            whiteSpace: 'nowrap',
          }} title="Interview evaluation complete, awaiting HCA verification">
            ⏳ Pending HCA{evalAgoLabel ? ` · ${evalAgoLabel}` : ''}
          </span>
        ) : <span style={{ color: '#9CA3AF' }}>—</span>}
      </td>
      <td style={{ padding: '12px 16px', color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>
        Day {days}
      </td>
      <td style={{ padding: '12px 16px', minWidth: 140 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 6, background: '#F3F4F6', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'linear-gradient(90deg, #29BEE4, #1084C3)',
            }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', minWidth: 32, textAlign: 'right' }}>
            {progressPct}%
          </span>
        </div>
      </td>
    </tr>
  );
}

// ─── VIEW MODE TOGGLE ────────────────────────────────────────
function ViewModeToggle({ value, onChange }) {
  const baseBtn = {
    background: 'transparent',
    color: '#6B7280',
    border: 'none',
    padding: '9px 14px',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    transition: 'background 0.1s, color 0.1s',
  };
  const activeBtn = {
    ...baseBtn,
    background: '#2E4E8D',
    color: '#fff',
  };

  return (
    <div style={{
      display: 'inline-flex',
      background: '#fff',
      border: '1px solid rgba(0,0,0,0.08)',
      borderRadius: 14,
      padding: 4,
      gap: 2,
      boxShadow: '0 1px 4px rgba(0,0,0,0.03)',
    }}>
      <button
        type="button"
        onClick={() => onChange('grid')}
        style={value === 'grid' ? activeBtn : baseBtn}
        aria-pressed={value === 'grid'}
        aria-label="Card view"
        title="Card view"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <rect x="0" y="0" width="6" height="6" rx="1" />
          <rect x="8" y="0" width="6" height="6" rx="1" />
          <rect x="0" y="8" width="6" height="6" rx="1" />
          <rect x="8" y="8" width="6" height="6" rx="1" />
        </svg>
        Cards
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        style={value === 'list' ? activeBtn : baseBtn}
        aria-pressed={value === 'list'}
        aria-label="List view"
        title="List view"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <rect x="0" y="1" width="14" height="2" rx="0.5" />
          <rect x="0" y="6" width="14" height="2" rx="0.5" />
          <rect x="0" y="11" width="14" height="2" rx="0.5" />
        </svg>
        List
      </button>
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────
export function Dashboard({
  caregivers, allCaregivers, filterPhase, searchTerm, setSearchTerm,
  onSelect, onAdd, onImportIndeed, onBulkPhaseOverride, onBulkAddNote, onBulkBoardStatus,
  onBulkArchive, onBulkSms, showToast, sidebarWidth,
}) {
  const [viewMode, setViewMode] = useState(() => {
    const stored = localStorage.getItem('tc_dashboard_view_mode');
    return stored === 'list' ? 'list' : 'grid';
  });

  const handleViewModeChange = (mode) => {
    setViewMode(mode);
    localStorage.setItem('tc_dashboard_view_mode', mode);
  };

  const [showAllActions, setShowAllActions] = useState(false);
  const [actionsCollapsed, setActionsCollapsed] = useState(() => localStorage.getItem('tc_actions_collapsed') === 'true');
  const [dismissedActionKeys, setDismissedActionKeys] = useState(() => {
    try {
      const raw = localStorage.getItem('tc_actions_dismissed');
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      const today = new Date().toISOString().slice(0, 10);
      if (parsed?.date !== today || !Array.isArray(parsed?.keys)) return new Set();
      return new Set(parsed.keys);
    } catch {
      return new Set();
    }
  });

  const persistDismissed = (keys) => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('tc_actions_dismissed', JSON.stringify({ date: today, keys: [...keys] }));
  };

  const actionItemKey = (item) =>
    `${item.cgId || item.entityId || ''}::${item.ruleId || item.title || ''}`;

  const dismissActionItem = (item) => {
    const key = actionItemKey(item);
    setDismissedActionKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      persistDismissed(next);
      return next;
    });
  };

  const clearAllActionItems = (items) => {
    setDismissedActionKeys((prev) => {
      const next = new Set(prev);
      for (const it of items) next.add(actionItemKey(it));
      persistDismissed(next);
      return next;
    });
    setShowAllActions(false);
  };
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null); // "phase" | "note" | "board" | "archive" | "sms"
  const [bulkNoteText, setBulkNoteText] = useState('');
  const [boardColumns, setBoardColumns] = useState(DEFAULT_BOARD_COLUMNS);

  // SMS bulk state
  const [bulkSmsText, setBulkSmsText] = useState('');
  const [smsTemplates, setSmsTemplates] = useState([]);
  const [selectedSmsTemplate, setSelectedSmsTemplate] = useState('');
  const [smsSendStep, setSmsSendStep] = useState('compose'); // 'compose' | 'confirm'
  const [isSending, setIsSending] = useState(false);

  // Communication route selection for bulk SMS. The chip is only rendered
  // when ≥2 routes are configured; otherwise the send falls through to the
  // legacy env-var path in the bulk-sms Edge Function.
  const { routes, showSelector: showRouteSelector, smartDefaultCategoryFor, isRouteConfigured } = useCommunicationRoutes();
  const [smsCategory, setSmsCategory] = useState(null); // null = not yet seeded
  const [smsCategoryTouched, setSmsCategoryTouched] = useState(false);

  // Load survey statuses for all caregivers (for badge display)
  const [surveyStatuses, setSurveyStatuses] = useState({});
  useEffect(() => {
    if (!supabase) return;
    // Exclude internal-only templates (e.g. Interview Evaluation) — those
    // shouldn't drive the pre-screening status badge on caregiver cards.
    supabase
      .from('survey_responses')
      .select('caregiver_id, status, survey_templates!inner(internal_only)')
      .in('status', ['flagged', 'disqualified', 'qualified'])
      .or('internal_only.is.null,internal_only.eq.false', { foreignTable: 'survey_templates' })
      .then(({ data }) => {
        if (!data) return;
        const PRIORITY = { disqualified: 3, flagged: 2, qualified: 1 };
        const map = {};
        for (const r of data) {
          const existing = map[r.caregiver_id];
          if (!existing || PRIORITY[r.status] > PRIORITY[existing]) {
            map[r.caregiver_id] = r.status;
          }
        }
        setSurveyStatuses(map);
      });
  }, []);

  // Load board columns for bulk board assignment
  useEffect(() => {
    loadBoardColumns().then(setBoardColumns);
  }, []);

  // Load SMS templates
  useEffect(() => {
    if (!supabase) return;
    supabase.from('app_settings').select('value').eq('key', 'sms_templates').single()
      .then(({ data }) => {
        if (data?.value) {
          const parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          setSmsTemplates(Array.isArray(parsed) ? parsed : []);
        }
      })
      .catch(() => {});
  }, []);

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkAction(null);
  }, [filterPhase, searchTerm]);

  const totalActive = allCaregivers.length;
  const greenLightCount = allCaregivers.filter(isGreenLight).length;
  const avgProgress = totalActive
    ? Math.round(allCaregivers.reduce((s, c) => s + getOverallProgress(c), 0) / totalActive)
    : 0;

  const allActionItems = generateActionItems(allCaregivers);
  const actionItems = allActionItems.filter((it) => !dismissedActionKeys.has(actionItemKey(it)));
  const visibleActions = showAllActions ? actionItems : actionItems.slice(0, 5);

  // Card urgency is derived from the same rules engine that drives the
  // Today's Action Items panel. A card is urgent if the caregiver has any
  // active critical or warning action item. Dismissals are intentionally
  // ignored — dismissing today's notification does not mean the underlying
  // problem is resolved.
  const urgentCaregiverIds = new Set(
    allActionItems
      .filter((it) => it.urgency === 'critical' || it.urgency === 'warning')
      .map((it) => it.cgId)
      .filter(Boolean)
  );

  const selectionMode = selectedIds.size > 0;
  const sortedCaregivers = sortCaregiversForDashboard(caregivers, surveyStatuses);

  // Seed the SMS category smart default as selection changes, but only until
  // the user explicitly picks a route via the chip (then their choice sticks).
  useEffect(() => {
    if (smsCategoryTouched) return;
    if (!showRouteSelector) return;
    const selectedCgs = sortedCaregivers.filter((cg) => selectedIds.has(cg.id));
    const next = smartDefaultCategoryFor(selectedCgs);
    if (next && next !== smsCategory) setSmsCategory(next);
  }, [selectedIds, sortedCaregivers, smartDefaultCategoryFor, showRouteSelector, smsCategoryTouched, smsCategory]);

  // Reset the user's explicit-pick flag when they close the SMS panel so the
  // next time they open it, the smart default re-applies fresh.
  useEffect(() => {
    if (smsSendStep === 'compose' && selectedIds.size === 0) {
      setSmsCategoryTouched(false);
    }
  }, [smsSendStep, selectedIds.size]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(sortedCaregivers.map((cg) => cg.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkAction(null);
    setBulkNoteText('');
    setBulkSmsText('');
    setSelectedSmsTemplate('');
    setSmsSendStep('compose');
  };

  const executeBulkAction = (action, value) => {
    const ids = [...selectedIds];
    if (action === 'phase') onBulkPhaseOverride(ids, value);
    if (action === 'note') { onBulkAddNote(ids, value); setBulkNoteText(''); }
    if (action === 'board') onBulkBoardStatus(ids, value);
    if (action === 'archive') onBulkArchive(ids, value);
    clearSelection();
  };

  return (
    <div>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Dashboard</h1>
          <p className={layout.pageSubtitle}>
            {filterPhase === 'archived'
              ? 'Showing: Archived caregivers'
              : filterPhase === 'intake_pending'
              ? 'Showing: Pending Interview — link sent, awaiting response'
              : filterPhase === 'interview_pending_hca'
              ? 'Showing: Pending HCA — interview evaluation complete, awaiting HCA verification'
              : filterPhase !== 'all'
              ? `Showing: ${PHASES.find((p) => p.id === filterPhase)?.label}`
              : 'All active caregivers in the pipeline'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ExportButton
            filterPhase={filterPhase}
            filteredCount={sortedCaregivers.length}
            totalCount={allCaregivers.length}
            onExportFiltered={() => exportToCSV(sortedCaregivers, filterPhase)}
            onExportAll={() => exportToCSV(allCaregivers, 'all')}
          />
          <button className={btn.secondaryBtn} onClick={onImportIndeed}>
            Import Indeed CSV
          </button>
          <button className={btn.primaryBtn} onClick={onAdd}>
            ＋ New Caregiver
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className={cards.statsRow}>
        {[
          { label: 'Active Pipeline', value: totalActive, accent: '#2E4E8D', icon: '👥' },
          { label: 'Action Items', value: actionItems.length, accent: '#E85D4A', icon: '🔔' },
          { label: 'Green Light Ready', value: greenLightCount, accent: '#29BEE4', icon: '🟢' },
          { label: 'Avg. Progress', value: `${avgProgress}%`, accent: '#1084C3', icon: '📊' },
        ].map((s, i) => (
          <div key={s.label} style={{ animation: `fadeInUp 0.4s cubic-bezier(0.4,0,0.2,1) ${i * 0.07}s both` }}>
            <StatCard {...s} />
          </div>
        ))}
      </div>

      {/* AI Priorities */}
      <AIPrioritiesPanel caregivers={allCaregivers} onSelect={onSelect} />

      {/* Action Items */}
      {actionItems.length > 0 && (
        <div className={d.panel}>
          <div
            className={d.panelHeader}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { const next = !actionsCollapsed; setActionsCollapsed(next); localStorage.setItem('tc_actions_collapsed', String(next)); }}
          >
            <div className={d.panelTitleRow}>
              <span className={d.panelIcon}>🔔</span>
              <h3 className={d.panelTitle}>Today's Action Items</h3>
              <span className={d.panelCount}>{actionItems.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className={d.panelBadges}>
                {actionItems.filter((a) => a.urgency === 'critical').length > 0 && (
                  <span className={d.criticalCount}>
                    {actionItems.filter((a) => a.urgency === 'critical').length} critical
                  </span>
                )}
                {actionItems.filter((a) => a.urgency === 'warning').length > 0 && (
                  <span className={d.warningCount}>
                    {actionItems.filter((a) => a.urgency === 'warning').length} warning
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (actionItems.length === 0) return;
                  if (window.confirm(`Clear all ${actionItems.length} action item${actionItems.length === 1 ? '' : 's'} for today? They will return tomorrow if still applicable.`)) {
                    clearAllActionItems(actionItems);
                  }
                }}
                disabled={actionItems.length === 0}
                title="Clear all action items for today"
                style={{
                  background: 'transparent',
                  border: '1px solid #E2E8F0',
                  color: actionItems.length === 0 ? '#B0BAC8' : '#4A5568',
                  padding: '4px 10px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: actionItems.length === 0 ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Clear all
              </button>
              <span style={{
                fontSize: 18,
                color: '#7A8BA0',
                transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
                transform: actionsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                display: 'inline-block',
                lineHeight: 1,
              }}>
                ▾
              </span>
            </div>
          </div>
          {!actionsCollapsed && (
            <>
              <div className={d.list}>
                {visibleActions.map((item, i) => (
                  <div
                    key={i}
                    className={d.item}
                    style={{
                      borderLeftColor:
                        item.urgency === 'critical' ? '#DC3545' :
                        item.urgency === 'warning' ? '#D97706' : '#1084C3',
                      animation: `slideInLeft 0.3s cubic-bezier(0.4,0,0.2,1) ${i * 0.05}s both`,
                    }}
                    onClick={() => onSelect(item.cgId)}
                  >
                    <div className={d.itemTop}>
                      <span className={d.itemIcon}>{item.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div className={d.itemTitle}>{item.title}</div>
                        <div className={d.itemName}>{item.name}</div>
                      </div>
                      <span
                        className={d.urgencyBadge}
                        style={{
                          background:
                            item.urgency === 'critical' ? '#FEF2F0' :
                            item.urgency === 'warning' ? '#FFF8ED' : '#EBF5FB',
                          color:
                            item.urgency === 'critical' ? '#DC3545' :
                            item.urgency === 'warning' ? '#D97706' : '#1084C3',
                        }}
                      >
                        {item.urgency === 'critical' ? 'Urgent' : item.urgency === 'warning' ? 'Attention' : 'Info'}
                      </span>
                      <button
                        type="button"
                        aria-label="Dismiss action item"
                        title="Dismiss for today"
                        onClick={(e) => { e.stopPropagation(); dismissActionItem(item); }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#7A8BA0',
                          fontSize: 16,
                          lineHeight: 1,
                          cursor: 'pointer',
                          padding: '4px 6px',
                          borderRadius: 4,
                          marginLeft: 4,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    <div className={d.itemDetail}>{item.detail}</div>
                    <div className={d.itemAction}>→ {item.action}</div>
                  </div>
                ))}
              </div>
              {actionItems.length > 5 && (
                <button
                  className={d.showMore}
                  onClick={(e) => { e.stopPropagation(); setShowAllActions(!showAllActions); }}
                >
                  {showAllActions ? 'Show less' : `Show all ${actionItems.length} items`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Orientation Banner — shown when viewing orientation phase */}
      {filterPhase === 'orientation' && (
        <div style={{ marginBottom: 24 }}>
          <OrientationBanner caregivers={allCaregivers} />
        </div>
      )}

      {/* Search + View Toggle */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginBottom: 20, flexWrap: 'wrap' }}>
        <div className={forms.searchBar} style={{ flex: '1 1 320px', marginBottom: 0 }}>
          <span className={forms.searchIcon}>🔍</span>
          <input
            className={forms.searchInput}
            placeholder="Search by name, phone, or PER ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className={forms.clearSearch} onClick={() => setSearchTerm('')}>
              ✕
            </button>
          )}
        </div>
        <ViewModeToggle value={viewMode} onChange={handleViewModeChange} />
      </div>

      {/* Caregiver Cards */}
      {sortedCaregivers.length === 0 ? (
        <div className={layout.emptyState}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F1724', margin: '0 0 8px' }}>
            {searchTerm ? 'No matches found' : 'No caregivers yet'}
          </h3>
          <p style={{ fontSize: 14, color: '#7A8BA0', margin: 0 }}>
            {searchTerm
              ? 'Try adjusting your search or clearing the filter.'
              : 'Click "New Caregiver" to begin building your pipeline.'}
          </p>
        </div>
      ) : (
        <>
          {/* Selection Controls */}
          <div className={d.selectionBar}>
            <div className={d.selectionLeft}>
              {selectionMode ? (
                <>
                  <span className={d.selectionCount}>
                    {selectedIds.size} selected
                  </span>
                  {selectedIds.size < sortedCaregivers.length && (
                    <button className={d.selectAllLink} onClick={selectAll}>
                      Select all {sortedCaregivers.length}
                    </button>
                  )}
                  <button className={d.clearLink} onClick={clearSelection}>
                    Clear
                  </button>
                </>
              ) : (
                <span className={d.selectHint}>
                  Click checkboxes to select caregivers for bulk actions
                </span>
              )}
            </div>
          </div>

          {viewMode === 'grid' ? (
            <div className={cards.cardGrid}>
              {sortedCaregivers.map((cg, idx) => (
                <div key={cg.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
                  <CaregiverCard
                    caregiver={cg}
                    onClick={() => onSelect(cg.id)}
                    isSelected={selectedIds.has(cg.id)}
                    onToggleSelect={() => toggleSelect(cg.id)}
                    selectionMode={selectionMode}
                    surveyStatus={surveyStatuses[cg.id]}
                    urgent={urgentCaregiverIds.has(cg.id)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div style={{
              background: '#fff', borderRadius: 16, border: '1px solid rgba(0,0,0,0.06)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.03)', overflow: 'auto',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#F9FAFB', borderBottom: '1px solid #E5E7EB' }}>
                    <th style={{
                      padding: '12px 8px', width: 44, textAlign: 'center',
                      fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                      letterSpacing: '0.8px', color: '#6B7280',
                    }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.size === sortedCaregivers.length && sortedCaregivers.length > 0}
                        onChange={() => {
                          if (selectedIds.size === sortedCaregivers.length) clearSelection();
                          else selectAll();
                        }}
                        style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
                      />
                    </th>
                    {['Name', 'Phone', 'Phase', 'Screening', 'Link Sent', 'Day', 'Progress'].map((h) => (
                      <th key={h} style={{
                        padding: '12px 16px', textAlign: 'left', fontWeight: 700,
                        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px',
                        color: '#6B7280',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedCaregivers.map((cg) => (
                    <CaregiverListRow
                      key={cg.id}
                      caregiver={cg}
                      isSelected={selectedIds.has(cg.id)}
                      onToggleSelect={() => toggleSelect(cg.id)}
                      onSelect={() => onSelect(cg.id)}
                      surveyStatus={surveyStatuses[cg.id]}
                      urgent={urgentCaregiverIds.has(cg.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Bulk Action Bar — fixed at bottom when items are selected */}
      {selectionMode && (
        <div className={`tc-bulk-bar ${d.actionBar}`} style={{ left: sidebarWidth || 260 }}>
          <div className={d.actionBarInner}>
            <div className={d.actionBarLeft}>
              <span className={d.actionBarCount}>
                {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
            </div>

            <div className={d.actionBarActions}>
              {/* Set Phase */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'phase' ? d.actionBtnActive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'phase' ? null : 'phase')}
                >
                  📋 Set Phase
                </button>
                {bulkAction === 'phase' && (
                  <div className={d.actionDropdown}>
                    <button
                      className={d.dropdownItem}
                      onClick={() => executeBulkAction('phase', '')}
                    >
                      🔄 Auto (clear override)
                    </button>
                    {PHASES.map((p) => (
                      <button
                        key={p.id}
                        className={d.dropdownItem}
                        onClick={() => executeBulkAction('phase', p.id)}
                      >
                        {p.icon} {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Note */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'note' ? d.actionBtnActive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'note' ? null : 'note')}
                >
                  📝 Add Note
                </button>
                {bulkAction === 'note' && (
                  <div className={`${d.actionDropdown} ${d.actionDropdownWide}`}>
                    <input
                      className={d.dropdownInput}
                      placeholder="Note for all selected caregivers..."
                      value={bulkNoteText}
                      onChange={(e) => setBulkNoteText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && bulkNoteText.trim()) {
                          executeBulkAction('note', bulkNoteText.trim());
                        }
                      }}
                      autoFocus
                    />
                    <button
                      className={d.dropdownApply}
                      onClick={() => {
                        if (bulkNoteText.trim()) executeBulkAction('note', bulkNoteText.trim());
                      }}
                    >
                      Add to {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''}
                    </button>
                  </div>
                )}
              </div>

              {/* Move to Board */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'board' ? d.actionBtnActive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'board' ? null : 'board')}
                >
                  ▤ Board Column
                </button>
                {bulkAction === 'board' && (
                  <div className={d.actionDropdown}>
                    {boardColumns.map((col) => (
                      <button
                        key={col.id}
                        className={d.dropdownItem}
                        onClick={() => executeBulkAction('board', col.id)}
                      >
                        {col.icon} {col.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Send SMS */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'sms' ? d.actionBtnActive : ''}`}
                  onClick={() => { setBulkAction(bulkAction === 'sms' ? null : 'sms'); setSmsSendStep('compose'); }}
                >
                  💬 Send SMS
                </button>
                {bulkAction === 'sms' && (() => {
                  const selectedCgs = sortedCaregivers.filter((cg) => selectedIds.has(cg.id));
                  const withPhone = selectedCgs.filter((cg) => normalizePhone(cg.phone) !== null);
                  const withoutPhone = selectedCgs.length - withPhone.length;

                  const selectedRoute = showRouteSelector
                    ? routes.find((r) => r.category === smsCategory) || null
                    : null;

                  if (smsSendStep === 'confirm') {
                    const previewCg = withPhone[0];
                    const previewText = previewCg ? resolveCaregiverMergeFields(bulkSmsText, previewCg) : bulkSmsText;
                    return (
                      <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                        <div className={d.confirmPanel}>
                          <div className={d.confirmSummary}>
                            Send SMS to <strong>{withPhone.length}</strong> caregiver{withPhone.length !== 1 ? 's' : ''} with valid phone numbers
                          </div>
                          {withoutPhone > 0 && (
                            <div className={d.confirmSkipped}>
                              {withoutPhone} will be skipped (no phone number)
                            </div>
                          )}
                          {showRouteSelector && <RouteSummaryLine route={selectedRoute} />}
                          <div className={d.confirmPreviewLabel}>Preview ({previewCg ? `${previewCg.firstName} ${previewCg.lastName}` : ''})</div>
                          <div className={d.confirmPreviewBox}>{previewText}</div>
                          <div className={d.composeActions}>
                            <button className={d.backBtn} onClick={() => setSmsSendStep('compose')}>← Back</button>
                            <button
                              className={d.sendBtn}
                              disabled={isSending || withPhone.length === 0}
                              onClick={async () => {
                                setIsSending(true);
                                try {
                                  const result = await onBulkSms([...selectedIds], bulkSmsText.trim(), showRouteSelector ? smsCategory : undefined);
                                  const { sent = 0, skipped = 0, failed = 0 } = result || {};
                                  let msg = `SMS sent to ${sent} caregiver${sent !== 1 ? 's' : ''}`;
                                  if (skipped > 0) msg += `, ${skipped} skipped`;
                                  if (failed > 0) msg += `, ${failed} failed`;
                                  showToast(msg);
                                  clearSelection();
                                } catch (err) {
                                  showToast(`Failed to send SMS: ${err.message || 'Unknown error'}`);
                                } finally {
                                  setIsSending(false);
                                }
                              }}
                            >
                              {isSending ? 'Sending...' : `Send to ${withPhone.length} caregiver${withPhone.length !== 1 ? 's' : ''}`}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                      <div style={{ padding: '8px 12px 4px', fontSize: 12, color: '#6B7B8F', borderBottom: '1px solid #E5E7EB', marginBottom: 8 }}>
                        Send SMS to {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''}
                      </div>
                      {smsTemplates.length > 0 && (
                        <select
                          className={d.dropdownInput}
                          value={selectedSmsTemplate}
                          onChange={(e) => {
                            setSelectedSmsTemplate(e.target.value);
                            if (e.target.value) {
                              const tpl = smsTemplates.find((t) => t.id === e.target.value);
                              if (tpl) setBulkSmsText(tpl.body);
                            }
                          }}
                          style={{ marginBottom: 8 }}
                        >
                          <option value="">-- Pick a template (optional) --</option>
                          {smsTemplates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      )}
                      <textarea
                        className={d.composeTextarea}
                        placeholder="Type your SMS message... Use {{first_name}}, {{last_name}} for merge fields"
                        value={bulkSmsText}
                        onChange={(e) => setBulkSmsText(e.target.value)}
                        rows={4}
                        autoFocus
                      />
                      <div className={d.mergeFieldsHint}>
                        Merge fields: {'{{first_name}}'}, {'{{last_name}}'}, {'{{phone}}'}, {'{{email}}'}
                      </div>
                      <div className={withPhone.length > 0 ? d.phoneCountLine : `${d.phoneCountLine} ${d.phoneCountWarning}`}>
                        {withPhone.length} of {selectedCgs.length} have a valid phone number
                        {withoutPhone > 0 && ` · ${withoutPhone} will be skipped`}
                      </div>
                      {showRouteSelector && (
                        <RouteSelectorChip
                          routes={routes}
                          isRouteConfigured={isRouteConfigured}
                          value={smsCategory}
                          onChange={(cat) => {
                            setSmsCategory(cat);
                            setSmsCategoryTouched(true);
                          }}
                          disabled={isSending}
                        />
                      )}
                      <div className={d.composeActions}>
                        <button
                          className={d.sendBtn}
                          disabled={!bulkSmsText.trim() || withPhone.length === 0}
                          onClick={() => setSmsSendStep('confirm')}
                        >
                          Review & Send →
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Archive */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'archive' ? d.actionBtnActive : ''} ${bulkAction !== 'archive' ? d.actionBtnArchive : ''}`}
                  onClick={() => setBulkAction(bulkAction === 'archive' ? null : 'archive')}
                >
                  📦 Archive
                </button>
                {bulkAction === 'archive' && (
                  <div className={d.actionDropdown} style={{ minWidth: 240 }}>
                    <div style={{ padding: '8px 12px', fontSize: 12, color: '#6B7B8F', borderBottom: '1px solid #E5E7EB' }}>
                      Archive {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''} as:
                    </div>
                    {[
                      { value: 'ghosted', label: 'Ghosted / No Response' },
                      { value: 'not_qualified', label: 'Did Not Meet Requirements' },
                      { value: 'withdrew', label: 'Candidate Withdrew' },
                      { value: 'no_show', label: 'No-Show' },
                      { value: 'other', label: 'Other' },
                    ].map((r) => (
                      <button
                        key={r.value}
                        className={d.dropdownItem}
                        onClick={() => executeBulkAction('archive', r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      className={d.dropdownCancel}
                      onClick={() => setBulkAction(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            <button className={d.actionBarClose} onClick={clearSelection}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
