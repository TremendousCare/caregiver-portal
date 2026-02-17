import { CLIENT_PHASES } from '../constants';
import { getClientPhase, getClientOverallProgress, getClientPhaseProgress, getDaysSinceCreated } from '../utils';
import progress from '../../../styles/progress.module.css';

// Active pipeline phases (progress tabs) vs terminal/status phases (badges)
const PIPELINE_PHASES = CLIENT_PHASES.filter((p) => !['won', 'lost', 'nurture'].includes(p.id));
const STATUS_PHASES = CLIENT_PHASES.filter((p) => ['won', 'lost', 'nurture'].includes(p.id));

export function ClientProgressOverview({ client, activePhase, onPhaseChange, onUpdateClient }) {
  const overallPct = getClientOverallProgress(client);
  const days = getDaysSinceCreated(client);
  const currentPhase = getClientPhase(client);
  const currentPhaseInfo = CLIENT_PHASES.find((p) => p.id === currentPhase);

  return (
    <div className={progress.progressOverview}>
      <div className={progress.progressHeader}>
        <span className={progress.progressTitle}>Client Pipeline Progress</span>
        <span className={progress.progressPct}>{overallPct}%</span>
        <span className={progress.progressDays}>Day {days}</span>
      </div>
      <div className={progress.progressTrack}>
        <div className={progress.progressFill} style={{ width: `${overallPct}%` }} />
      </div>

      {/* Phase Selector */}
      <div className={progress.phaseOverrideRow}>
        <div className={progress.phaseOverrideLeft}>
          <span className={progress.phaseOverrideLabel}>Current Phase:</span>
          <span
            className={progress.phaseBadge}
            style={{
              background: `${currentPhaseInfo?.color || '#7A8BA0'}18`,
              color: currentPhaseInfo?.color || '#7A8BA0',
              border: `1px solid ${currentPhaseInfo?.color || '#7A8BA0'}30`,
            }}
          >
            {currentPhaseInfo?.icon} {currentPhaseInfo?.label}
          </span>
        </div>
        <div className={progress.phaseOverrideRight}>
          <select
            className={progress.phaseOverrideSelect}
            value={currentPhase}
            onChange={(e) => {
              const val = e.target.value;
              onUpdateClient(client.id, {
                phase: val,
                phaseTimestamps: {
                  ...client.phaseTimestamps,
                  [val]: client.phaseTimestamps?.[val] || Date.now(),
                },
              });
              onPhaseChange(val);
            }}
          >
            {CLIENT_PHASES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon} {p.label}{p.id === currentPhase ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Pipeline Phase Tabs (active phases with progress) */}
      <div className={progress.phaseNav}>
        {PIPELINE_PHASES.map((p) => {
          const { pct } = getClientPhaseProgress(client, p.id);
          return (
            <button
              key={p.id}
              className={progress.phaseTab}
              style={activePhase === p.id ? { background: `${p.color}18`, borderColor: p.color, color: p.color } : {}}
              onClick={() => onPhaseChange(p.id)}
            >
              <span>{p.icon}</span>
              <span className={progress.phaseTabLabel}>{p.short}</span>
              <span className={progress.phaseTabPct}>{pct}%</span>
            </button>
          );
        })}
      </div>

      {/* Status Badges (won/lost/nurture) */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {STATUS_PHASES.map((p) => (
          <button
            key={p.id}
            style={{
              padding: '5px 12px',
              borderRadius: 8,
              border: activePhase === p.id ? `2px solid ${p.color}` : '1px solid #E2E8F0',
              background: activePhase === p.id ? `${p.color}12` : 'transparent',
              color: activePhase === p.id ? p.color : '#7A8BA0',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onClick={() => onPhaseChange(p.id)}
          >
            {p.icon} {p.short}
          </button>
        ))}
      </div>
    </div>
  );
}
