import { useState, useEffect, useRef } from 'react';
import { PHASES, DEFAULT_BOARD_COLUMNS } from '../../lib/constants';
import { getCurrentPhase, getOverallProgress, getDaysInPhase, getDaysSinceApplication, isGreenLight, getPhaseProgress } from '../../lib/utils';
import { generateActionItems } from '../../lib/actionItemEngine';
import { loadBoardColumns } from '../../lib/storage';
import { exportToCSV } from '../../lib/export';
import { OrientationBanner } from './KanbanBoard';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import progress from '../../styles/progress.module.css';
import layout from '../../styles/layout.module.css';
import d from './Dashboard.module.css';

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
                {PHASES.find((p) => p.id === filterPhase)?.label} caregivers only
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
function CaregiverCard({ caregiver, onClick, isSelected, onToggleSelect, selectionMode }) {
  const phase = getCurrentPhase(caregiver);
  const phaseInfo = PHASES.find((p) => p.id === phase);
  const progressPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const daysInPhase = getDaysInPhase(caregiver);
  const urgent = (phase === 'onboarding' && daysInPhase >= 5) || (phase === 'intake' && daysInPhase >= 2);
  const greenLight = isGreenLight(caregiver);

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
      </div>

      <div className={cards.cgPhaseRow}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
          {caregiver.phaseOverride && (
            <span style={{ fontSize: 11, color: '#D97706', fontWeight: 600 }} title="Phase manually overridden">⚙️</span>
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

// ─── DASHBOARD ───────────────────────────────────────────────
export function Dashboard({
  caregivers, allCaregivers, filterPhase, searchTerm, setSearchTerm,
  onSelect, onAdd, onBulkPhaseOverride, onBulkAddNote, onBulkBoardStatus,
  onBulkArchive, sidebarWidth,
}) {
  const [showAllActions, setShowAllActions] = useState(false);
  const [actionsCollapsed, setActionsCollapsed] = useState(() => localStorage.getItem('tc_actions_collapsed') === 'true');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null); // "phase" | "note" | "board" | "delete"
  const [bulkNoteText, setBulkNoteText] = useState('');
  const [boardColumns, setBoardColumns] = useState(DEFAULT_BOARD_COLUMNS);

  // Load board columns for bulk board assignment
  useEffect(() => {
    loadBoardColumns().then(setBoardColumns);
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

  const actionItems = generateActionItems(allCaregivers);
  const visibleActions = showAllActions ? actionItems : actionItems.slice(0, 5);

  const selectionMode = selectedIds.size > 0;
  const sortedCaregivers = [...caregivers].sort((a, b) => getOverallProgress(b) - getOverallProgress(a));

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

      {/* Search */}
      <div className={forms.searchBar}>
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

          <div className={cards.cardGrid}>
            {sortedCaregivers.map((cg, idx) => (
              <div key={cg.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
                <CaregiverCard
                  caregiver={cg}
                  onClick={() => onSelect(cg.id)}
                  isSelected={selectedIds.has(cg.id)}
                  onToggleSelect={() => toggleSelect(cg.id)}
                  selectionMode={selectionMode}
                />
              </div>
            ))}
          </div>
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
