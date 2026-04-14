import { useEffect, useState } from 'react';
import { createShift } from './storage';
import { validateShiftDraft } from './shiftHelpers';
import { ShiftForm } from './ShiftForm';
import btn from '../../styles/buttons.module.css';
import s from './ShiftCreateModal.module.css';

// ═══════════════════════════════════════════════════════════════
// ShiftCreateModal — Phase 4b
//
// Opens from the master calendar when the user clicks an empty
// time slot. Collects all shift fields, validates, and calls
// createShift(). On success, fires onCreated(newShift) so the
// parent can close the modal and refresh the calendar.
// ═══════════════════════════════════════════════════════════════

export function ShiftCreateModal({
  initialDraft,
  clients,
  caregivers,
  carePlans,
  currentUserName,
  onClose,
  onCreated,
  showToast,
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Re-sync when the parent passes a new initialDraft (e.g. different slot clicked)
  useEffect(() => {
    setDraft(initialDraft);
    setError(null);
  }, [initialDraft]);

  const handleSave = async () => {
    const validationError = validateShiftDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        clientId: draft.clientId,
        carePlanId: draft.carePlanId || null,
        assignedCaregiverId: draft.assignedCaregiverId || null,
        startTime: draft.startTime,
        endTime: draft.endTime,
        status: draft.assignedCaregiverId ? 'assigned' : 'open',
        locationAddress: draft.locationAddress || null,
        hourlyRate: draft.hourlyRate ?? null,
        billableRate: draft.billableRate ?? null,
        mileage: draft.mileage ?? null,
        requiredSkills: draft.requiredSkills || [],
        instructions: draft.instructions || null,
        notes: draft.notes || null,
        createdBy: currentUserName || null,
      };
      const created = await createShift(payload);
      showToast?.('Shift created');
      onCreated?.(created);
    } catch (e) {
      console.error('Create shift failed:', e);
      setError(e.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="shift-create-title"
      >
        <header className={s.header}>
          <h2 id="shift-create-title" className={s.title}>
            Create shift
          </h2>
          <button
            className={s.closeBtn}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className={s.body}>
          <ShiftForm
            draft={draft}
            onChange={setDraft}
            clients={clients}
            caregivers={caregivers}
            carePlans={carePlans}
            errorMessage={error}
          />
        </div>

        <footer className={s.footer}>
          <button
            className={btn.secondaryBtn}
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className={btn.primaryBtn}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Creating…' : 'Create shift'}
          </button>
        </footer>
      </div>
    </div>
  );
}
