import { PHASES } from '../../lib/constants';
import { getCurrentPhase, getCalculatedPhase, getOverallProgress, getPhaseProgress, getDaysSinceApplication } from '../../lib/utils';
import { styles } from '../../styles/theme';

export function ProgressOverview({ caregiver, activePhase, onPhaseChange, onUpdateCaregiver }) {
  const overallPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const calculated = getCalculatedPhase(caregiver);
  const isOverridden = !!caregiver.phaseOverride;
  const currentPhase = getCurrentPhase(caregiver);
  const currentPhaseInfo = PHASES.find((p) => p.id === currentPhase);

  return (
    <div style={styles.progressOverview}>
      <div style={styles.progressHeader}>
        <span style={styles.progressTitle}>Onboarding Progress</span>
        <span style={styles.progressPct}>{overallPct}%</span>
        <span style={styles.progressDays}>Day {days}</span>
      </div>
      <div style={styles.progressTrack}>
        <div className="tc-progress-fill" style={{ ...styles.progressFill, width: `${overallPct}%` }} />
      </div>

      {/* Phase Override */}
      <div style={styles.phaseOverrideRow}>
        <div style={styles.phaseOverrideLeft}>
          <span style={styles.phaseOverrideLabel}>Current Phase:</span>
          <span style={{ ...styles.phaseBadge, background: `${currentPhaseInfo.color}18`, color: currentPhaseInfo.color, border: `1px solid ${currentPhaseInfo.color}30` }}>
            {currentPhaseInfo.icon} {currentPhaseInfo.label}
          </span>
          {isOverridden && <span style={styles.overrideBadge}>⚙️ Manual Override</span>}
        </div>
        <div style={styles.phaseOverrideRight}>
          <select style={styles.phaseOverrideSelect} value={caregiver.phaseOverride || ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val === '') {
                onUpdateCaregiver(caregiver.id, { phaseOverride: null });
              } else {
                onUpdateCaregiver(caregiver.id, { phaseOverride: val, phaseTimestamps: { ...caregiver.phaseTimestamps, [val]: caregiver.phaseTimestamps?.[val] || Date.now() } });
                onPhaseChange(val);
              }
            }}
          >
            <option value="">Auto (based on tasks)</option>
            {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}{p.id === calculated ? ' ← calculated' : ''}</option>)}
          </select>
        </div>
      </div>

      <div style={styles.phaseNav}>
        {PHASES.map((p) => {
          const { pct } = getPhaseProgress(caregiver, p.id);
          return (
            <button key={p.id} style={{ ...styles.phaseTab, ...(activePhase === p.id ? { background: `${p.color}18`, borderColor: p.color, color: p.color } : {}) }} onClick={() => onPhaseChange(p.id)}>
              <span>{p.icon}</span>
              <span style={styles.phaseTabLabel}>{p.short}</span>
              <span style={styles.phaseTabPct}>{pct}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
