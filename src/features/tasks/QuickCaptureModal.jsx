// Quick Capture modal — the primary entry point for staff to create
// ad-hoc follow-up tasks. Invoked globally via Cmd/Ctrl+K (wired in
// AppShell.jsx) and contextually via the "+ Follow-up" buttons on
// caregiver and client detail pages.
//
// Design (locked 2026-05-27, see docs/TASKS_AND_FOLLOWUPS.md §4.5):
//   • 5 fields, no scrolling: title (autofocus), due, about,
//     urgency, [optional] description.
//   • Natural-language date parsing via chrono-node. The parsed
//     value echoes underneath the input so the user gets instant
//     feedback ("Thu May 28, 2026 · 9:00 AM").
//   • Creator = assignee (owner decision). No assignee picker in v1.
//   • Single entity link — caregiver OR client OR neither.
//
// State management:
//   • The modal's open/close state lives in FollowUpContext so any
//     part of the app can `openComposer({ caregiverId? clientId? })`.
//   • Submission goes through useFollowUps().createTask which handles
//     optimistic update, event logging, and toast on error.

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Calendar, User, Home, Search } from 'lucide-react';
import { useFollowUps } from '../../shared/context/FollowUpContext';
import { useApp } from '../../shared/context/AppContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import { useClients } from '../../shared/context/ClientContext';
import { parseTaskDue, defaultTaskDue, formatTaskDueEcho } from '../../lib/parseTaskDue';

export function QuickCaptureModal() {
  const { composerOpen, composerPrefill, closeComposer, createTask } = useFollowUps();
  const { showToast, currentUserEmail } = useApp();
  const { caregivers } = useCaregivers();
  const { clients } = useClients();

  // ─── Local form state ─────────────────────────────────────
  const [title, setTitle] = useState('');
  const [dueText, setDueText] = useState('');
  const [urgency, setUrgency] = useState('warning');
  const [description, setDescription] = useState('');
  const [entitySearch, setEntitySearch] = useState('');
  const [selectedEntity, setSelectedEntity] = useState(null); // { kind, id, label }
  const [showEntityList, setShowEntityList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const titleInputRef = useRef(null);

  // Reset form whenever the modal opens. Pre-fill the entity slot
  // from composerPrefill (set by the contextual "+ Follow-up"
  // button on entity pages).
  useEffect(() => {
    if (!composerOpen) return;
    setTitle('');
    setDueText('');
    setUrgency('warning');
    setDescription('');
    setEntitySearch('');
    setError(null);
    setSubmitting(false);
    setShowEntityList(false);

    const prefill = composerPrefill;
    if (prefill?.caregiverId) {
      const cg = (caregivers || []).find((c) => c.id === prefill.caregiverId);
      setSelectedEntity(cg ? {
        kind: 'caregiver',
        id: cg.id,
        label: `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || cg.id,
      } : { kind: 'caregiver', id: prefill.caregiverId, label: prefill.caregiverId });
    } else if (prefill?.clientId) {
      const cl = (clients || []).find((c) => c.id === prefill.clientId);
      setSelectedEntity(cl ? {
        kind: 'client',
        id: cl.id,
        label: `${cl.firstName || ''} ${cl.lastName || ''}`.trim() || cl.id,
      } : { kind: 'client', id: prefill.clientId, label: prefill.clientId });
    } else {
      setSelectedEntity(null);
    }
  }, [composerOpen, composerPrefill, caregivers, clients]);

  // Autofocus the title input each time the modal opens. setTimeout
  // is needed because the input isn't in the DOM until React commits.
  useEffect(() => {
    if (!composerOpen) return;
    const t = setTimeout(() => titleInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [composerOpen]);

  // Escape closes; click outside the panel also closes (handled in
  // the overlay's onClick). Esc is wired on `window` so it works even
  // if focus has escaped the panel (e.g., a tooltip stole it).
  // Cmd/Ctrl+Enter submit is handled on the form element below where
  // the React closure is always fresh.
  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeComposer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composerOpen, closeComposer]);

  // ─── Derived: parsed due preview + entity suggestions ────
  const parsedDue = useMemo(() => parseTaskDue(dueText), [dueText]);
  const effectiveDue = parsedDue || defaultTaskDue();
  const dueEcho = useMemo(() => formatTaskDueEcho(effectiveDue), [effectiveDue]);

  const entityMatches = useMemo(() => {
    const q = entitySearch.trim().toLowerCase();
    if (!q) return [];
    const cgMatches = (caregivers || []).filter((c) => {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
      return name.includes(q);
    }).slice(0, 6).map((c) => ({
      kind: 'caregiver',
      id: c.id,
      label: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id,
    }));
    const clMatches = (clients || []).filter((c) => {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
      return name.includes(q);
    }).slice(0, 6).map((c) => ({
      kind: 'client',
      id: c.id,
      label: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id,
    }));
    return [...cgMatches, ...clMatches];
  }, [entitySearch, caregivers, clients]);

  // ─── Submit ───────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (submitting) return;
    setError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Title is required.');
      return;
    }

    setSubmitting(true);
    const { error: createError } = await createTask({
      title: trimmedTitle,
      description: description.trim() || null,
      dueAt: effectiveDue,
      urgency,
      caregiverId: selectedEntity?.kind === 'caregiver' ? selectedEntity.id : null,
      clientId: selectedEntity?.kind === 'client' ? selectedEntity.id : null,
      createdBy: currentUserEmail || null,
    });
    setSubmitting(false);
    if (createError) {
      setError(createError.message || 'Could not create the task. Please try again.');
      return;
    }
    showToast?.('Follow-up added');
    closeComposer();
  };

  if (!composerOpen) return null;

  return (
    <div style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) closeComposer(); }}>
      <div role="dialog" aria-label="New follow-up" style={panelStyle}>
        <form
          onSubmit={handleSubmit}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits from anywhere in the form,
            // including the description textarea where plain Enter
            // is a newline.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
          <div style={headerStyle}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>New follow-up</div>
            <button type="button" aria-label="Close" onClick={closeComposer} style={closeBtnStyle}>
              <X size={16} />
            </button>
          </div>

          <div style={bodyStyle}>
            {/* Title */}
            <label style={fieldLabelStyle}>What needs doing?</label>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call Maria re: I-9 paperwork"
              style={titleInputStyle}
              maxLength={200}
            />

            {/* Due */}
            <label style={{ ...fieldLabelStyle, marginTop: 14 }}>
              <Calendar size={12} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              Due
            </label>
            <input
              type="text"
              value={dueText}
              onChange={(e) => setDueText(e.target.value)}
              placeholder="tomorrow 9am — or leave blank for today 5pm"
              style={textInputStyle}
            />
            <div style={dueEchoStyle}>
              {dueText.trim()
                ? (parsedDue
                    ? <>parsed: <strong>{dueEcho}</strong></>
                    : <>couldn’t parse that — try “tomorrow 9am” or “fri 2pm”</>)
                : <>default: <strong>{dueEcho}</strong></>}
            </div>

            {/* Entity */}
            <label style={{ ...fieldLabelStyle, marginTop: 14 }}>
              About (optional)
            </label>
            {selectedEntity ? (
              <div style={entityChipStyle}>
                {selectedEntity.kind === 'caregiver'
                  ? <User size={12} style={{ marginRight: 6 }} />
                  : <Home size={12} style={{ marginRight: 6 }} />}
                <span style={{ flex: 1 }}>{selectedEntity.label}</span>
                {/* Prefill from a contextual button locks the entity;
                    a Cmd+K-opened composer lets you clear it. */}
                {!composerPrefill?.lockEntity && (
                  <button type="button" aria-label="Clear entity" onClick={() => setSelectedEntity(null)} style={clearChipBtnStyle}>
                    <X size={12} />
                  </button>
                )}
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#7A8BA0' }} />
                  <input
                    type="text"
                    value={entitySearch}
                    onChange={(e) => { setEntitySearch(e.target.value); setShowEntityList(true); }}
                    onFocus={() => setShowEntityList(true)}
                    placeholder="Search caregiver or client…"
                    style={{ ...textInputStyle, paddingLeft: 30 }}
                  />
                </div>
                {showEntityList && entityMatches.length > 0 && (
                  <div style={entityListStyle}>
                    {entityMatches.map((m) => (
                      <button
                        key={`${m.kind}-${m.id}`}
                        type="button"
                        onClick={() => { setSelectedEntity(m); setEntitySearch(''); setShowEntityList(false); }}
                        style={entityListItemStyle}
                      >
                        {m.kind === 'caregiver'
                          ? <User size={12} style={{ marginRight: 8, color: '#1084C3' }} />
                          : <Home size={12} style={{ marginRight: 8, color: '#15803D' }} />}
                        <span style={{ flex: 1 }}>{m.label}</span>
                        <span style={{ fontSize: 11, color: '#7A8BA0' }}>{m.kind}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Urgency */}
            <label style={{ ...fieldLabelStyle, marginTop: 14 }}>Urgency</label>
            <div style={urgencyRowStyle}>
              {[
                { id: 'info',     label: 'Info',     color: '#1084C3' },
                { id: 'warning',  label: 'Normal',   color: '#D97706' },
                { id: 'critical', label: 'Critical', color: '#DC3545' },
              ].map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setUrgency(u.id)}
                  style={urgencyChipStyle(u.id === urgency, u.color)}
                >
                  {u.label}
                </button>
              ))}
            </div>

            {/* Description (optional) */}
            <label style={{ ...fieldLabelStyle, marginTop: 14 }}>Notes (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything you'll want to remember when this surfaces…"
              rows={2}
              style={textareaStyle}
            />

            {error && <div style={errorStyle} role="alert">{error}</div>}
          </div>

          <div style={footerStyle}>
            <div style={{ flex: 1, fontSize: 11, color: '#7A8BA0' }}>
              <kbd style={kbdStyle}>Esc</kbd> to cancel · <kbd style={kbdStyle}>⌘↵</kbd> to save
            </div>
            <button type="button" onClick={closeComposer} style={cancelBtnStyle} disabled={submitting}>Cancel</button>
            <button type="submit" style={saveBtnStyle} disabled={submitting || !title.trim()}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────

const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 9000,
  background: 'rgba(0,16,40,0.45)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  paddingTop: '12vh', paddingLeft: 16, paddingRight: 16,
};
const panelStyle = {
  width: '100%', maxWidth: 540,
  background: '#fff', borderRadius: 12,
  boxShadow: '0 24px 60px rgba(0,16,40,0.35)',
  border: '1px solid #E0E4EA',
  overflow: 'hidden',
};
const headerStyle = {
  display: 'flex', alignItems: 'center',
  padding: '14px 16px',
  borderBottom: '1px solid #EDF0F4',
  background: '#FAFBFC',
};
const closeBtnStyle = {
  marginLeft: 'auto', background: 'none', border: 'none',
  cursor: 'pointer', color: '#5D6B7F', padding: 4,
};
const bodyStyle = { padding: '14px 16px 4px' };
const fieldLabelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700,
  color: '#5D6B7F', textTransform: 'uppercase', letterSpacing: '1px',
  marginBottom: 6,
};
const titleInputStyle = {
  width: '100%', padding: '10px 12px',
  fontSize: 15, fontWeight: 500,
  border: '1px solid #E0E4EA', borderRadius: 8,
  boxSizing: 'border-box',
};
const textInputStyle = {
  width: '100%', padding: '8px 12px',
  fontSize: 13,
  border: '1px solid #E0E4EA', borderRadius: 8,
  boxSizing: 'border-box',
};
const dueEchoStyle = {
  marginTop: 6, fontSize: 11, color: '#5D6B7F', minHeight: 14,
};
const entityChipStyle = {
  display: 'flex', alignItems: 'center',
  padding: '8px 10px',
  background: 'rgba(41,190,228,0.08)',
  border: '1px solid rgba(41,190,228,0.4)',
  borderRadius: 8, fontSize: 13,
};
const clearChipBtnStyle = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#5D6B7F', padding: 2, marginLeft: 8,
};
const entityListStyle = {
  position: 'absolute', top: '100%', left: 0, right: 0,
  marginTop: 4,
  background: '#fff',
  border: '1px solid #E0E4EA', borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,16,40,0.12)',
  maxHeight: 220, overflowY: 'auto', zIndex: 10,
};
const entityListItemStyle = {
  display: 'flex', alignItems: 'center', width: '100%',
  padding: '8px 12px',
  background: '#fff', border: 'none', cursor: 'pointer',
  fontSize: 13, textAlign: 'left',
  borderBottom: '1px solid #F2F4F8',
};
const urgencyRowStyle = { display: 'flex', gap: 6 };
function urgencyChipStyle(selected, color) {
  return {
    flex: 1,
    padding: '8px 10px',
    fontSize: 13, fontWeight: 500,
    background: selected ? color : '#fff',
    color: selected ? '#fff' : color,
    border: `1px solid ${color}`,
    borderRadius: 8, cursor: 'pointer',
  };
}
const textareaStyle = {
  width: '100%', padding: '8px 12px',
  fontSize: 13, resize: 'vertical',
  border: '1px solid #E0E4EA', borderRadius: 8,
  boxSizing: 'border-box', fontFamily: 'inherit',
};
const errorStyle = {
  marginTop: 12,
  padding: '8px 12px',
  background: 'rgba(220,53,69,0.08)',
  border: '1px solid rgba(220,53,69,0.3)',
  borderRadius: 6,
  fontSize: 13, color: '#DC3545',
};
const footerStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '12px 16px',
  background: '#FAFBFC',
  borderTop: '1px solid #EDF0F4',
};
const cancelBtnStyle = {
  padding: '8px 14px', border: '1px solid #E0E4EA',
  borderRadius: 8, background: '#fff',
  color: '#5D6B7F', fontSize: 13, cursor: 'pointer',
};
const saveBtnStyle = {
  padding: '8px 16px', border: 'none',
  borderRadius: 8, background: 'var(--tc-navy)',
  color: '#fff', fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
};
const kbdStyle = {
  display: 'inline-block',
  padding: '1px 5px',
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 10,
  border: '1px solid #E0E4EA', borderRadius: 4,
  background: '#fff', color: '#5D6B7F',
};
