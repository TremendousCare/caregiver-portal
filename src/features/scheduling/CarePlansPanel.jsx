import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  createCarePlan,
  updateCarePlan,
  getCarePlansForClient,
} from './storage';
import {
  formatStatusLabel,
  statusColors,
  summarizeCarePlan,
  sortCarePlans,
  validateCarePlanDraft,
} from './carePlanHelpers';
import {
  describeRecurrencePattern,
  hasRecurrencePattern,
  validateRecurrencePattern,
} from './recurrenceHelpers';
import { RecurrencePatternEditor } from './RecurrencePatternEditor';
import { GenerateShiftsDialog } from './GenerateShiftsDialog';
import btn from '../../styles/buttons.module.css';
import s from './CarePlansPanel.module.css';

// ═══════════════════════════════════════════════════════════════
// CarePlansPanel — Phase 4a
//
// Section on the client detail page that lists, creates, and edits
// care plans for a client. Care plans define what care the client
// needs: title, freeform service description, hours/week, start
// and end dates, status, and notes.
//
// This panel does NOT create shifts — that's Phase 4b. It just
// captures the plan so it's ready to attach to future shifts.
// ═══════════════════════════════════════════════════════════════

const EMPTY_DRAFT = {
  title: '',
  serviceType: '',
  hoursPerWeek: '',
  startDate: '',
  endDate: '',
  status: 'draft',
  notes: '',
  recurrencePattern: null,
};

export function CarePlansPanel({ client, currentUser, showToast }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // editing === null  -> no edit open
  // editing === 'new' -> inline create form visible
  // editing === id    -> that plan's inline edit form visible
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  // Phase 7: plan currently open in the "Generate shifts" dialog
  const [generatingPlan, setGeneratingPlan] = useState(null);

  // ─── Load on mount ───────────────────────────────────────────
  const loadPlans = useCallback(async () => {
    try {
      const rows = await getCarePlansForClient(client.id);
      setPlans(sortCarePlans(rows));
      setLoadError(null);
    } catch (e) {
      console.error('CarePlansPanel load error:', e);
      setLoadError(e.message || 'Failed to load care plans');
    } finally {
      setLoading(false);
    }
  }, [client.id]);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  // ─── Realtime subscription (keep the list in sync across users) ─
  useEffect(() => {
    if (!supabase || !client.id) return undefined;
    const channel = supabase
      .channel(`care-plans-${client.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'care_plans',
          filter: `client_id=eq.${client.id}`,
        },
        () => {
          loadPlans();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [client.id, loadPlans]);

  // ─── Open create form ────────────────────────────────────────
  const handleStartCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setEditing('new');
    setErrorMessage(null);
  };

  const handleStartEdit = (plan) => {
    setDraft({
      title: plan.title || '',
      serviceType: plan.serviceType || '',
      hoursPerWeek: plan.hoursPerWeek ?? '',
      startDate: plan.startDate || '',
      endDate: plan.endDate || '',
      status: plan.status || 'draft',
      notes: plan.notes || '',
      recurrencePattern: plan.recurrencePattern || null,
    });
    setEditing(plan.id);
    setErrorMessage(null);
  };

  const handleCancel = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setErrorMessage(null);
  };

  // ─── Save ────────────────────────────────────────────────────
  const handleSave = async () => {
    const error = validateCarePlanDraft(draft);
    if (error) {
      setErrorMessage(error);
      return;
    }
    // Phase 7: also validate recurrence pattern if one was set
    if (draft.recurrencePattern) {
      const recurrenceError = validateRecurrencePattern(draft.recurrencePattern);
      if (recurrenceError) {
        setErrorMessage(`Recurrence pattern: ${recurrenceError}`);
        return;
      }
    }
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload = {
        clientId: client.id,
        title: draft.title.trim(),
        serviceType: draft.serviceType?.trim() || null,
        hoursPerWeek: draft.hoursPerWeek === '' ? null : Number(draft.hoursPerWeek),
        startDate: draft.startDate || null,
        endDate: draft.endDate || null,
        status: draft.status || 'draft',
        notes: draft.notes?.trim() || null,
        recurrencePattern: draft.recurrencePattern || null,
        createdBy: currentUser?.displayName || currentUser?.email || null,
      };
      if (editing === 'new') {
        await createCarePlan(payload);
        showToast?.('Care plan created');
      } else {
        await updateCarePlan(editing, payload);
        showToast?.('Care plan saved');
      }
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      await loadPlans();
    } catch (e) {
      console.error('Save failed:', e);
      setErrorMessage(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusShortcut = async (plan, nextStatus) => {
    try {
      await updateCarePlan(plan.id, { status: nextStatus });
      showToast?.(`Status updated to ${formatStatusLabel(nextStatus)}`);
      await loadPlans();
    } catch (e) {
      console.error('Status update failed:', e);
      showToast?.(`Update failed: ${e.message || e}`);
    }
  };

  // ─── Render ──────────────────────────────────────────────────
  return (
    <section className={s.panel}>
      <header className={s.header}>
        <div>
          <h3 className={s.title}>Care Plans</h3>
          <p className={s.subtitle}>
            Document what care this client needs. Plans can be linked to shifts in the
            scheduling calendar.
          </p>
        </div>
        {editing !== 'new' && (
          <button className={btn.primaryBtn} onClick={handleStartCreate}>
            + New Care Plan
          </button>
        )}
      </header>

      {loading && <div className={s.loading}>Loading care plans…</div>}
      {loadError && (
        <div className={s.errorBanner}>Could not load care plans: {loadError}</div>
      )}

      {editing === 'new' && (
        <CarePlanForm
          draft={draft}
          onChange={setDraft}
          onSave={handleSave}
          onCancel={handleCancel}
          saving={saving}
          errorMessage={errorMessage}
          mode="create"
        />
      )}

      {!loading && plans.length === 0 && editing !== 'new' && (
        <div className={s.empty}>
          No care plans yet. Click "+ New Care Plan" to create one.
        </div>
      )}

      <ul className={s.list}>
        {plans.map((plan) => (
          <li key={plan.id} className={s.listItem}>
            {editing === plan.id ? (
              <CarePlanForm
                draft={draft}
                onChange={setDraft}
                onSave={handleSave}
                onCancel={handleCancel}
                saving={saving}
                errorMessage={errorMessage}
                mode="edit"
              />
            ) : (
              <CarePlanCard
                plan={plan}
                onEdit={() => handleStartEdit(plan)}
                onStatusChange={(next) => handleStatusShortcut(plan, next)}
                onGenerate={(p) => setGeneratingPlan(p)}
              />
            )}
          </li>
        ))}
      </ul>

      {generatingPlan && (
        <GenerateShiftsDialog
          plan={generatingPlan}
          client={client}
          currentUserName={currentUser?.displayName || currentUser?.email}
          onClose={() => setGeneratingPlan(null)}
          onGenerated={(count) => {
            setGeneratingPlan(null);
            showToast?.(`Generated ${count} shift${count === 1 ? '' : 's'}`);
          }}
          showToast={showToast}
        />
      )}
    </section>
  );
}

// ─── CarePlanCard (read-only row) ──────────────────────────────

function CarePlanCard({ plan, onEdit, onStatusChange, onGenerate }) {
  const colors = statusColors(plan.status);
  const canGenerate = hasRecurrencePattern(plan.recurrencePattern) && plan.status === 'active';
  return (
    <div className={s.card}>
      <div className={s.cardMain}>
        <div className={s.cardHeader}>
          <div className={s.cardTitleGroup}>
            <span className={s.cardTitle}>{plan.title || 'Untitled plan'}</span>
            <span
              className={s.statusPill}
              style={{
                background: colors.bg,
                color: colors.fg,
                borderColor: colors.border,
              }}
            >
              {formatStatusLabel(plan.status)}
            </span>
          </div>
          <div className={s.cardActions}>
            <button
              className={s.linkBtn}
              onClick={onEdit}
              aria-label={`Edit ${plan.title}`}
            >
              Edit
            </button>
          </div>
        </div>

        <div className={s.cardMeta}>{summarizeCarePlan(plan)}</div>

        {plan.serviceType && (
          <div className={s.cardServiceType}>{plan.serviceType}</div>
        )}

        {hasRecurrencePattern(plan.recurrencePattern) && (
          <div className={s.cardRecurrence}>
            <span className={s.cardRecurrenceLabel}>Pattern:</span>{' '}
            {describeRecurrencePattern(plan.recurrencePattern)}
          </div>
        )}

        {plan.notes && <div className={s.cardNotes}>{plan.notes}</div>}

        <div className={s.cardFooter}>
          <StatusShortcuts current={plan.status} onChange={onStatusChange} />
          {canGenerate && (
            <button
              className={s.generateBtn}
              onClick={() => onGenerate?.(plan)}
            >
              Generate shifts →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusShortcuts({ current, onChange }) {
  const next = {
    draft: 'active',
    active: 'paused',
    paused: 'active',
    ended: null,
  }[current];
  return (
    <div className={s.statusShortcuts}>
      {current !== 'ended' && next && (
        <button className={s.linkBtn} onClick={() => onChange(next)}>
          {current === 'active' ? 'Pause' : current === 'paused' ? 'Resume' : 'Activate'}
        </button>
      )}
      {current !== 'ended' && (
        <button className={s.linkBtn} onClick={() => onChange('ended')}>
          End plan
        </button>
      )}
      {current === 'ended' && (
        <button className={s.linkBtn} onClick={() => onChange('active')}>
          Reactivate
        </button>
      )}
    </div>
  );
}

// ─── CarePlanForm (create + edit) ──────────────────────────────

function CarePlanForm({ draft, onChange, onSave, onCancel, saving, errorMessage, mode }) {
  const set = (field, value) => onChange({ ...draft, [field]: value });

  return (
    <div className={s.form}>
      <div className={s.formHeader}>
        <h4 className={s.formTitle}>
          {mode === 'create' ? 'New care plan' : 'Edit care plan'}
        </h4>
      </div>

      <div className={s.formGrid}>
        <label className={s.fieldLabel}>
          Title
          <input
            className={s.fieldInput}
            type="text"
            placeholder="e.g. Weekly companion care"
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            autoFocus
          />
        </label>

        <label className={s.fieldLabel}>
          Status
          <select
            className={s.fieldInput}
            value={draft.status}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="ended">Ended</option>
          </select>
        </label>

        <label className={s.fieldLabelWide}>
          Service type (freeform)
          <input
            className={s.fieldInput}
            type="text"
            placeholder="personal care + companion + light housekeeping"
            value={draft.serviceType}
            onChange={(e) => set('serviceType', e.target.value)}
          />
        </label>

        <label className={s.fieldLabel}>
          Hours per week
          <input
            className={s.fieldInput}
            type="number"
            min="0"
            step="0.5"
            placeholder="20"
            value={draft.hoursPerWeek}
            onChange={(e) => set('hoursPerWeek', e.target.value)}
          />
        </label>

        <label className={s.fieldLabel}>
          Start date
          <input
            className={s.fieldInput}
            type="date"
            value={draft.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
        </label>

        <label className={s.fieldLabel}>
          End date <span className={s.fieldHint}>(leave blank for ongoing)</span>
          <input
            className={s.fieldInput}
            type="date"
            value={draft.endDate}
            onChange={(e) => set('endDate', e.target.value)}
          />
        </label>

        <label className={s.fieldLabelWide}>
          Notes
          <textarea
            className={s.fieldTextarea}
            rows={3}
            placeholder="Anything the team should know about this plan"
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </label>

        {/* Phase 7: Recurrence pattern editor (full-width, inside the grid) */}
        <RecurrencePatternEditor
          value={draft.recurrencePattern}
          onChange={(next) => set('recurrencePattern', next)}
          disabled={saving}
        />
      </div>

      {errorMessage && <div className={s.formError}>{errorMessage}</div>}

      <div className={s.formActions}>
        <button className={btn.secondaryBtn} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className={btn.primaryBtn} onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : mode === 'create' ? 'Create plan' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
