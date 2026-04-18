import { useEffect, useMemo, useState } from 'react';
import {
  combineDateAndTimeToIso,
  formatSkillsInput,
  isoToDateInput,
  isoToTimeInput,
  parseSkillsInput,
} from './shiftHelpers';
import { CaregiverPicker } from './CaregiverPicker';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import s from './ShiftForm.module.css';

// ═══════════════════════════════════════════════════════════════
// ShiftForm — reusable fields component
//
// Used by both ShiftCreateModal and ShiftDrawer. The form is a
// controlled component: the parent owns the draft state and passes
// it in as `draft`, plus an `onChange(next)` to receive updates.
//
// The form doesn't handle submission or cancel — that's the parent's
// responsibility. This keeps it usable in different contexts
// (modal vs. drawer) without duplicating field logic.
// ═══════════════════════════════════════════════════════════════

export function ShiftForm({ draft, onChange, clients, caregivers, servicePlans, errorMessage }) {
  const [skillsInput, setSkillsInput] = useState(formatSkillsInput(draft.requiredSkills || []));

  // Keep the skills input in sync when the parent resets the draft
  useEffect(() => {
    setSkillsInput(formatSkillsInput(draft.requiredSkills || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  // Derive date/time inputs from the ISO timestamps on the draft. We
  // pin the timezone to DEFAULT_APP_TIMEZONE so a shift created on an
  // EST laptop round-trips to PT wall-clock times in the form — the
  // same interpretation availability matching and recurrence use.
  const startDateInput = isoToDateInput(draft.startTime, DEFAULT_APP_TIMEZONE);
  const startTimeInput = isoToTimeInput(draft.startTime, DEFAULT_APP_TIMEZONE);
  const endDateInput = isoToDateInput(draft.endTime, DEFAULT_APP_TIMEZONE);
  const endTimeInput = isoToTimeInput(draft.endTime, DEFAULT_APP_TIMEZONE);

  const servicePlansForClient = useMemo(
    () => (servicePlans || []).filter((p) => p.clientId === draft.clientId),
    [servicePlans, draft.clientId],
  );

  const setField = (field, value) => onChange({ ...draft, [field]: value });

  const handleClientChange = (e) => {
    const clientId = e.target.value;
    const client = clients?.find((c) => c.id === clientId);
    const patch = { clientId, servicePlanId: null };
    // Auto-fill location with the client's home address (only if the
    // current location field is blank — don't overwrite user edits)
    if (client && !draft.locationAddress) {
      const parts = [client.address, client.city, client.state, client.zip].filter(Boolean);
      if (parts.length > 0) patch.locationAddress = parts.join(', ');
    }
    onChange({ ...draft, ...patch });
  };

  const handleServicePlanChange = (e) => {
    const servicePlanId = e.target.value || null;
    const plan = servicePlans?.find((p) => p.id === servicePlanId);
    const patch = { servicePlanId };
    if (plan && !draft.notes && plan.notes) patch.notes = plan.notes;
    onChange({ ...draft, ...patch });
  };

  const handleStartDateChange = (e) => {
    const next = combineDateAndTimeToIso(
      e.target.value,
      startTimeInput || '08:00',
      DEFAULT_APP_TIMEZONE,
    );
    if (next) setField('startTime', next);
  };

  const handleStartTimeChange = (e) => {
    const next = combineDateAndTimeToIso(
      startDateInput,
      e.target.value,
      DEFAULT_APP_TIMEZONE,
    );
    if (next) setField('startTime', next);
  };

  const handleEndDateChange = (e) => {
    const next = combineDateAndTimeToIso(
      e.target.value,
      endTimeInput || '12:00',
      DEFAULT_APP_TIMEZONE,
    );
    if (next) setField('endTime', next);
  };

  const handleEndTimeChange = (e) => {
    const next = combineDateAndTimeToIso(
      endDateInput,
      e.target.value,
      DEFAULT_APP_TIMEZONE,
    );
    if (next) setField('endTime', next);
  };

  const handleSkillsChange = (e) => {
    const text = e.target.value;
    setSkillsInput(text);
    setField('requiredSkills', parseSkillsInput(text));
  };

  return (
    <div className={s.form}>
      {/* ── Client + service plan ── */}
      <div className={s.row}>
        <label className={s.field}>
          Client <span className={s.required}>*</span>
          <select
            className={s.input}
            value={draft.clientId || ''}
            onChange={handleClientChange}
          >
            <option value="">Choose a client…</option>
            {(clients || []).map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id}
              </option>
            ))}
          </select>
        </label>

        <label className={s.field}>
          Service plan <span className={s.hint}>(optional)</span>
          <select
            className={s.input}
            value={draft.servicePlanId || ''}
            onChange={handleServicePlanChange}
            disabled={!draft.clientId || servicePlansForClient.length === 0}
          >
            <option value="">
              {draft.clientId
                ? servicePlansForClient.length === 0
                  ? 'No plans for this client'
                  : 'Ad-hoc (no plan)'
                : 'Pick a client first'}
            </option>
            {servicePlansForClient.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title || 'Untitled plan'} ({p.status})
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Start date + time ── */}
      <div className={s.row}>
        <label className={s.field}>
          Start date <span className={s.required}>*</span>
          <input
            className={s.input}
            type="date"
            value={startDateInput}
            onChange={handleStartDateChange}
          />
        </label>
        <label className={s.field}>
          Start time <span className={s.required}>*</span>
          <input
            className={s.input}
            type="time"
            step="900"
            value={startTimeInput}
            onChange={handleStartTimeChange}
          />
        </label>
      </div>

      {/* ── End date + time ── */}
      <div className={s.row}>
        <label className={s.field}>
          End date <span className={s.required}>*</span>
          <input
            className={s.input}
            type="date"
            value={endDateInput}
            onChange={handleEndDateChange}
          />
        </label>
        <label className={s.field}>
          End time <span className={s.required}>*</span>
          <input
            className={s.input}
            type="time"
            step="900"
            value={endTimeInput}
            onChange={handleEndTimeChange}
          />
        </label>
      </div>

      {/* ── Assignment ── */}
      <div className={s.row}>
        <div className={s.fieldWide}>
          Assigned caregiver <span className={s.hint}>(leave blank for open)</span>
          <CaregiverPicker
            caregivers={caregivers}
            clientId={draft.clientId}
            proposedStartTime={draft.startTime}
            proposedEndTime={draft.endTime}
            shiftId={draft.id}
            value={draft.assignedCaregiverId || null}
            onChange={(id) => setField('assignedCaregiverId', id)}
          />
        </div>
      </div>

      {/* ── Location ── */}
      <div className={s.row}>
        <label className={s.fieldWide}>
          Location
          <input
            className={s.input}
            type="text"
            placeholder="123 Main St, Bellevue, WA"
            value={draft.locationAddress || ''}
            onChange={(e) => setField('locationAddress', e.target.value)}
          />
        </label>
      </div>

      {/* ── Rates + mileage ── */}
      <div className={s.row3}>
        <label className={s.field}>
          Hourly rate <span className={s.hint}>($/hr paid to caregiver)</span>
          <input
            className={s.input}
            type="number"
            min="0"
            step="0.25"
            value={draft.hourlyRate ?? ''}
            onChange={(e) => setField('hourlyRate', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="24.50"
          />
        </label>
        <label className={s.field}>
          Billable rate <span className={s.hint}>($/hr to client)</span>
          <input
            className={s.input}
            type="number"
            min="0"
            step="0.25"
            value={draft.billableRate ?? ''}
            onChange={(e) => setField('billableRate', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="35.00"
          />
        </label>
        <label className={s.field}>
          Mileage
          <input
            className={s.input}
            type="number"
            min="0"
            step="0.1"
            value={draft.mileage ?? ''}
            onChange={(e) => setField('mileage', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="12.5"
          />
        </label>
      </div>

      {/* ── Skills ── */}
      <div className={s.row}>
        <label className={s.fieldWide}>
          Required skills <span className={s.hint}>(comma-separated)</span>
          <input
            className={s.input}
            type="text"
            placeholder="Hoyer lift, dementia care, transfer assistance"
            value={skillsInput}
            onChange={handleSkillsChange}
          />
        </label>
      </div>

      {/* ── Instructions ── */}
      <div className={s.row}>
        <label className={s.fieldWide}>
          Shift instructions <span className={s.hint}>(what the caregiver should do)</span>
          <textarea
            className={s.textarea}
            rows={2}
            placeholder="Morning routine, breakfast, light housekeeping"
            value={draft.instructions || ''}
            onChange={(e) => setField('instructions', e.target.value)}
          />
        </label>
      </div>

      {/* ── Notes ── */}
      <div className={s.row}>
        <label className={s.fieldWide}>
          Internal notes <span className={s.hint}>(team only)</span>
          <textarea
            className={s.textarea}
            rows={2}
            placeholder="Anything the team should know"
            value={draft.notes || ''}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </label>
      </div>

      {errorMessage && <div className={s.error}>{errorMessage}</div>}
    </div>
  );
}
