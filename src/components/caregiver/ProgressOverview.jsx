import { PHASES } from '../../lib/constants';
import { getCurrentPhase, getCalculatedPhase, getOverallProgress, getPhaseProgress, getDaysSinceApplication } from '../../lib/utils';
import progress from '../../styles/progress.module.css';

export function ProgressOverview({ caregiver, activePhase, onPhaseChange, onUpdateCaregiver }) {
  const overallPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const calculated = getCalculatedPhase(caregiver);
  const isOverridden = !!caregiver.phaseOverride;
  const currentPhase = getCurrentPhase(caregiver);
  const currentPhaseInfo = PHASES.find((p) => p.id === currentPhase);

  return (
    <div className={progress.progressOverview}>
      <div className={progress.progressHeader}>
        <span className={progress.progressTitle}>Onboarding Progress</span>
        <span className={progress.progressPct}>{overallPct}%</span>
        <span className={progress.progressDays}>Day {days}</span>
      </div>
      <div className={progress.progressTrack}>
        <div className={progress.progressFill} style={{ width: `${overallPct}%` }} />
      </div>

      {/* Phase Override */}
      <div className={progress.phaseOverrideRow}>
        <div className={progress.phaseOverrideLeft}>
          <span className={progress.phaseOverrideLabel}>Current Phase:</span>
          <span className={progress.phaseBadge} style={{ background: `${currentPhaseInfo.color}18`, color: currentPhaseInfo.color, border: `1px solid ${currentPhaseInfo.color}30` }}>
            {currentPhaseInfo.icon} {currentPhaseInfo.label}
          </span>
          {isOverridden && <span className={progress.overrideBadge}>⚙️ Manual Override</span>}
        </div>
        <div className={progress.phaseOverrideRight}>
          <select className={progress.phaseOverrideSelect} value={caregiver.phaseOverride || ''}
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

      <div className={progress.phaseNav}>
        {PHASES.map((p) => {
          const { pct } = getPhaseProgress(caregiver, p.id);
          return (
            <button key={p.id} className={progress.phaseTab} style={activePhase === p.id ? { background: `${p.color}18`, borderColor: p.color, color: p.color } : {}} onClick={() => onPhaseChange(p.id)}>
              <span>{p.icon}</span>
              <span className={progress.phaseTabLabel}>{p.short}</span>
              <span className={progress.phaseTabPct}>{pct}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
