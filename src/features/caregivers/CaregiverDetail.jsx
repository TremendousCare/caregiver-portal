import { useState } from 'react';
import { getCurrentPhase, isGreenLight } from '../../lib/utils';

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
