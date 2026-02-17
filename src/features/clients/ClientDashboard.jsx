import { useState } from 'react';
import { CLIENT_PHASES, CLIENT_PRIORITIES } from './constants';
import { getClientPhase, getDaysSinceCreated, isClientOverdue, getNextStep } from './utils';
import { generateClientActionItems } from './actionEngine';
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

// ─── CLIENT CARD ─────────────────────────────────────────────
function ClientCard({ client, onClick }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const days = getDaysSinceCreated(client);
  const overdue = isClientOverdue(client);
  const nextStep = getNextStep(client);

  return (
    <button
      className={`${d.clientCard} ${overdue ? d.clientCardUrgent : ''}`}
      onClick={onClick}
    >
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
            {client.phone || 'No phone'}
            {client.careRecipientName ? ` · Care for: ${client.careRecipientName}` : ''}
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
  onSelect, onAdd, sidebarWidth,
}) {
  const [showAllActions, setShowAllActions] = useState(false);
  const [actionsCollapsed, setActionsCollapsed] = useState(
    () => localStorage.getItem('tc_client_actions_collapsed') === 'true'
  );

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
    // Sort by priority then by creation date
    const pOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
    const aPri = pOrder[a.priority] ?? 2;
    const bPri = pOrder[b.priority] ?? 2;
    if (aPri !== bPri) return aPri - bPri;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

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
        <div className={d.cardGrid}>
          {sortedClients.map((cl, idx) => (
            <div key={cl.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
              <ClientCard
                client={cl}
                onClick={() => onSelect(cl.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
