import { PHASES, SUB_PHASES } from '../../../lib/constants';
import { getCurrentPhase, getCalculatedPhase, getOverallProgress, getPhaseProgress, getDaysSinceApplication, getSubPhase } from '../../../lib/utils';
import { closePendingSuggestionForAction } from '../../../lib/agentLoopClosure';
import progress from '../../../styles/progress.module.css';

const ACTIVE_ROSTER_OPTION = '__active_roster__';

export function ProgressOverview({ caregiver, activePhase, onPhaseChange, onUpdateCaregiver, currentUser, showToast }) {
  const overallPct = getOverallProgress(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const calculated = getCalculatedPhase(caregiver);
  const isOverridden = !!caregiver.phaseOverride;
  const currentPhase = getCurrentPhase(caregiver);
  const currentPhaseInfo = PHASES.find((p) => p.id === currentPhase);
  const currentSubPhase = getSubPhase(caregiver.phaseOverride);
  const isOnRoster = caregiver.employmentStatus && caregiver.employmentStatus !== 'onboarding';

  const promoteToActiveRoster = () => {
    const name = `${caregiver.firstName || caregiver.first_name || ''} ${caregiver.lastName || caregiver.last_name || ''}`.trim() || 'this applicant';
    const confirmed = window.confirm(
      `Move ${name} to the Active Roster?\n\n` +
      `This will mark them as an active caregiver (employment status: Active) ` +
      `and they will appear on the Active Roster page. You can still change this later ` +
      `from their profile or the Active Roster.\n\n` +
      `Click OK to confirm, or Cancel to go back.`
    );
    if (!confirmed) return;
    onUpdateCaregiver(caregiver.id, {
      employmentStatus: 'active',
      employmentStatusChangedAt: Date.now(),
      employmentStatusChangedBy: currentUser?.displayName || 'Unknown',
    });
    if (showToast) showToast(`${name} moved to Active Roster`, 'success');
  };

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
            {currentSubPhase ? ` → ${currentSubPhase.short}` : ''}
          </span>
          {isOverridden && <span className={progress.overrideBadge}>⚙️ Manual Override</span>}
        </div>
        <div className={progress.phaseOverrideRight}>
          <select className={progress.phaseOverrideSelect} value={caregiver.phaseOverride || ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val === ACTIVE_ROSTER_OPTION) {
                // Reset select immediately so it doesn't appear "selected" regardless of confirm outcome
                e.target.value = caregiver.phaseOverride || '';
                promoteToActiveRoster();
                return;
              }
              const fromPhase = caregiver.phaseOverride || getCurrentPhase(caregiver);
              if (val === '') {
                onUpdateCaregiver(caregiver.id, { phaseOverride: null });
              } else {
                // For a sub-phase override the on-screen phase tab and
                // phaseTimestamps key are the PARENT main phase, not the
                // sub-phase id (sub-phases have no task list of their own).
                const sub = SUB_PHASES.find((s) => s.id === val);
                const parentPhaseId = sub ? sub.parent : val;
                onUpdateCaregiver(caregiver.id, {
                  phaseOverride: val,
                  phaseTimestamps: {
                    ...caregiver.phaseTimestamps,
                    [parentPhaseId]: caregiver.phaseTimestamps?.[parentPhaseId] || Date.now(),
                  },
                });
                onPhaseChange(parentPhaseId);
              }
              // Phase 1.5 follow-up — close any matching pending
              // ai_suggestion for this (caregiver, update_phase) and
              // write the agent_actions `phase='executed'` audit row
              // that autonomy v2 reads. Fire-and-forget — the update
              // has already been dispatched optimistically via the
              // context; failure here must never affect the UX.
              closePendingSuggestionForAction({
                entityType: 'caregiver',
                entityId: caregiver.id,
                actionType: 'update_phase',
                params: {
                  from_phase: fromPhase || null,
                  to_phase: val || null,
                },
              }).catch((closeErr) => {
                console.warn('[ProgressOverview] suggestion-close failed (non-fatal):', closeErr);
              });
            }}
          >
            <option value="">Auto (based on tasks)</option>
            {PHASES.flatMap((p) => {
              const subs = SUB_PHASES.filter((s) => s.parent === p.id);
              const parentOption = (
                <option key={p.id} value={p.id}>
                  {p.icon} {p.label}{p.id === calculated ? ' ← calculated' : ''}
                </option>
              );
              const subOptions = subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {'    '}↳ {s.label}
                </option>
              ));
              return [parentOption, ...subOptions];
            })}
            {!isOnRoster && <option disabled>──────────</option>}
            {!isOnRoster && <option value={ACTIVE_ROSTER_OPTION}>🚀 Move to Active Roster…</option>}
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
