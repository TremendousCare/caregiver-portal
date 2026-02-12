import { useState, useEffect, useRef } from 'react';
import { PHASES, DEFAULT_BOARD_COLUMNS } from '../lib/constants';
import { getCurrentPhase, getOverallProgress, getDaysInPhase, getDaysSinceApplication, isGreenLight, getPhaseProgress } from '../lib/utils';
import { generateActionItems } from '../lib/actionEngine';
import { loadBoardColumns } from '../lib/storage';
import { exportToCSV } from '../lib/export';
import { OrientationBanner } from './KanbanBoard';
import { styles, actionStyles, bulkStyles } from '../styles/theme';

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
        className="tc-btn-secondary" style={styles.exportBtn}
        onClick={() => setOpen(!open)}
      >
        📥 Export
      </button>
      {open && (
        <div className="tc-dropdown" style={styles.exportDropdown}>
          <div style={styles.exportDropdownTitle}>Export to Excel</div>
          {filterPhase !== 'all' && (
            <button
              style={styles.exportDropdownItem}
              className="bulk-dropdown-item"
              onClick={() => { onExportFiltered(); setOpen(false); }}
            >
              <div style={styles.exportItemLabel}>
                📋 Current View ({filteredCount})
              </div>
              <div style={styles.exportItemDesc}>
                {PHASES.find((p) => p.id === filterPhase)?.label} caregivers only
              </div>
            </button>
          )}
          <button
            style={styles.exportDropdownItem}
            className="bulk-dropdown-item"
            onClick={() => { onExportAll(); setOpen(false); }}
          >
            <div style={styles.exportItemLabel}>
              👥 All Caregivers ({totalCount})
            </div>
            <div style={styles.exportItemDesc}>
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
    <div className="tc-stat-card" style={styles.statCard}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 24 }}>{icon}</span>
        <span style={{ ...styles.statValue, color: accent }}>{value}</span>
      </div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  );
}

// ─── CAREGIVER CARD ──────────────────────────────────────────
function CaregiverCard({ caregiver, onClick, isSelected, onToggleSelect, selectionMode }) {
  const phase = getCurrentPhase(caregiver);
  const phaseInfo = PHASES.find((p) => p.id === phase);
  const progress = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const daysInPhase = getDaysInPhase(caregiver);
  const urgent = (phase === 'onboarding' && daysInPhase >= 5) || (phase === 'intake' && daysInPhase >= 2);
  const greenLight = isGreenLight(caregiver);

  return (
    <button
      className="cg-card"
      style={{
        ...styles.cgCard,
        ...(urgent ? styles.cgCardUrgent : {}),
        ...(isSelected ? bulkStyles.cgCardSelected : {}),
      }}
      onClick={onClick}
    >
      {/* Selection checkbox */}
      <div
        className="cg-card-checkbox"
        style={{
          ...bulkStyles.cardCheckbox,
          ...(isSelected ? bulkStyles.cardCheckboxChecked : {}),
          ...(selectionMode ? { opacity: 1 } : {}),
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      >
        {isSelected && '✓'}
      </div>

      <div style={styles.cgCardHeader}>
        <div style={styles.cgAvatar}>
          {caregiver.firstName?.[0]}
          {caregiver.lastName?.[0]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={styles.cgName}>
            {caregiver.firstName} {caregiver.lastName}
          </div>
          <div style={styles.cgMeta}>
            {caregiver.phone || 'No phone'} {caregiver.perId ? `· PER ${caregiver.perId}` : ''}
          </div>
        </div>
        {greenLight && <span style={styles.greenLightBadge}>🟢 Green Light</span>}
        {urgent && !greenLight && <span style={styles.urgentBadge}>⚠️ Attention</span>}
      </div>

      <div style={styles.cgPhaseRow}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              ...styles.phaseBadge,
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
        <span style={styles.cgDays}>Day {days}</span>
      </div>

      {/* Mini Progress */}
      <div style={styles.miniProgressTrack}>
        {PHASES.map((p) => {
          const { pct } = getPhaseProgress(caregiver, p.id);
          return (
            <div key={p.id} style={styles.miniSegment}>
              <div
                className="tc-mini-fill"
                style={{
                  ...styles.miniSegmentFill,
                  width: `${pct}%`,
                  background: p.color,
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={styles.miniProgressLabel}>{progress}% complete</div>
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
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Dashboard</h1>
          <p style={styles.pageSubtitle}>
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
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={onAdd}>
            ＋ New Caregiver
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={styles.statsRow}>
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
        <div style={actionStyles.panel}>
          <div
            style={{ ...actionStyles.panelHeader, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { const next = !actionsCollapsed; setActionsCollapsed(next); localStorage.setItem('tc_actions_collapsed', String(next)); }}
          >
            <div style={actionStyles.panelTitleRow}>
              <span style={actionStyles.panelIcon}>🔔</span>
              <h3 style={actionStyles.panelTitle}>Today's Action Items</h3>
              <span style={actionStyles.panelCount}>{actionItems.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={actionStyles.panelBadges}>
                {actionItems.filter((a) => a.urgency === 'critical').length > 0 && (
                  <span style={actionStyles.criticalCount}>
                    {actionItems.filter((a) => a.urgency === 'critical').length} critical
                  </span>
                )}
                {actionItems.filter((a) => a.urgency === 'warning').length > 0 && (
                  <span style={actionStyles.warningCount}>
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
              <div style={actionStyles.list}>
                {visibleActions.map((item, i) => (
                  <div
                    key={i}
                    className="tc-action-item"
                    style={{
                      ...actionStyles.item,
                      borderLeftColor:
                        item.urgency === 'critical' ? '#DC3545' :
                        item.urgency === 'warning' ? '#D97706' : '#1084C3',
                      animation: `slideInLeft 0.3s cubic-bezier(0.4,0,0.2,1) ${i * 0.05}s both`,
                      cursor: 'pointer',
                    }}
                    onClick={() => onSelect(item.cgId)}
                  >
                    <div style={actionStyles.itemTop}>
                      <span style={actionStyles.itemIcon}>{item.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={actionStyles.itemTitle}>{item.title}</div>
                        <div style={actionStyles.itemName}>{item.name}</div>
                      </div>
                      <span
                        style={{
                          ...actionStyles.urgencyBadge,
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
                    <div style={actionStyles.itemDetail}>{item.detail}</div>
                    <div style={actionStyles.itemAction}>→ {item.action}</div>
                  </div>
                ))}
              </div>
              {actionItems.length > 5 && (
                <button
                  style={actionStyles.showMore}
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
      <div className="tc-search" style={styles.searchBar}>
        <span style={styles.searchIcon}>🔍</span>
        <input
          style={styles.searchInput}
          placeholder="Search by name, phone, or PER ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        {searchTerm && (
          <button style={styles.clearSearch} onClick={() => setSearchTerm('')}>
            ✕
          </button>
        )}
      </div>

      {/* Caregiver Cards */}
      {sortedCaregivers.length === 0 ? (
        <div style={styles.emptyState}>
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
          <div style={bulkStyles.selectionBar}>
            <div style={bulkStyles.selectionLeft}>
              {selectionMode ? (
                <>
                  <span style={bulkStyles.selectionCount}>
                    {selectedIds.size} selected
                  </span>
                  {selectedIds.size < sortedCaregivers.length && (
                    <button style={bulkStyles.selectAllLink} onClick={selectAll}>
                      Select all {sortedCaregivers.length}
                    </button>
                  )}
                  <button style={bulkStyles.clearLink} onClick={clearSelection}>
                    Clear
                  </button>
                </>
              ) : (
                <span style={bulkStyles.selectHint}>
                  Click checkboxes to select caregivers for bulk actions
                </span>
              )}
            </div>
          </div>

          <div style={styles.cardGrid}>
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
        <div className="tc-bulk-bar" style={{ ...bulkStyles.actionBar, left: sidebarWidth || 260 }}>
          <div style={bulkStyles.actionBarInner}>
            <div style={bulkStyles.actionBarLeft}>
              <span style={bulkStyles.actionBarCount}>
                {selectedIds.size} caregiver{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
            </div>

            <div style={bulkStyles.actionBarActions}>
              {/* Set Phase */}
              <div style={bulkStyles.actionGroup}>
                <button
                  style={{
                    ...bulkStyles.actionBtn,
                    ...(bulkAction === 'phase' ? bulkStyles.actionBtnActive : {}),
                  }}
                  onClick={() => setBulkAction(bulkAction === 'phase' ? null : 'phase')}
                >
                  📋 Set Phase
                </button>
                {bulkAction === 'phase' && (
                  <div className="tc-dropdown" style={bulkStyles.actionDropdown}>
                    <button
                      className="bulk-dropdown-item" style={bulkStyles.dropdownItem}
                      onClick={() => executeBulkAction('phase', '')}
                    >
                      🔄 Auto (clear override)
                    </button>
                    {PHASES.map((p) => (
                      <button
                        key={p.id}
                        className="bulk-dropdown-item" style={bulkStyles.dropdownItem}
                        onClick={() => executeBulkAction('phase', p.id)}
                      >
                        {p.icon} {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Note */}
              <div style={bulkStyles.actionGroup}>
                <button
                  style={{
                    ...bulkStyles.actionBtn,
                    ...(bulkAction === 'note' ? bulkStyles.actionBtnActive : {}),
                  }}
                  onClick={() => setBulkAction(bulkAction === 'note' ? null : 'note')}
                >
                  📝 Add Note
                </button>
                {bulkAction === 'note' && (
                  <div style={{ ...bulkStyles.actionDropdown, minWidth: 280 }}>
                    <input
                      style={bulkStyles.dropdownInput}
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
                      style={bulkStyles.dropdownApply}
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
              <div style={bulkStyles.actionGroup}>
                <button
                  style={{
                    ...bulkStyles.actionBtn,
                    ...(bulkAction === 'board' ? bulkStyles.actionBtnActive : {}),
                  }}
                  onClick={() => setBulkAction(bulkAction === 'board' ? null : 'board')}
                >
                  ▤ Board Column
                </button>
                {bulkAction === 'board' && (
                  <div className="tc-dropdown" style={bulkStyles.actionDropdown}>
                    {boardColumns.map((col) => (
                      <button
                        key={col.id}
                        className="bulk-dropdown-item" style={bulkStyles.dropdownItem}
                        onClick={() => executeBulkAction('board', col.id)}
                      >
                        {col.icon} {col.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Archive */}
              <div style={bulkStyles.actionGroup}>
                <button
                  style={{
                    ...bulkStyles.actionBtn,
                    ...(bulkAction === 'archive' ? bulkStyles.actionBtnActive : {}),
                    ...(bulkAction !== 'archive' ? { color: '#E85D4A' } : {}),
                  }}
                  onClick={() => setBulkAction(bulkAction === 'archive' ? null : 'archive')}
                >
                  📦 Archive
                </button>
                {bulkAction === 'archive' && (
                  <div className="tc-dropdown" style={{ ...bulkStyles.actionDropdown, minWidth: 240 }}>
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
                        className="bulk-dropdown-item" style={bulkStyles.dropdownItem}
                        onClick={() => executeBulkAction('archive', r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      style={bulkStyles.dropdownCancel}
                      onClick={() => setBulkAction(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            <button style={bulkStyles.actionBarClose} onClick={clearSelection}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
