import { useState, useEffect } from 'react';
import { CLIENT_PHASES, CLIENT_PRIORITIES } from './constants';
import { getClientPhase, getDaysSinceCreated, getNextStep } from './utils';
import { generateClientActionItems } from '../../lib/actionItemEngine';
import { supabase } from '../../lib/supabase';
import { resolveClientMergeFields } from '../../lib/mergeFields';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import progress from '../../styles/progress.module.css';
import layout from '../../styles/layout.module.css';
import d from './ClientDashboard.module.css';
import { Avatar } from '../../shared/components/Avatar';

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

// ─── HELPERS ────────────────────────────────────────────────
function fmtPhone(val) {
  if (!val) return 'No phone';
  const digits = val.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1'))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10)
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return val;
}

// ─── CLIENT LIST ROW ─────────────────────────────────────────
// Compact alternative to ClientCard. Renders one client as a table row
// with the same data the card surfaces (phase, priority, next step, day).
function ClientListRow({ client, overdue, isSelected, onToggleSelect, onSelect }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const days = getDaysSinceCreated(client);
  const nextStep = getNextStep(client);

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
        style={{ padding: '6px 8px', textAlign: 'center' }}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          readOnly
          style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
        />
      </td>
      <td style={{ padding: '6px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #2E4E8D, #1084C3)',
            color: '#fff', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: 700, fontSize: 11,
            flexShrink: 0,
          }}>
            {client.firstName?.[0]}{client.lastName?.[0]}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, color: '#0F1724', fontSize: 14 }}>
                {client.firstName} {client.lastName}
              </span>
              {client.careRecipientName && (
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>
                  · {client.careRecipientName}
                </span>
              )}
              {overdue && (
                <span style={{
                  background: '#FEF2F0', color: '#DC3545',
                  padding: '1px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}>Overdue</span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: '6px 14px', color: '#374151', fontWeight: 500, whiteSpace: 'nowrap' }}>
        {fmtPhone(client.phone)}
      </td>
      <td style={{ padding: '6px 14px' }}>
        {phaseInfo && (
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
        )}
      </td>
      <td style={{ padding: '6px 14px' }}>
        {priorityInfo && priorityInfo.id !== 'normal' ? (
          <span
            className={progress.phaseBadge}
            style={{
              background: `${priorityInfo.color}18`,
              color: priorityInfo.color,
              border: `1px solid ${priorityInfo.color}30`,
            }}
          >
            {priorityInfo.label}
          </span>
        ) : <span style={{ color: '#9CA3AF' }}>—</span>}
      </td>
      <td style={{ padding: '6px 14px', fontSize: 13, color: '#374151' }}>
        {nextStep ? (
          <span style={{ color: nextStep.critical ? '#DC3545' : '#374151' }}>
            {nextStep.critical ? '! ' : '→ '}{nextStep.label}
          </span>
        ) : <span style={{ color: '#9CA3AF' }}>—</span>}
      </td>
      <td style={{ padding: '6px 14px', color: '#374151', fontWeight: 600, whiteSpace: 'nowrap' }}>
        Day {days}
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

// ─── CLIENT CARD ─────────────────────────────────────────────
function ClientCard({ client, overdue, onClick, isSelected, onToggleSelect, selectionMode }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const days = getDaysSinceCreated(client);
  const nextStep = getNextStep(client);

  return (
    <button
      className={`${d.clientCard} ${overdue ? d.clientCardUrgent : ''} ${isSelected ? d.clientCardSelected : ''}`}
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

      <div className={d.cardHeader}>
        <Avatar
          path={client.avatarPath}
          firstName={client.firstName}
          lastName={client.lastName}
          size="sm"
        />
        <div style={{ flex: 1 }}>
          <div className={d.cardName}>
            {client.firstName} {client.lastName}
          </div>
          <div className={d.cardMeta}>
            {fmtPhone(client.phone)}
            {client.careRecipientName ? ` · ${client.careRecipientName}` : ''}
          </div>
        </div>
        {overdue && <span className={progress.urgentBadge}>⚠️ Overdue</span>}
      </div>

      <div className={d.cardPhaseRow}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className={progress.phaseBadge}
            style={{
              background: `${phaseInfo?.color || '#7A8BA0'}18`,
              color: phaseInfo?.color || '#7A8BA0',
              border: `1px solid ${phaseInfo?.color || '#7A8BA0'}30`,
            }}
          >
            {phaseInfo?.icon} {phaseInfo?.short}
          </span>
          {priorityInfo && priorityInfo.id !== 'normal' && (
            <span
              className={progress.phaseBadge}
              style={{
                background: `${priorityInfo.color}18`,
                color: priorityInfo.color,
                border: `1px solid ${priorityInfo.color}30`,
              }}
            >
              {priorityInfo.label}
            </span>
          )}
        </span>
        <span className={d.cardDays}>Day {days}</span>
      </div>

      {nextStep && (
        <div className={d.cardNextStep}>
          <span>{nextStep.critical ? '!' : '→'} {nextStep.label}</span>
        </div>
      )}
    </button>
  );
}

// ─── CLIENT DASHBOARD ────────────────────────────────────────
export function ClientDashboard({
  clients, allClients, filterPhase, searchTerm, setSearchTerm,
  onSelect, onAdd, onBulkEmail, showToast, sidebarWidth,
  addLabel = '＋ New Client',
}) {
  const [viewMode, setViewMode] = useState(() => {
    const stored = localStorage.getItem('tc_client_dashboard_view_mode');
    return stored === 'grid' ? 'grid' : 'list';
  });

  const handleViewModeChange = (mode) => {
    setViewMode(mode);
    localStorage.setItem('tc_client_dashboard_view_mode', mode);
  };

  const [showAllActions, setShowAllActions] = useState(false);
  const [actionsCollapsed, setActionsCollapsed] = useState(
    () => localStorage.getItem('tc_client_actions_collapsed') === 'true'
  );

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null); // 'email'

  // Email compose state
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [selectedEmailTemplate, setSelectedEmailTemplate] = useState('');
  const [emailSendStep, setEmailSendStep] = useState('compose'); // 'compose' | 'confirm'
  const [isSending, setIsSending] = useState(false);

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkAction(null);
  }, [filterPhase, searchTerm]);

  // Load email templates
  useEffect(() => {
    if (!supabase) return;
    supabase.from('app_settings').select('value').eq('key', 'email_templates').single()
      .then(({ data }) => {
        if (data?.value) {
          const parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          setEmailTemplates(Array.isArray(parsed) ? parsed : []);
        }
      })
      .catch(() => {});
  }, []);

  const totalActive = allClients.length;

  // Won this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const wonThisMonth = allClients.filter((c) => {
    const phase = getClientPhase(c);
    const wonTs = c.phaseTimestamps?.won;
    return phase === 'won' && wonTs && wonTs >= monthStart;
  }).length;

  const actionItems = generateClientActionItems(allClients);
  const visibleActions = showAllActions ? actionItems : actionItems.slice(0, 5);

  // A client is "overdue" only when an enabled action item rule produces
  // a critical-severity item for them. Disabling all rules in Settings
  // turns off every red badge on the dashboard.
  const overdueIds = new Set(
    actionItems.filter((a) => a.severity === 'critical').map((a) => a.clientId)
  );
  const overdueCount = overdueIds.size;

  const sortedClients = [...clients].sort((a, b) => {
    const pOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const aPri = pOrder[a.priority] ?? 2;
    const bPri = pOrder[b.priority] ?? 2;
    if (aPri !== bPri) return aPri - bPri;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  const selectionMode = selectedIds.size > 0;

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(sortedClients.map((cl) => cl.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkAction(null);
    setEmailSubject('');
    setEmailBody('');
    setSelectedEmailTemplate('');
    setEmailSendStep('compose');
  };

  return (
    <div>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Clients</h1>
          <p className={layout.pageSubtitle}>
            {filterPhase === 'archived'
              ? 'Showing: Archived clients'
              : filterPhase !== 'all'
              ? `Showing: ${CLIENT_PHASES.find((p) => p.id === filterPhase)?.label}`
              : 'All active clients in the pipeline'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={btn.primaryBtn} onClick={onAdd}>
            {addLabel}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className={cards.statsRow}>
        {[
          { label: 'Active Leads', value: totalActive, accent: '#2E4E8D', icon: '👥' },
          { label: 'Action Items', value: actionItems.length, accent: '#E85D4A', icon: '🔔' },
          { label: 'Won This Month', value: wonThisMonth, accent: '#16A34A', icon: '✅' },
          { label: 'Overdue', value: overdueCount, accent: '#DC3545', icon: '⚠️' },
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
            onClick={() => {
              const next = !actionsCollapsed;
              setActionsCollapsed(next);
              localStorage.setItem('tc_client_actions_collapsed', String(next));
            }}
          >
            <div className={d.panelTitleRow}>
              <span className={d.panelIcon}>🔔</span>
              <h3 className={d.panelTitle}>Client Action Items</h3>
              <span className={d.panelCount}>{actionItems.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className={d.panelBadges}>
                {actionItems.filter((a) => a.severity === 'critical').length > 0 && (
                  <span className={d.criticalCount}>
                    {actionItems.filter((a) => a.severity === 'critical').length} critical
                  </span>
                )}
                {actionItems.filter((a) => a.severity === 'warning').length > 0 && (
                  <span className={d.warningCount}>
                    {actionItems.filter((a) => a.severity === 'warning').length} warning
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
                        item.severity === 'critical' ? '#DC3545' :
                        item.severity === 'warning' ? '#D97706' : '#1084C3',
                      animation: `slideInLeft 0.3s cubic-bezier(0.4,0,0.2,1) ${i * 0.05}s both`,
                    }}
                    onClick={() => onSelect(item.clientId)}
                  >
                    <div className={d.itemTop}>
                      <span className={d.itemIcon}>
                        {item.severity === 'critical' ? '🚨' : item.severity === 'warning' ? '⚠️' : 'ℹ️'}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div className={d.itemTitle}>{item.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</div>
                        <div className={d.itemName}>{item.clientName}</div>
                      </div>
                      <span
                        className={d.urgencyBadge}
                        style={{
                          background:
                            item.severity === 'critical' ? '#FEF2F0' :
                            item.severity === 'warning' ? '#FFF8ED' : '#EBF5FB',
                          color:
                            item.severity === 'critical' ? '#DC3545' :
                            item.severity === 'warning' ? '#D97706' : '#1084C3',
                        }}
                      >
                        {item.severity === 'critical' ? 'Urgent' : item.severity === 'warning' ? 'Attention' : 'Info'}
                      </span>
                    </div>
                    <div className={d.itemMessage}>{item.message}</div>
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

      {/* Search + View Toggle */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginBottom: 20, flexWrap: 'wrap' }}>
        <div className={forms.searchBar} style={{ flex: '1 1 320px', marginBottom: 0 }}>
          <span className={forms.searchIcon}>🔍</span>
          <input
            className={forms.searchInput}
            placeholder="Search by name, phone, email, or care recipient..."
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

      {/* Client Cards */}
      {sortedClients.length === 0 ? (
        <div className={layout.emptyState}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F1724', margin: '0 0 8px' }}>
            {searchTerm ? 'No matches found' : 'No clients yet'}
          </h3>
          <p style={{ fontSize: 14, color: '#7A8BA0', margin: 0 }}>
            {searchTerm
              ? 'Try adjusting your search or clearing the filter.'
              : `Click "${addLabel.replace(/^[＋+]\s*/, '')}" to get started.`}
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
                  {selectedIds.size < sortedClients.length && (
                    <button className={d.selectAllLink} onClick={selectAll}>
                      Select all {sortedClients.length}
                    </button>
                  )}
                  <button className={d.clearLink} onClick={clearSelection}>
                    Clear
                  </button>
                </>
              ) : (
                <span className={d.selectHint}>
                  Click checkboxes to select clients for bulk email
                </span>
              )}
            </div>
          </div>

          {viewMode === 'grid' ? (
            <div className={d.cardGrid}>
              {sortedClients.map((cl, idx) => (
                <div key={cl.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
                  <ClientCard
                    client={cl}
                    overdue={overdueIds.has(cl.id)}
                    onClick={() => onSelect(cl.id)}
                    isSelected={selectedIds.has(cl.id)}
                    onToggleSelect={() => toggleSelect(cl.id)}
                    selectionMode={selectionMode}
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
                        checked={selectedIds.size === sortedClients.length && sortedClients.length > 0}
                        onChange={() => {
                          if (selectedIds.size === sortedClients.length) clearSelection();
                          else selectAll();
                        }}
                        style={{ cursor: 'pointer', width: 16, height: 16, accentColor: '#2E4E8D' }}
                      />
                    </th>
                    {['Name', 'Phone', 'Phase', 'Priority', 'Next Step', 'Day'].map((h) => (
                      <th key={h} style={{
                        padding: '12px 16px', textAlign: 'left', fontWeight: 700,
                        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px',
                        color: '#6B7280',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedClients.map((cl) => (
                    <ClientListRow
                      key={cl.id}
                      client={cl}
                      overdue={overdueIds.has(cl.id)}
                      isSelected={selectedIds.has(cl.id)}
                      onToggleSelect={() => toggleSelect(cl.id)}
                      onSelect={() => onSelect(cl.id)}
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
                {selectedIds.size} client{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
            </div>

            <div className={d.actionBarActions}>
              {/* Send Email */}
              <div className={d.actionGroup}>
                <button
                  className={`${d.actionBtn} ${bulkAction === 'email' ? d.actionBtnActive : ''}`}
                  onClick={() => { setBulkAction(bulkAction === 'email' ? null : 'email'); setEmailSendStep('compose'); }}
                >
                  ✉️ Send Email
                </button>
                {bulkAction === 'email' && (() => {
                  const selectedCls = sortedClients.filter((cl) => selectedIds.has(cl.id));
                  const withEmail = selectedCls.filter((cl) => cl.email?.trim());
                  const withoutEmail = selectedCls.length - withEmail.length;

                  if (emailSendStep === 'confirm') {
                    const previewCl = withEmail[0];
                    const previewSubject = previewCl ? resolveClientMergeFields(emailSubject, previewCl) : emailSubject;
                    const previewBody = previewCl ? resolveClientMergeFields(emailBody, previewCl) : emailBody;
                    return (
                      <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                        <div className={d.confirmPanel}>
                          <div className={d.confirmSummary}>
                            Send email to <strong>{withEmail.length}</strong> client{withEmail.length !== 1 ? 's' : ''} with valid email addresses
                          </div>
                          {withoutEmail > 0 && (
                            <div className={d.confirmSkipped}>
                              {withoutEmail} will be skipped (no email address)
                            </div>
                          )}
                          <div className={d.confirmPreviewLabel}>Subject</div>
                          <div className={d.confirmPreviewBox} style={{ marginBottom: 6, fontStyle: 'normal', fontWeight: 600 }}>{previewSubject}</div>
                          <div className={d.confirmPreviewLabel}>Preview ({previewCl ? `${previewCl.firstName} ${previewCl.lastName}` : ''})</div>
                          <div className={d.confirmPreviewBox}>{previewBody}</div>
                          <div className={d.composeActions}>
                            <button className={d.backBtn} onClick={() => setEmailSendStep('compose')}>← Back</button>
                            <button
                              className={d.sendBtn}
                              disabled={isSending || withEmail.length === 0}
                              onClick={async () => {
                                setIsSending(true);
                                try {
                                  const result = await onBulkEmail([...selectedIds], emailSubject.trim(), emailBody.trim());
                                  const { sent = 0, skipped = 0, failed = 0 } = result || {};
                                  let msg = `Email sent to ${sent} client${sent !== 1 ? 's' : ''}`;
                                  if (skipped > 0) msg += `, ${skipped} skipped`;
                                  if (failed > 0) msg += `, ${failed} failed`;
                                  showToast(msg);
                                  clearSelection();
                                } catch (err) {
                                  showToast(`Failed to send emails: ${err.message || 'Unknown error'}`);
                                } finally {
                                  setIsSending(false);
                                }
                              }}
                            >
                              {isSending ? 'Sending...' : `Send to ${withEmail.length} client${withEmail.length !== 1 ? 's' : ''}`}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className={`${d.actionDropdown} ${d.actionDropdownXWide}`}>
                      <div style={{ padding: '8px 12px 4px', fontSize: 12, color: '#6B7B8F', borderBottom: '1px solid #E5E7EB', marginBottom: 8 }}>
                        Send email to {selectedIds.size} client{selectedIds.size !== 1 ? 's' : ''}
                      </div>
                      {emailTemplates.length > 0 && (
                        <select
                          className={d.dropdownInput}
                          value={selectedEmailTemplate}
                          onChange={(e) => {
                            setSelectedEmailTemplate(e.target.value);
                            if (e.target.value) {
                              const tpl = emailTemplates.find((t) => t.id === e.target.value);
                              if (tpl) {
                                setEmailSubject(tpl.subject || '');
                                setEmailBody(tpl.body || '');
                              }
                            }
                          }}
                          style={{ marginBottom: 8 }}
                        >
                          <option value="">-- Pick a template (optional) --</option>
                          {emailTemplates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      )}
                      <input
                        className={d.dropdownInput}
                        placeholder="Subject line..."
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        autoFocus
                      />
                      <textarea
                        className={d.composeTextarea}
                        placeholder="Type your email message... Use {{firstName}}, {{lastName}} for merge fields"
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        rows={5}
                      />
                      <div className={d.mergeFieldsHint}>
                        Merge fields: {'{{firstName}}'}, {'{{lastName}}'}, {'{{email}}'}, {'{{careRecipientName}}'}, {'{{contactName}}'}
                      </div>
                      <div className={withEmail.length > 0 ? d.emailCountLine : `${d.emailCountLine} ${d.emailCountWarning}`}>
                        {withEmail.length} of {selectedCls.length} have a valid email address
                        {withoutEmail > 0 && ` · ${withoutEmail} will be skipped`}
                      </div>
                      <div className={d.composeActions}>
                        <button
                          className={d.sendBtn}
                          disabled={!emailSubject.trim() || !emailBody.trim() || withEmail.length === 0}
                          onClick={() => setEmailSendStep('confirm')}
                        >
                          Review & Send →
                        </button>
                      </div>
                    </div>
                  );
                })()}
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
