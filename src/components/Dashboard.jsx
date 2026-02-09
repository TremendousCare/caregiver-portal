import { useState, useEffect } from 'react';
import { PHASES } from '../lib/constants';
import { getCurrentPhase, getOverallProgress, getDaysInPhase, getDaysSinceApplication, isGreenLight, getPhaseProgress } from '../lib/utils';
import { generateActionItems } from '../lib/actionEngine';
import { loadBoardColumns } from '../lib/storage';
import { exportToCSV } from '../lib/export';
import { styles, actionStyles, bulkStyles } from '../styles/theme';

// TODO: Phase 2 — migrate full Dashboard, StatCard, CaregiverCard,
// ExportButton, ActionItems, and BulkActionBar from monolith.
// This stub renders a working but simplified version.

export function Dashboard({
  caregivers, allCaregivers, filterPhase, searchTerm, setSearchTerm,
  onSelect, onAdd, onBulkPhaseOverride, onBulkAddNote, onBulkBoardStatus,
  onBulkDelete, sidebarWidth,
}) {
  const totalActive = allCaregivers.length;
  const greenLightCount = allCaregivers.filter(isGreenLight).length;
  const avgProgress = totalActive
    ? Math.round(allCaregivers.reduce((s, c) => s + getOverallProgress(c), 0) / totalActive)
    : 0;

  const sortedCaregivers = [...caregivers].sort((a, b) => getOverallProgress(b) - getOverallProgress(a));

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Pipeline Dashboard</h1>
          <p style={styles.pageSubtitle}>
            {totalActive} active caregiver{totalActive !== 1 ? 's' : ''} in pipeline
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={onAdd}>
            ＋ New Caregiver
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={styles.statsRow}>
        <div className="tc-stat-card" style={styles.statCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 24 }}>👥</span>
            <span style={{ ...styles.statValue, color: '#2E4E8D' }}>{totalActive}</span>
          </div>
          <div style={styles.statLabel}>Total Active</div>
        </div>
        <div className="tc-stat-card" style={styles.statCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 24 }}>🟢</span>
            <span style={{ ...styles.statValue, color: '#16A34A' }}>{greenLightCount}</span>
          </div>
          <div style={styles.statLabel}>Green Light</div>
        </div>
        <div className="tc-stat-card" style={styles.statCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 24 }}>📊</span>
            <span style={{ ...styles.statValue, color: '#29BEE4' }}>{avgProgress}%</span>
          </div>
          <div style={styles.statLabel}>Avg Progress</div>
        </div>
      </div>

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
          <button style={styles.clearSearch} onClick={() => setSearchTerm('')}>✕</button>
        )}
      </div>

      {/* Cards */}
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
        <div style={styles.cardGrid}>
          {sortedCaregivers.map((cg, idx) => {
            const phase = getCurrentPhase(cg);
            const phaseInfo = PHASES.find((p) => p.id === phase);
            const progress = getOverallProgress(cg);
            const days = getDaysSinceApplication(cg);
            const daysInPhase = getDaysInPhase(cg);
            const urgent = (phase === 'onboarding' && daysInPhase >= 5) || (phase === 'intake' && daysInPhase >= 2);
            const greenLight = isGreenLight(cg);

            return (
              <div key={cg.id} style={{ animation: `fadeInUp 0.35s cubic-bezier(0.4,0,0.2,1) ${Math.min(idx * 0.04, 0.5)}s both` }}>
                <button
                  className="cg-card"
                  style={{
                    ...styles.cgCard,
                    ...(urgent ? styles.cgCardUrgent : {}),
                  }}
                  onClick={() => onSelect(cg.id)}
                >
                  <div style={styles.cgCardHeader}>
                    <div style={styles.cgAvatar}>
                      {cg.firstName?.[0]}{cg.lastName?.[0]}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={styles.cgName}>{cg.firstName} {cg.lastName}</div>
                      <div style={styles.cgMeta}>
                        {cg.phone || 'No phone'} {cg.perId ? `· PER ${cg.perId}` : ''}
                      </div>
                    </div>
                    {greenLight && <span style={styles.greenLightBadge}>🟢 Green Light</span>}
                    {urgent && !greenLight && <span style={styles.urgentBadge}>⚠️ Attention</span>}
                  </div>

                  <div style={styles.cgPhaseRow}>
                    <span style={{
                      ...styles.phaseBadge,
                      background: `${phaseInfo.color}18`,
                      color: phaseInfo.color,
                      border: `1px solid ${phaseInfo.color}30`,
                    }}>
                      {phaseInfo.icon} {phaseInfo.short}
                    </span>
                    <span style={styles.cgDays}>Day {days}</span>
                  </div>

                  <div style={styles.miniProgressTrack}>
                    {PHASES.map((p) => {
                      const { pct } = getPhaseProgress(cg, p.id);
                      return (
                        <div key={p.id} style={styles.miniSegment}>
                          <div className="tc-mini-fill" style={{ ...styles.miniSegmentFill, width: `${pct}%`, background: p.color }} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={styles.miniProgressLabel}>{progress}% complete</div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
