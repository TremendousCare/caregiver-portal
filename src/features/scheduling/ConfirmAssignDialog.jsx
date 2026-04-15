import { useEffect, useMemo, useState } from 'react';
import {
  getSchedulingTemplate,
  setSchedulingTemplate,
} from './storage';
import {
  DEFAULT_CONFIRMATION_TEMPLATE,
  buildMergeFields,
  renderTemplate,
} from './broadcastHelpers';
import { TemplateEditor } from './TemplateEditor';
import btn from '../../styles/buttons.module.css';
import s from './ConfirmAssignDialog.module.css';

// ═══════════════════════════════════════════════════════════════
// ConfirmAssignDialog — Phase 5c
//
// Opens when the scheduler clicks "Assign [name] →" on an accepted
// offer in the ShiftDrawer. Shows the confirmation SMS pre-populated
// with the team-wide default template, plus a live preview rendered
// for the specific caregiver being assigned.
//
// Three outcomes possible:
//   1. Scheduler clicks "Send & assign" without editing
//      → default confirmation SMS goes out, caregiver is assigned
//   2. Scheduler edits the text, then clicks "Send & assign"
//      → edited SMS goes out, caregiver assigned, default template
//        unchanged (per-shift customization)
//   3. Scheduler edits AND checks "Save as new default", then sends
//      → edited SMS goes out AND becomes the new team-wide default
//        for future confirmations
// ═══════════════════════════════════════════════════════════════

export const CONFIRMATION_TEMPLATE_KEY = 'scheduling_confirmation_template';

export function ConfirmAssignDialog({
  shift,
  caregiver,
  client,
  onClose,
  onConfirm,
  sending,
}) {
  const [template, setTemplate] = useState(DEFAULT_CONFIRMATION_TEMPLATE);
  const [loading, setLoading] = useState(true);
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  // Load the current team-wide default on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await getSchedulingTemplate(
          CONFIRMATION_TEMPLATE_KEY,
          DEFAULT_CONFIRMATION_TEMPLATE,
        );
        if (!cancelled) setTemplate(stored);
      } catch (e) {
        console.error('Failed to load confirmation template:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live preview rendered for this specific caregiver
  const previewText = useMemo(() => {
    if (!template) return '';
    const fields = buildMergeFields({ shift, caregiver, client });
    return renderTemplate(template, fields);
  }, [template, shift, caregiver, client]);

  const caregiverName = `${caregiver?.firstName || ''} ${caregiver?.lastName || ''}`.trim() || 'caregiver';

  const handleConfirm = async () => {
    // If the user opted to save the template as default, persist it
    // BEFORE we call onConfirm — that way the new default is live
    // even if the parent closes the dialog synchronously.
    if (saveAsDefault) {
      try {
        await setSchedulingTemplate(CONFIRMATION_TEMPLATE_KEY, template);
      } catch (e) {
        console.warn('Failed to save confirmation template as default:', e);
        // Continue anyway — the assignment should still go through
      }
    }
    // Parent handles the assignment + SMS send with this rendered text
    onConfirm?.({ template, renderedMessage: previewText });
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="confirm-assign-title"
      >
        <header className={s.header}>
          <div>
            <h2 id="confirm-assign-title" className={s.title}>
              Confirm {caregiverName} for this shift
            </h2>
            <div className={s.subtitle}>
              Review the confirmation SMS below. {caregiverName} will get this text
              when you click Send &amp; assign.
            </div>
          </div>
          <button
            className={s.closeBtn}
            onClick={onClose}
            aria-label="Close"
            disabled={sending}
          >
            ×
          </button>
        </header>

        <div className={s.body}>
          {loading ? (
            <div className={s.loading}>Loading template…</div>
          ) : (
            <TemplateEditor
              label="Confirmation message"
              value={template}
              onChange={setTemplate}
              previewText={previewText}
              previewLabel={`Preview for ${caregiverName}`}
              saveAsDefault={saveAsDefault}
              onToggleSaveAsDefault={setSaveAsDefault}
              disabled={sending}
            />
          )}
        </div>

        <footer className={s.footer}>
          <button
            className={btn.secondaryBtn}
            onClick={onClose}
            disabled={sending}
          >
            Cancel
          </button>
          <button
            className={btn.primaryBtn}
            onClick={handleConfirm}
            disabled={sending || loading || !template || !template.trim()}
          >
            {sending ? 'Assigning…' : 'Send & assign'}
          </button>
        </footer>
      </div>
    </div>
  );
}
