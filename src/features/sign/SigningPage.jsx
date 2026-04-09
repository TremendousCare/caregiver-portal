import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import * as pdfjsLib from 'pdfjs-dist';
import s from './SigningPage.module.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

// ─── Signature Pad Modal ───
function SignatureModal({ fieldType, onSave, onClose }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [mode, setMode] = useState('draw');
  const [typedName, setTypedName] = useState('');

  const getPos = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (e.touches) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }, []);

  const startDraw = useCallback((e) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
    setHasDrawn(true);
  }, [getPos]);

  const draw = useCallback((e) => {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pos = getPos(e);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }, [drawing, getPos]);

  const stopDraw = useCallback(() => {
    setDrawing(false);
  }, []);

  const clear = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasDrawn(false);
    setTypedName('');
  };

  const handleApply = () => {
    if (mode === 'draw') {
      if (!hasDrawn) return;
      onSave(canvasRef.current.toDataURL('image/png'));
    } else {
      if (!typedName.trim()) return;
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 640, 200);
      ctx.font = 'italic 48px "Dancing Script", "Brush Script MT", cursive, serif';
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      ctx.fillText(typedName, 20, 100);
      onSave(canvas.toDataURL('image/png'));
    }
    onClose();
  };

  const isInitials = fieldType === 'initials';
  const padW = isInitials ? 240 : 340;
  const padH = isInitials ? 100 : 140;

  return (
    <div className={s.modalOverlay} onClick={onClose}>
      <div className={s.modalCard} onClick={(e) => e.stopPropagation()}>
        <h3 className={s.modalTitle}>
          {isInitials ? 'Add Your Initials' : 'Add Your Signature'}
        </h3>

        <div className={s.sigModeToggle}>
          <button className={`${s.sigModeBtn} ${mode === 'draw' ? s.sigModeActive : ''}`} onClick={() => setMode('draw')}>
            Draw
          </button>
          <button className={`${s.sigModeBtn} ${mode === 'type' ? s.sigModeActive : ''}`} onClick={() => setMode('type')}>
            Type
          </button>
        </div>

        {mode === 'draw' ? (
          <div className={s.sigPadWrapper}>
            <canvas
              ref={canvasRef}
              width={padW * 2}
              height={padH * 2}
              style={{ width: padW, height: padH }}
              className={s.sigCanvas}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={stopDraw}
            />
            {!hasDrawn && <div className={s.sigPlaceholder}>{isInitials ? 'Draw your initials' : 'Draw your signature'}</div>}
          </div>
        ) : (
          <div>
            <input
              type="text"
              className={s.typeSignInput}
              placeholder={isInitials ? 'Type your initials' : 'Type your full name'}
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            {typedName && <div className={s.typeSignPreview}>{typedName}</div>}
          </div>
        )}

        <div className={s.modalActions}>
          <button className={s.secondaryBtn} onClick={clear}>Clear</button>
          <button className={s.secondaryBtn} onClick={onClose}>Cancel</button>
          <button
            className={s.primaryBtn}
            onClick={handleApply}
            disabled={mode === 'draw' ? !hasDrawn : !typedName.trim()}
          >
            Apply {isInitials ? 'Initials' : 'Signature'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PDF Page with Interactive Field Overlays ───
function DocumentPage({ pageData, fields, fieldValues, onFieldChange, onSignatureClick, allTemplateFields }) {
  return (
    <div style={{ position: 'relative', width: pageData.displayWidth, margin: '0 auto 16px' }}>
      <img
        src={pageData.dataUrl}
        alt={`Page ${pageData.pageNum}`}
        style={{ width: pageData.displayWidth, height: pageData.displayHeight, display: 'block', borderRadius: 4 }}
        draggable={false}
      />

      {fields.map((field) => {
        const displayX = field.x * pageData.scale;
        const displayY = field.y * pageData.scale;
        const displayW = (field.w || 100) * pageData.scale;
        const displayH = (field.h || 20) * pageData.scale;
        const value = fieldValues?.[field.id];

        if (field.type === 'signature' || field.type === 'initials') {
          return (
            <div
              key={field.id}
              onClick={() => onSignatureClick(field)}
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: value ? '2px solid #15803D' : '1.5px dashed rgba(46,78,141,0.5)',
                borderRadius: 3,
                background: value ? 'rgba(255,255,255,0.95)' : 'transparent',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => { if (!value) e.currentTarget.style.background = 'rgba(46,78,141,0.06)'; }}
              onMouseLeave={(e) => { if (!value) e.currentTarget.style.background = 'transparent'; }}
            >
              {value ? (
                <img src={value} alt="Signature" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
              ) : (
                <span style={{
                  fontSize: Math.max(9, 10 * pageData.scale), fontWeight: 600,
                  color: '#2E4E8D', opacity: 0.6,
                }}>
                  {field.type === 'initials' ? 'Tap to initial' : 'Tap to sign'}
                </span>
              )}
            </div>
          );
        }

        if (field.type === 'date') {
          return (
            <input
              key={field.id}
              data-field-id={field.id}
              type="text"
              value={value || ''}
              onChange={(e) => onFieldChange(field.id, e.target.value)}
              placeholder=""
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: value ? '1.5px solid #15803D' : '1.5px dashed rgba(234,88,12,0.5)',
                borderRadius: 2,
                background: 'transparent',
                fontSize: Math.max(10, 11 * pageData.scale),
                fontFamily: 'inherit', color: '#000',
                padding: '0 3px', boxSizing: 'border-box', outline: 'none',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onFocus={(e) => { e.target.style.background = 'rgba(255,255,255,0.9)'; e.target.style.borderColor = '#EA580C'; e.target.style.borderStyle = 'solid'; }}
              onBlur={(e) => { e.target.style.background = value ? 'transparent' : 'transparent'; e.target.style.borderColor = value ? '#15803D' : 'rgba(234,88,12,0.5)'; e.target.style.borderStyle = value ? 'solid' : 'dashed'; }}
            />
          );
        }

        if (field.type === 'text') {
          return (
            <input
              key={field.id}
              data-field-id={field.id}
              type="text"
              value={value || ''}
              onChange={(e) => onFieldChange(field.id, e.target.value)}
              placeholder=""
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: value ? '1.5px solid #15803D' : '1.5px dashed rgba(21,128,61,0.4)',
                borderRadius: 2,
                background: 'transparent',
                fontSize: Math.max(10, 11 * pageData.scale),
                fontFamily: 'inherit', color: '#000',
                padding: '0 3px', boxSizing: 'border-box', outline: 'none',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onFocus={(e) => { e.target.style.background = 'rgba(255,255,255,0.9)'; e.target.style.borderColor = '#15803D'; e.target.style.borderStyle = 'solid'; }}
              onBlur={(e) => { e.target.style.background = value ? 'transparent' : 'transparent'; e.target.style.borderColor = value ? '#15803D' : 'rgba(21,128,61,0.4)'; e.target.style.borderStyle = value ? 'solid' : 'dashed'; }}
            />
          );
        }

        if (field.type === 'checkbox') {
          const handleCheckboxClick = () => {
            if (field.group) {
              // Radio group behavior: select this one, deselect others in same group
              const groupFields = (allTemplateFields || []).filter(
                (f) => f.type === 'checkbox' && f.group === field.group
              );
              for (const gf of groupFields) {
                onFieldChange(gf.id, gf.id === field.id ? !value : false);
              }
            } else {
              // Independent checkbox: just toggle this one
              onFieldChange(field.id, !value);
            }
          };

          return (
            <div
              key={field.id}
              onClick={handleCheckboxClick}
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: value ? '2px solid #2E4E8D' : '1.5px dashed rgba(107,114,128,0.5)',
                borderRadius: 2,
                background: value ? '#2E4E8D' : 'transparent',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: Math.max(12, 14 * pageData.scale), fontWeight: 700,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {value ? '\u2713' : ''}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

// ─── Main Signing Page ───
export function SigningPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [envelopeData, setEnvelopeData] = useState(null);
  const [step, setStep] = useState('consent');
  const [currentDocIndex, setCurrentDocIndex] = useState(0);
  const [fieldValues, setFieldValues] = useState({});
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [signatureModal, setSignatureModal] = useState(null);
  const [renderedPages, setRenderedPages] = useState({});
  const [renderingPdf, setRenderingPdf] = useState(null);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    if (!token || !supabase) { setError('Invalid link.'); setLoading(false); return; }
    supabase.functions.invoke('esign', {
      body: { action: 'validate_signing', token },
    }).then(({ data, error: fnErr }) => {
      if (fnErr || data?.error) {
        if (data?.error === 'already_signed') { setStep('complete'); setEnvelopeData({ already_signed: true }); }
        else setError(data?.error || fnErr?.message || 'Invalid or expired link.');
      } else {
        setEnvelopeData(data);
        // Try to restore autosaved field values
        const storageKey = `tc_esign_autosave_${token}`;
        let restored = null;
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) restored = JSON.parse(saved);
        } catch (_) {}
        const initial = {};
        for (const tpl of (data.templates || [])) {
          initial[tpl.id] = {};
          for (const field of (tpl.fields || [])) {
            // Restore saved value if present (except signatures — they're data URLs)
            if (restored?.[tpl.id]?.[field.id] !== undefined) {
              initial[tpl.id][field.id] = restored[tpl.id][field.id];
            } else if (field.type === 'date') {
              initial[tpl.id][field.id] = new Date().toLocaleDateString('en-US');
            }
          }
        }
        setFieldValues(initial);
      }
      setLoading(false);
    });
  }, [token]);

  // Autosave field values to localStorage (debounced)
  useEffect(() => {
    if (!token || step !== 'signing' || !Object.keys(fieldValues).length) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(`tc_esign_autosave_${token}`, JSON.stringify(fieldValues));
      } catch (_) { /* storage full or unavailable */ }
    }, 500);
    return () => clearTimeout(timer);
  }, [fieldValues, token, step]);

  useEffect(() => {
    if (step === 'signing' && token && supabase) {
      supabase.functions.invoke('esign', { body: { action: 'record_view', token } }).catch(() => {});
    }
  }, [step, token]);

  // Render PDF pages for current template
  useEffect(() => {
    const templates = envelopeData?.templates || [];
    const tpl = templates[currentDocIndex];
    if (!tpl?.pdf_url || step !== 'signing' || renderedPages[tpl.id]) return;
    let cancelled = false;
    setRenderingPdf(tpl.id);
    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument(tpl.pdf_url).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const targetW = Math.min(window.innerWidth - 32, 620);
          const sc = targetW / vp.width;
          const svp = page.getViewport({ scale: sc });
          const canvas = document.createElement('canvas');
          canvas.width = svp.width;
          canvas.height = svp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: svp }).promise;
          pages.push({ dataUrl: canvas.toDataURL(), displayWidth: svp.width, displayHeight: svp.height, pageNum: i, scale: sc });
        }
        if (!cancelled) setRenderedPages((prev) => ({ ...prev, [tpl.id]: pages }));
      } catch (err) { console.error('PDF render error:', err); }
      finally { if (!cancelled) setRenderingPdf(null); }
    })();
    return () => { cancelled = true; };
  }, [envelopeData, currentDocIndex, step, renderedPages]);

  const updateFieldValue = useCallback((templateId, fieldId, value) => {
    setFieldValues((prev) => ({ ...prev, [templateId]: { ...(prev[templateId] || {}), [fieldId]: value } }));
  }, []);

  const applySignatureToAll = useCallback((sigDataUrl, fieldType) => {
    if (!envelopeData?.templates) return;
    setFieldValues((prev) => {
      const updated = { ...prev };
      for (const tpl of envelopeData.templates) {
        updated[tpl.id] = { ...(updated[tpl.id] || {}) };
        for (const field of (tpl.fields || [])) {
          if (field.type === fieldType) updated[tpl.id][field.id] = sigDataUrl;
        }
      }
      return updated;
    });
  }, [envelopeData]);

  // Returns list of missing required fields, or empty array if all filled
  const getMissingFields = useCallback(() => {
    if (!envelopeData?.templates) return [];
    const missing = [];
    for (const tpl of envelopeData.templates) {
      const checkedGroups = new Set(); // Track which checkbox groups we've already validated
      for (const field of (tpl.fields || [])) {
        if (!field.required) continue;

        // Grouped checkboxes: validate the group, not individual checkboxes
        if (field.type === 'checkbox' && field.group) {
          if (checkedGroups.has(field.group)) continue; // Already checked this group
          checkedGroups.add(field.group);
          const groupFields = (tpl.fields || []).filter(
            (f) => f.type === 'checkbox' && f.group === field.group
          );
          const anyChecked = groupFields.some((f) => fieldValues[tpl.id]?.[f.id]);
          if (!anyChecked) {
            missing.push({ template: tpl.name, label: `Selection (${field.group})`, fieldId: field.id, type: 'checkbox', page: field.page || 1 });
          }
          continue;
        }

        // Non-grouped checkboxes that are required (unusual but supported)
        // and all other field types
        if (!fieldValues[tpl.id]?.[field.id]) {
          const label = field.type === 'signature' ? 'Signature'
            : field.type === 'initials' ? 'Initials'
            : field.type === 'date' ? 'Date'
            : field.type === 'checkbox' ? 'Checkbox'
            : (field.label || 'Text field');
          missing.push({ template: tpl.name, label, fieldId: field.id, type: field.type, page: field.page || 1 });
        }
      }
    }
    return missing;
  }, [envelopeData, fieldValues]);

  const handleSubmit = async () => {
    if (!consentAgreed) { setSubmitError('Please check the consent box to confirm you agree to sign electronically.'); return; }

    // Collect current values from DOM inputs as a safety net
    // (in case React state didn't capture a value on mobile)
    setFieldValues((prev) => {
      const patched = { ...prev };
      for (const tpl of (envelopeData?.templates || [])) {
        patched[tpl.id] = { ...(patched[tpl.id] || {}) };
        for (const field of (tpl.fields || [])) {
          if (field.type === 'text' || field.type === 'date') {
            const inputEl = document.querySelector(`[data-field-id="${field.id}"]`);
            if (inputEl && inputEl.value && !patched[tpl.id][field.id]) {
              patched[tpl.id][field.id] = inputEl.value;
            }
          }
        }
      }
      return patched;
    });

    // Wait one tick for the state to settle
    await new Promise((r) => setTimeout(r, 50));

    const missing = getMissingFields();
    if (missing.length > 0) {
      const details = missing.map((m) => `${m.label} on "${m.template}" (page ${m.page || '?'}, id: ${m.fieldId.substring(0, 8)})`).join('; ');
      setSubmitError(`Missing ${missing.length} required field(s): ${details}`);
      return;
    }
    setSubmitting(true); setSubmitError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('esign', {
        body: { action: 'submit_signature', token, field_values: fieldValues, consent_agreed: true },
      });
      if (fnErr || data?.error) {
        if (data?.error === 'already_signed') { setStep('complete'); return; }
        throw new Error(data?.error || fnErr?.message || 'Submission failed');
      }
      // Clean up autosave on success
      try { localStorage.removeItem(`tc_esign_autosave_${token}`); } catch (_) {}
      setStep('complete');
    } catch (err) { setSubmitError(err.message || 'Failed to submit.'); }
    finally { setSubmitting(false); }
  };

  // Record ESIGN Act consent and proceed to signing
  const handleConsent = useCallback(async () => {
    if (!token || !supabase) return;
    try {
      await supabase.functions.invoke('esign', {
        body: { action: 'record_consent', token },
      });
    } catch (_) { /* non-blocking — consent still shown in audit trail */ }
    setStep('signing');
  }, [token]);

  // Decline signing with optional reason
  const handleDecline = useCallback(async () => {
    if (!token || !supabase) return;
    setDeclining(true);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('esign', {
        body: { action: 'decline', token, reason: declineReason.trim() || undefined },
      });
      if (fnErr || data?.error) throw new Error(data?.error || fnErr?.message);
      // Clean up autosave
      try { localStorage.removeItem(`tc_esign_autosave_${token}`); } catch (_) {}
      setStep('declined');
    } catch (err) {
      setSubmitError(err.message || 'Failed to decline.');
    } finally {
      setDeclining(false);
      setShowDeclineModal(false);
    }
  }, [token, declineReason]);

  const templates = envelopeData?.templates || [];
  const currentTemplate = templates[currentDocIndex];
  const currentPages = currentTemplate ? (renderedPages[currentTemplate.id] || []) : [];

  if (loading) {
    return (
      <div className={s.page}><div className={s.header}><div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div><div className={s.tagline}>Document Signing</div></div>
        <div className={s.card}><div className={s.loading}><div className={s.spinner} /><div>Loading documents...</div></div></div></div>
    );
  }
  if (error) {
    return (
      <div className={s.page}><div className={s.header}><div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div><div className={s.tagline}>Document Signing</div></div>
        <div className={s.card}><div className={s.expired}><div className={s.expiredIcon}>!</div><div className={s.expiredTitle}>Unable to Load</div><div className={s.expiredText}>{error}</div></div></div></div>
    );
  }
  if (step === 'complete') {
    return (
      <div className={s.page}><div className={s.header}><div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div><div className={s.tagline}>Document Signing</div></div>
        <div className={s.card}><div className={s.allDone}><div className={s.allDoneIcon}>&#10003;</div>
          <div className={s.allDoneTitle}>{envelopeData?.already_signed ? 'Already Signed' : 'Signing Complete!'}</div>
          <div className={s.allDoneText}>{envelopeData?.already_signed ? 'These documents have already been signed.' : 'Your documents have been signed and submitted successfully. A Certificate of Completion with tamper-evident document hashes has been generated. Copies have been uploaded to your file. Thank you!'}</div>
        </div></div><div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div></div>
    );
  }
  if (step === 'declined') {
    return (
      <div className={s.page}><div className={s.header}><div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div><div className={s.tagline}>Document Signing</div></div>
        <div className={s.card}><div className={s.allDone}><div className={s.allDoneIcon} style={{ background: '#FEE2E2', color: '#DC2626' }}>&#10005;</div>
          <div className={s.allDoneTitle}>Signing Declined</div>
          <div className={s.allDoneText}>You have declined to sign these documents. The sender has been notified. If this was a mistake, please contact your coordinator.</div>
        </div></div><div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div></div>
    );
  }
  if (step === 'consent') {
    return (
      <div className={s.page}><div className={s.header}><div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div><div className={s.tagline}>Document Signing</div>
          <div className={s.title}>Hi {envelopeData?.caregiver_name?.split(' ')[0] || 'there'}!</div>
          <div className={s.subtitle}>You have {templates.length} document{templates.length !== 1 ? 's' : ''} to review and sign.</div></div>
        <div className={s.card}><div className={s.consentSection}>
          <h3 className={s.consentTitle}>Electronic Signature Consent</h3>
          <p className={s.consentText}>By proceeding, you agree to review and electronically sign the following document{templates.length !== 1 ? 's' : ''}:</p>
          <ul className={s.docList}>{templates.map((t) => (<li key={t.id} className={s.docListItem}>{t.name}</li>))}</ul>
          <p className={s.consentText}>You agree that your electronic signature is the legal equivalent of your handwritten signature and that you consent to conduct this transaction electronically under the ESIGN Act (15 U.S.C. &sect; 7001).</p>
          <p className={s.consentText} style={{ fontSize: 12, marginTop: 4, color: '#6B7280' }}>You may withdraw this consent at any time by declining to sign.</p>
          <button className={s.primaryBtn} onClick={handleConsent}>Continue to Sign</button>
          <button className={s.secondaryBtn} onClick={() => setShowDeclineModal(true)} style={{ marginTop: 8, width: '100%', color: '#DC2626' }}>I decline to sign</button>
        </div></div>
        {showDeclineModal && (
          <div className={s.modalOverlay} onClick={() => setShowDeclineModal(false)}>
            <div className={s.modalCard} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
              <h3 className={s.modalTitle}>Decline to Sign</h3>
              <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 12 }}>Are you sure you want to decline? The sender will be notified.</p>
              <textarea
                placeholder="Reason for declining (optional)"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
              />
              <div className={s.modalActions}>
                <button className={s.secondaryBtn} onClick={() => setShowDeclineModal(false)}>Cancel</button>
                <button className={s.primaryBtn} onClick={handleDecline} disabled={declining} style={{ background: '#DC2626' }}>
                  {declining ? 'Declining...' : 'Confirm Decline'}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div></div>
    );
  }

  // ─── Signing (inline fields on PDF) ───
  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
        <div className={s.tagline}>Document Signing</div>
      </div>

      <div className={s.card} style={{ maxWidth: 700, padding: '24px 16px' }}>
        {templates.length > 1 && (
          <div className={s.docNav}>
            {templates.map((t, i) => {
              const filled = (t.fields || []).filter((f) => f.required).every((f) => fieldValues[t.id]?.[f.id]);
              return (
                <button key={t.id} className={`${s.docNavItem} ${i === currentDocIndex ? s.docNavActive : ''} ${filled ? s.docNavComplete : ''}`}
                  onClick={() => setCurrentDocIndex(i)}>
                  {filled ? '\u2713 ' : ''}{i + 1}. {t.name}
                </button>
              );
            })}
          </div>
        )}

        {currentTemplate && (
          <>
            <h3 className={s.docTitle}>{currentTemplate.name}</h3>

            {renderingPdf === currentTemplate?.id && currentPages.length === 0 && (
              <div className={s.loading} style={{ padding: 40 }}><div className={s.spinner} /><div>Rendering document...</div></div>
            )}

            <div style={{ border: '1px solid #D5DCE6', borderRadius: 8, overflow: 'hidden', background: '#F9FAFB' }}>
              {currentPages.map((pageData) => {
                const pageFields = (currentTemplate.fields || []).filter((f) => (f.page || 1) === pageData.pageNum);
                return (
                  <DocumentPage
                    key={pageData.pageNum}
                    pageData={pageData}
                    fields={pageFields}
                    fieldValues={fieldValues[currentTemplate.id] || {}}
                    onFieldChange={(fieldId, value) => updateFieldValue(currentTemplate.id, fieldId, value)}
                    onSignatureClick={(field) => setSignatureModal({ templateId: currentTemplate.id, field })}
                    allTemplateFields={currentTemplate.fields || []}
                  />
                );
              })}
            </div>

            <div className={s.navButtons}>
              {currentDocIndex > 0 && (
                <button className={s.secondaryBtn} onClick={() => setCurrentDocIndex((i) => i - 1)}>Previous</button>
              )}
              {currentDocIndex < templates.length - 1 && (
                <button className={s.primaryBtn} onClick={() => setCurrentDocIndex((i) => i + 1)}>Next Document</button>
              )}
            </div>

            {currentDocIndex === templates.length - 1 && (
              <div className={s.submitSection}>
                <label className={s.consentCheckbox}>
                  <input type="checkbox" checked={consentAgreed} onChange={(e) => setConsentAgreed(e.target.checked)} />
                  <span>I agree to sign {templates.length > 1 ? 'these documents' : 'this document'} electronically. My electronic signature is the legal equivalent of my handwritten signature.</span>
                </label>
                {submitError && <div className={s.errorBanner}>{submitError}</div>}
                <button className={s.submitBtn} onClick={handleSubmit} disabled={submitting}>
                  {submitting ? (<><span className={s.spinnerSmall} /> Submitting...</>) : `Complete Signing (${templates.length} document${templates.length !== 1 ? 's' : ''})`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {signatureModal && (
        <SignatureModal
          fieldType={signatureModal.field.type}
          onSave={(dataUrl) => applySignatureToAll(dataUrl, signatureModal.field.type)}
          onClose={() => setSignatureModal(null)}
        />
      )}

      <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div>
    </div>
  );
}
