import { useState, useEffect } from 'react';
import { CLIENT_PHASES, CLIENT_PRIORITIES } from './constants';
import { getClientPhase, getDaysSinceCreated, isClientOverdue, getNextStep } from './utils';
import { generateClientActionItems } from '../../lib/actionItemEngine';
import { supabase } from '../../lib/supabase';
import { resolveClientMergeFields } from '../../lib/mergeFields';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import progress from '../../styles/progress.module.css';
import layout from '../../styles/layout.module.css';
import d from './ClientDashboard.module.css';

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

// ─── CLIENT CARD ─────────────────────────────────────────────
function ClientCard({ client, onClick, isSelected, onToggleSelect, selectionMode }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const days = getDaysSinceCreated(client);
  const overdue = isClientOverdue(client);
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
        <div className={d.cardAvatar}>
          {client.firstName?.[0]}
          {client.lastName?.[0]}
        </div>
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
        <div className={`${d.cardNextStep} ${nextStep.overdue ? d.cardNextStepOverdue : ''}`}>
          {nextStep.overdue && <span className={d.cardOverdueDot} />}
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
}) {
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
  const overdueCount = allClients.filter(isClientOverdue).length;

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
          <h1 className={layout.pageTitle}>Client Pipeline</h1>
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
            ＋ New Client
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

      {/* Search */}
      <div className={forms.searchBar}>
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
              : 'Click "New Client" to begin building your pipeline.'}
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

          <div className={d.cardGrid}>
            {sortedClients.map((cl, idx) => (
              <div key={cl.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
                <ClientCard
                  client={cl}
                  onClick={() => onSelect(cl.id)}
                  isSelected={selectedIds.has(cl.id)}
                  onToggleSelect={() => toggleSelect(cl.id)}
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
