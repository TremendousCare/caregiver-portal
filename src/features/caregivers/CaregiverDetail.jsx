import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
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
import { RecommendedNextStep } from './caregiver/RecommendedNextStep';
import { SurveyResults } from './caregiver/SurveyResults';
import { DetailTabBar } from './caregiver/DetailTabBar';
import { MessagingCenter } from './caregiver/MessagingCenter';
import { useCommsTimeline } from './caregiver/useCommsTimeline';
import { AvailabilityEditor } from '../scheduling/AvailabilityEditor';
import { CaregiverSchedulePanel } from '../scheduling/CaregiverSchedulePanel';

export function CaregiverDetail({
  caregiver, allCaregivers, currentUser, onBack, onUpdateTask, onUpdateTasksBulk,
  onAddNote, onArchive, onUnarchive, onDelete, onUpdateCaregiver, onRefreshTasks,
  showScripts, setShowScripts, showGreenLight, setShowGreenLight, showToast,
}) {
  const [activePhase, setActivePhase] = useState(getCurrentPhase(caregiver));
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [detailTab, setDetailTab] = useState('tasks');
  const [surveyStatus, setSurveyStatus] = useState(null);

  const { smsMessages, emailMessages, callEntries, rcLoading, emailLoading, accessToken, needsResponse } = useCommsTimeline(caregiver);

  const greenLight = isGreenLight(caregiver);
  const currentPhase = getCurrentPhase(caregiver);
  const onboardingComplete = getOverallProgress(caregiver) === 100;
  const showRosterNudge = onboardingComplete && (!caregiver.employmentStatus || caregiver.employmentStatus === 'onboarding') && !caregiver.archived;

  useEffect(() => {
    if (!supabase || !caregiver.id) return;
    supabase
      .from('survey_responses')
      .select('status')
      .eq('caregiver_id', caregiver.id)
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .then(({ data }) => setSurveyStatus(data?.[0]?.status ?? null));
  }, [caregiver.id]);

  return (
    <div>
      <CaregiverHeader
        caregiver={caregiver}
        greenLight={greenLight}
        phase={currentPhase}
        surveyStatus={surveyStatus}
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

      <SurveyResults caregiver={caregiver} />

      <ProgressOverview
        caregiver={caregiver}
        activePhase={activePhase}
        onPhaseChange={setActivePhase}
        onUpdateCaregiver={onUpdateCaregiver}
        currentUser={currentUser}
        showToast={showToast}
      />

      <RecommendedNextStep caregiver={caregiver} />

      <DetailTabBar
        activeTab={detailTab}
        onChange={setDetailTab}
        needsResponse={needsResponse}
      />

      {detailTab === 'tasks' && (
        <>
          <PhaseDetail
            caregiver={caregiver}
            allCaregivers={allCaregivers}
            activePhase={activePhase}
            currentUser={currentUser}
            showToast={showToast}
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
        </>
      )}

      {detailTab === 'messages' && (
        <MessagingCenter
          caregiver={caregiver}
          smsMessages={smsMessages}
          emailMessages={emailMessages}
          callEntries={callEntries}
          rcLoading={rcLoading}
          emailLoading={emailLoading}
          accessToken={accessToken}
          currentUser={currentUser}
          onAddNote={onAddNote}
          showToast={showToast}
        />
      )}

      {detailTab === 'availability' && (
        <AvailabilityEditor
          caregiver={caregiver}
          currentUserName={currentUser?.displayName}
          showToast={showToast}
        />
      )}

      {detailTab === 'schedule' && (
        <CaregiverSchedulePanel
          caregiver={caregiver}
          showToast={showToast}
        />
      )}
    </div>
  );
}
