import { useState } from 'react';
import { getClientPhase } from './utils';
import { LOST_REASONS } from './constants';

import { ClientHeader } from './client/ClientHeader';
import { ClientNextSteps } from './client/ClientNextSteps';
import { ClientProfileCard } from './client/ClientProfileCard';
import { ClientProgressOverview } from './client/ClientProgressOverview';
import { ClientPhaseDetail } from './client/ClientPhaseDetail';
import { ClientActivityLog } from './client/ClientActivityLog';
import cl from './client/client.module.css';
import cards from '../../styles/cards.module.css';
import forms from '../../styles/forms.module.css';
import btn from '../../styles/buttons.module.css';

// ─── Archive Banner (inline, same pattern as caregiver) ───
function ArchiveBanner({ client }) {
  if (!client.archived) return null;

  return (
    <div className={cl.archiveBanner}>
      <div className={cl.archiveBannerHeader}>
        <span className={cl.archiveBannerIcon}>📦</span>
        <strong className={cl.archiveBannerTitle}>Archived Client</strong>
      </div>
      <div className={cl.archiveBannerDetails}>
        <div><span className={cl.archiveBannerLabel}>Reason:</span> {client.archiveReason || '—'}</div>
        {client.archiveDetail && <div><span className={cl.archiveBannerLabel}>Detail:</span> {client.archiveDetail}</div>}
        {client.archivedAt && (
          <div>
            <span className={cl.archiveBannerLabel}>Archived:</span>{' '}
            {new Date(client.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Archive Dialog ───
function ArchiveDialog({ isOpen, onArchive, onCancel }) {
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');

  if (!isOpen) return null;

  const handleArchive = () => {
    onArchive(reason, detail);
    setReason('');
    setDetail('');
  };

  const handleCancel = () => {
    onCancel();
    setReason('');
    setDetail('');
  };

  return (
    <div className={cards.alertCard}>
      <strong>Archive this client?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#556270' }}>
        They'll be moved out of the active pipeline. You can restore them later.
      </p>
      <div style={{ marginBottom: 12 }}>
        <label className={forms.fieldLabel}>Reason <span style={{ color: '#DC3545' }}>*</span></label>
        <select className={forms.fieldInput} value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Select a reason...</option>
          {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value="Won - completed">Won - completed</option>
          <option value="Data cleanup">Data cleanup</option>
          <option value="Duplicate">Duplicate</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className={forms.fieldLabel}>Details (optional)</label>
        <input className={forms.fieldInput} placeholder="Any additional context..." value={detail} onChange={(e) => setDetail(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={btn.dangerBtn} style={{ opacity: reason ? 1 : 0.5 }} disabled={!reason} onClick={handleArchive}>Archive</button>
        <button className={btn.secondaryBtn} onClick={handleCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Delete Dialog ───
function DeleteDialog({ isOpen, clientName, onDelete, onCancel }) {
  if (!isOpen) return null;

  return (
    <div className={cards.alertCard} style={{ borderColor: '#DC2626', background: '#FEF2F2' }}>
      <strong style={{ color: '#991B1B' }}>Permanently delete this client?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#7F1D1D' }}>
        This will permanently remove <strong>{clientName}</strong> and all their data including notes, tasks, and activity history. This action cannot be undone.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={btn.dangerBtn}
          style={{ background: '#DC2626', color: '#fff' }}
          onClick={onDelete}
        >
          Delete Permanently
        </button>
        <button className={btn.secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── MAIN CLIENT DETAIL CONTAINER ────────────────────────────
export function ClientDetail({
  client, allClients, currentUser,
  onBack, onUpdateTask, onUpdateTasksBulk, onAddNote, onUpdatePhase,
  onArchive, onUnarchive, onDelete, onUpdateClient,
  onRefreshTasks, showToast,
}) {
  const [activePhase, setActivePhase] = useState(getClientPhase(client));
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showScripts, setShowScripts] = useState(null);

  return (
    <div>
      <ClientHeader
        client={client}
        onBack={onBack}
        onShowArchive={() => setShowArchiveDialog(true)}
        onUnarchive={onUnarchive}
        onShowDelete={() => setShowDeleteDialog(true)}
        onAddNote={onAddNote}
      />

      <ArchiveBanner client={client} />

      <ArchiveDialog
        isOpen={showArchiveDialog}
        onArchive={(reason, detail) => {
          onArchive(client.id, reason, detail);
          setShowArchiveDialog(false);
        }}
        onCancel={() => setShowArchiveDialog(false)}
      />

      <DeleteDialog
        isOpen={showDeleteDialog}
        clientName={`${client.firstName} ${client.lastName}`}
        onDelete={() => { onDelete(client.id); setShowDeleteDialog(false); }}
        onCancel={() => setShowDeleteDialog(false)}
      />

      <ClientNextSteps
        client={client}
        onUpdateTask={onUpdateTask}
        onAddNote={onAddNote}
        currentUser={currentUser}
      />

      <ClientProfileCard
        client={client}
        onUpdateClient={onUpdateClient}
      />

      <ClientProgressOverview
        client={client}
        activePhase={activePhase}
        onPhaseChange={setActivePhase}
        onUpdateClient={onUpdateClient}
      />

      <ClientPhaseDetail
        client={client}
        activePhase={activePhase}
        showScripts={showScripts}
        onToggleScripts={setShowScripts}
        onUpdateTask={onUpdateTask}
        onUpdateTasksBulk={onUpdateTasksBulk}
        onRefreshTasks={onRefreshTasks}
      />

      <ClientActivityLog
        client={client}
        currentUser={currentUser}
        onAddNote={onAddNote}
      />
    </div>
  );
}
