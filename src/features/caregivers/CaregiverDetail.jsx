import { useState } from 'react';
import { getCurrentPhase, isGreenLight, getOverallProgress } from '../../lib/utils';

import { CaregiverHeader } from './caregiver/CaregiverHeader';
import { ArchiveBanner } from './caregiver/ArchiveBanner';
import { ArchiveDialog } from './caregiver/ArchiveDialog';
import { DeleteDialog } from './caregiver/DeleteDialog';
import { GreenLightChecklist } from './caregiver/GreenLightChecklist';
import { ProfileCard } from './caregiver/ProfileCard';
import { ProgressOverview } from './caregiver/ProgressOverview';
import { PhaseDetail } from './caregiver/PhaseDetail';
import { DocumentsSection } from './caregiver/DocumentsSection';
import { ActivityLog } from './caregiver/ActivityLog';

export function CaregiverDetail({
  caregiver, allCaregivers, currentUser, onBack, onUpdateTask, onUpdateTasksBulk,
  onAddNote, onArchive, onUnarchive, onDelete, onUpdateCaregiver, onRefreshTasks,
  showScripts, setShowScripts, showGreenLight, setShowGreenLight, showToast,
}) {
  const [activePhase, setActivePhase] = useState(getCurrentPhase(caregiver));
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const greenLight = isGreenLight(caregiver);
  const onboardingComplete = getOverallProgress(caregiver) === 100;
  const showRosterNudge = onboardingComplete && (!caregiver.employmentStatus || caregiver.employmentStatus === 'onboarding') && !caregiver.archived;

  return (
    <div>
      <CaregiverHeader
        caregiver={caregiver}
        greenLight={greenLight}
        onBack={onBack}
        onToggleGreenLight={() => setShowGreenLight(!showGreenLight)}
        onShowArchive={() => setShowArchiveDialog(true)}
        onUnarchive={onUnarchive}
        onShowDelete={() => setShowDeleteDialog(true)}
      />

      <ArchiveBanner caregiver={caregiver} />

      {showRosterNudge && (
        <div style={{
          background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)', border: '1px solid #BBF7D0',
          borderRadius: 14, padding: '16px 20px', marginBottom: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ fontWeight: 700, color: '#15803D', fontSize: 15 }}>
              All onboarding tasks complete!
            </div>
            <div style={{ color: '#166534', fontSize: 13, marginTop: 4 }}>
              Ready to move this caregiver to the Active Roster?
            </div>
          </div>
          <button
            onClick={() => onUpdateCaregiver(caregiver.id, {
              employmentStatus: 'active',
              employmentStatusChangedAt: Date.now(),
              employmentStatusChangedBy: currentUser?.displayName || 'Unknown',
            })}
            style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: '#15803D', color: '#fff', fontWeight: 700,
              fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
              boxShadow: '0 2px 8px rgba(21,128,61,0.3)',
            }}
          >
            Move to Active Roster
          </button>
        </div>
      )}

      <ArchiveDialog
        isOpen={showArchiveDialog}
        onArchive={(reason, detail) => {
          onArchive(caregiver.id, reason, detail);
          setShowArchiveDialog(false);
        }}
        onCancel={() => setShowArchiveDialog(false)}
      />

      <DeleteDialog
        isOpen={showDeleteDialog}
        caregiverName={`${caregiver.first_name} ${caregiver.last_name}`}
        onDelete={() => { onDelete(caregiver.id); setShowDeleteDialog(false); }}
        onCancel={() => setShowDeleteDialog(false)}
      />

      <GreenLightChecklist
        isOpen={showGreenLight}
        caregiver={caregiver}
        onClose={() => setShowGreenLight(false)}
      />

      <ProfileCard
        caregiver={caregiver}
        onUpdateCaregiver={onUpdateCaregiver}
      />

      <ProgressOverview
        caregiver={caregiver}
        activePhase={activePhase}
        onPhaseChange={setActivePhase}
        onUpdateCaregiver={onUpdateCaregiver}
      />

      <PhaseDetail
        caregiver={caregiver}
        allCaregivers={allCaregivers}
        activePhase={activePhase}
        showScripts={showScripts}
        onToggleScripts={setShowScripts}
        onUpdateTask={onUpdateTask}
        onUpdateTasksBulk={onUpdateTasksBulk}
        onRefreshTasks={onRefreshTasks}
      />

      <DocumentsSection
        caregiver={caregiver}
        currentUser={currentUser}
        showToast={showToast}
        onUpdateCaregiver={onUpdateCaregiver}
      />

      <ActivityLog
        caregiver={caregiver}
        onAddNote={onAddNote}
      />
    </div>
  );
}
