import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import s from './SigningPage.module.css';
import { isRadioGroupMember, getRequiredGroupViolations } from '../../lib/esignCheckboxGroups.js';

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
function DocumentPage({ pageData, fields, fieldValues, onFieldChange, onSignatureClick, allTemplateFields, activeFieldId, onFieldComplete }) {
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
        const isActive = field.id === activeFieldId && !value;

        if (field.type === 'signature' || field.type === 'initials') {
          return (
            <div
              key={field.id}
              data-field-id={field.id}
              onClick={() => onSignatureClick(field)}
              className={isActive ? s.guideActiveField : undefined}
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: isActive ? '2px solid #EAB308' : (value ? '2px solid #15803D' : '1.5px dashed rgba(46,78,141,0.5)'),
                borderRadius: 3,
                background: value ? 'rgba(255,255,255,0.95)' : (isActive ? 'rgba(234,179,8,0.08)' : 'transparent'),
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => { if (!value && !isActive) e.currentTarget.style.background = 'rgba(46,78,141,0.06)'; }}
              onMouseLeave={(e) => { if (!value) e.currentTarget.style.background = isActive ? 'rgba(234,179,8,0.08)' : 'transparent'; }}
            >
              {value ? (
                <img src={value} alt="Signature" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
              ) : (
                <span style={{
                  fontSize: Math.max(9, 10 * pageData.scale), fontWeight: 600,
                  color: isActive ? '#92400E' : '#2E4E8D', opacity: isActive ? 0.9 : 0.6,
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
              className={isActive ? s.guideActiveField : undefined}
              placeholder=""
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: isActive ? '2px solid #EAB308' : (value ? '1.5px solid #15803D' : '1.5px dashed rgba(234,88,12,0.5)'),
                borderRadius: 2,
                background: isActive ? 'rgba(234,179,8,0.08)' : 'transparent',
                fontSize: Math.max(10, 11 * pageData.scale),
                fontFamily: 'inherit', color: '#000',
                padding: '0 3px', boxSizing: 'border-box', outline: 'none',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onFocus={(e) => { e.target.style.background = 'rgba(255,255,255,0.9)'; e.target.style.borderColor = '#EA580C'; e.target.style.borderStyle = 'solid'; }}
              onBlur={(e) => { e.target.style.background = 'transparent'; e.target.style.borderColor = value ? '#15803D' : 'rgba(234,88,12,0.5)'; e.target.style.borderStyle = value ? 'solid' : 'dashed'; if (e.target.value && onFieldComplete) onFieldComplete(); }}
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
              className={isActive ? s.guideActiveField : undefined}
              placeholder=""
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: isActive ? '2px solid #EAB308' : (value ? '1.5px solid #15803D' : '1.5px dashed rgba(21,128,61,0.4)'),
                borderRadius: 2,
                background: isActive ? 'rgba(234,179,8,0.08)' : 'transparent',
                fontSize: Math.max(10, 11 * pageData.scale),
                fontFamily: 'inherit', color: '#000',
                padding: '0 3px', boxSizing: 'border-box', outline: 'none',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onFocus={(e) => { e.target.style.background = 'rgba(255,255,255,0.9)'; e.target.style.borderColor = '#15803D'; e.target.style.borderStyle = 'solid'; }}
              onBlur={(e) => { e.target.style.background = 'transparent'; e.target.style.borderColor = value ? '#15803D' : 'rgba(21,128,61,0.4)'; e.target.style.borderStyle = value ? 'solid' : 'dashed'; if (e.target.value && onFieldComplete) onFieldComplete(); }}
            />
          );
        }

        if (field.type === 'checkbox') {
          const isRadio = isRadioGroupMember(field, allTemplateFields);
          const groupMembers = isRadio
            ? (allTemplateFields || []).filter((f) => f.type === 'checkbox' && f.group === field.group)
            : null;
          const groupIsRequired = isRadio && groupMembers.some((f) => f.required === true);

          const handleCheckboxClick = () => {
            if (isRadio) {
              // Required radio groups lock the current selection — you can
              // switch, but clicking the already-checked option is a no-op
              // (prevents accidentally emptying a required group).
              if (value && groupIsRequired) return;
              for (const gf of groupMembers) {
                onFieldChange(gf.id, gf.id === field.id ? !value : false);
              }
            } else {
              onFieldChange(field.id, !value);
            }
            if (!value && onFieldComplete) onFieldComplete();
          };

          if (isRadio) {
            // Circle (radio button) rendering — universal "pick one" affordance.
            const diameter = Math.min(displayW, displayH);
            return (
              <div
                key={field.id}
                data-field-id={field.id}
                onClick={handleCheckboxClick}
                className={isActive ? s.guideActiveField : undefined}
                style={{
                  position: 'absolute', left: displayX, top: displayY,
                  width: displayW, height: displayH,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: diameter, height: diameter, borderRadius: '50%',
                    border: isActive ? '2px solid #EAB308' : '2px solid #2E4E8D',
                    background: isActive ? 'rgba(234,179,8,0.15)' : 'rgba(219,234,254,0.7)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: isActive ? undefined : '0 0 0 2px rgba(46,78,141,0.15)',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                    boxSizing: 'border-box',
                  }}
                >
                  {value && (
                    <div style={{
                      width: '55%', height: '55%', borderRadius: '50%', background: '#2E4E8D',
                    }} />
                  )}
                </div>
              </div>
            );
          }

          return (
            <div
              key={field.id}
              data-field-id={field.id}
              onClick={handleCheckboxClick}
              className={isActive ? s.guideActiveField : undefined}
              style={{
                position: 'absolute', left: displayX, top: displayY,
                width: displayW, height: displayH,
                border: isActive ? '2px solid #EAB308' : (value ? '2px solid #2E4E8D' : '2px solid #2E4E8D'),
                borderRadius: 3,
                background: value ? '#2E4E8D' : (isActive ? 'rgba(234,179,8,0.15)' : 'rgba(219,234,254,0.7)'),
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: value ? '#fff' : '#2E4E8D',
                fontSize: Math.max(12, 14 * pageData.scale), fontWeight: 700,
                boxShadow: value ? 'none' : (isActive ? undefined : '0 0 0 2px rgba(46,78,141,0.15)'),
                transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
              }}
            >
              {value ? '\u2713' : '\u2610'}
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
  const [pendingAdvance, setPendingAdvance] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const initialScrollDone = useRef(false);

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
          const dpr = window.devicePixelRatio || 1;
          const renderVp = page.getViewport({ scale: sc * dpr });
          const displayVp = page.getViewport({ scale: sc });
          const canvas = document.createElement('canvas');
          canvas.width = renderVp.width;
          canvas.height = renderVp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;
          pages.push({ dataUrl: canvas.toDataURL(), displayWidth: displayVp.width, displayHeight: displayVp.height, pageNum: i, scale: sc });
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
      // Required checkbox groups: one entry per empty group
      for (const violation of getRequiredGroupViolations(tpl.fields || [], fieldValues[tpl.id] || {})) {
        missing.push({
          template: tpl.name,
          label: `Selection (${violation.groupName})`,
          fieldId: violation.fieldId,
          type: 'checkbox',
          page: violation.page,
        });
      }

      // Everything else (signatures, initials, dates, text, ungrouped required checkboxes)
      for (const field of (tpl.fields || [])) {
        if (!field.required) continue;
        if (field.type === 'checkbox' && field.group && field.group.trim()) continue; // handled above
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

  // ─── Download Signed Documents ───
  const handleDownload = useCallback(async () => {
    if (!envelopeData?.templates?.length) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const mergedPdf = await PDFDocument.create();
      for (const tpl of envelopeData.templates) {
        const pdfBytes = await fetch(tpl.pdf_url).then((r) => r.arrayBuffer());
        const srcPdf = await PDFDocument.load(pdfBytes);
        const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());

        for (let pageIdx = 0; pageIdx < copiedPages.length; pageIdx++) {
          const page = copiedPages[pageIdx];
          mergedPdf.addPage(page);
          const { height } = page.getSize();
          const pageFields = (tpl.fields || []).filter((f) => (f.page || 1) === pageIdx + 1);

          for (const field of pageFields) {
            const value = fieldValues[tpl.id]?.[field.id];
            if (!value) continue;
            const fx = field.x;
            const fy = height - field.y - (field.h || 20);
            const fw = field.w || 100;
            const fh = field.h || 20;

            if (field.type === 'signature' || field.type === 'initials') {
              const base64 = value.split(',')[1];
              const imgBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
              const img = await mergedPdf.embedPng(imgBytes);
              page.drawImage(img, { x: fx, y: fy, width: fw, height: fh });
            } else if (field.type === 'text' || field.type === 'date') {
              const fontSize = Math.min(12, fh * 0.6);
              page.drawText(String(value), {
                x: fx + 2, y: fy + fh * 0.3,
                size: fontSize, color: rgb(0, 0, 0),
              });
            } else if (field.type === 'checkbox' && value) {
              // Draw checkmark with two lines
              page.drawLine({
                start: { x: fx + fw * 0.2, y: fy + fh * 0.45 },
                end: { x: fx + fw * 0.4, y: fy + fh * 0.2 },
                thickness: 2, color: rgb(0.18, 0.31, 0.55),
              });
              page.drawLine({
                start: { x: fx + fw * 0.4, y: fy + fh * 0.2 },
                end: { x: fx + fw * 0.8, y: fy + fh * 0.8 },
                thickness: 2, color: rgb(0.18, 0.31, 0.55),
              });
            }
          }
        }
      }

      const finalBytes = await mergedPdf.save();
      const blob = new Blob([finalBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const name = envelopeData.caregiver_name?.replace(/\s+/g, '_') || 'Signed';
      a.download = `${name}_Signed_Documents.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
      setDownloadError('Unable to generate download. Your signed documents have been saved — contact your coordinator if you need a copy.');
    } finally {
      setDownloading(false);
    }
  }, [envelopeData, fieldValues]);

  // ─── Guided Signing Flow ───
  const orderedRequiredFields = useMemo(() => {
    if (!envelopeData?.templates) return [];
    const result = [];
    const seenGroups = new Set();
    envelopeData.templates.forEach((tpl, tplIdx) => {
      for (const f of (tpl.fields || [])) {
        if (!f.required) continue;
        if (f.type === 'checkbox' && f.group) {
          const gk = `${tpl.id}:${f.group}`;
          if (seenGroups.has(gk)) continue;
          seenGroups.add(gk);
        }
        result.push({
          templateId: tpl.id, templateIndex: tplIdx, fieldId: f.id, field: f,
          page: f.page || 1, y: f.y || 0, x: f.x || 0, type: f.type,
          label: f.type === 'signature' ? 'Sign here' : f.type === 'initials' ? 'Add initials'
            : f.type === 'date' ? 'Enter date' : f.type === 'checkbox' ? 'Check box'
            : (f.label || 'Fill in field'),
          group: f.group,
        });
      }
    });
    result.sort((a, b) => a.templateIndex - b.templateIndex || a.page - b.page || a.y - b.y || a.x - b.x);
    return result;
  }, [envelopeData]);

  const isGuideFieldComplete = useCallback((entry) => {
    const vals = fieldValues[entry.templateId] || {};
    if (entry.type === 'checkbox' && entry.group) {
      const tpl = envelopeData?.templates?.find(t => t.id === entry.templateId);
      return (tpl?.fields || []).filter(f => f.type === 'checkbox' && f.group === entry.group).some(f => vals[f.id]);
    }
    return !!vals[entry.fieldId];
  }, [fieldValues, envelopeData]);

  const totalRequired = orderedRequiredFields.length;
  const completedCount = orderedRequiredFields.filter(e => isGuideFieldComplete(e)).length;
  const nextIncomplete = useMemo(() => orderedRequiredFields.find(e => !isGuideFieldComplete(e)) || null, [orderedRequiredFields, isGuideFieldComplete]);
  const activeFieldId = nextIncomplete?.fieldId || null;

  useEffect(() => {
    if (!pendingAdvance) return;
    setPendingAdvance(false);
    if (!nextIncomplete) {
      setTimeout(() => {
        const el = document.querySelector('[data-section="submit"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return;
    }
    if (nextIncomplete.templateIndex !== currentDocIndex) {
      setCurrentDocIndex(nextIncomplete.templateIndex);
    }
    const fid = nextIncomplete.fieldId;
    const tryScroll = () => {
      const el = document.querySelector(`[data-field-id="${fid}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el.tagName === 'INPUT') setTimeout(() => el.focus(), 400);
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      const t1 = setTimeout(tryScroll, 300);
      const t2 = setTimeout(tryScroll, 800);
      const t3 = setTimeout(tryScroll, 1500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, [pendingAdvance, nextIncomplete, currentDocIndex]);

  const handleGuideNext = useCallback(() => {
    if (!nextIncomplete) {
      const el = document.querySelector('[data-section="submit"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (nextIncomplete.templateIndex !== currentDocIndex) {
      setCurrentDocIndex(nextIncomplete.templateIndex);
    }
    const fid = nextIncomplete.fieldId;
    const tryScroll = () => {
      const el = document.querySelector(`[data-field-id="${fid}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el.tagName === 'INPUT') setTimeout(() => el.focus(), 400);
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      setTimeout(tryScroll, 300);
      setTimeout(tryScroll, 800);
    }
  }, [nextIncomplete, currentDocIndex]);

  const handleGuideBack = useCallback(() => {
    const currentIdx = nextIncomplete
      ? orderedRequiredFields.indexOf(nextIncomplete)
      : orderedRequiredFields.length;
    if (currentIdx <= 0) return;
    const prevEntry = orderedRequiredFields[currentIdx - 1];
    if (prevEntry.templateIndex !== currentDocIndex) {
      setCurrentDocIndex(prevEntry.templateIndex);
    }
    const fid = prevEntry.fieldId;
    const tryScroll = () => {
      const el = document.querySelector(`[data-field-id="${fid}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el.tagName === 'INPUT') setTimeout(() => el.focus(), 400);
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      setTimeout(tryScroll, 300);
      setTimeout(tryScroll, 800);
    }
  }, [nextIncomplete, orderedRequiredFields, currentDocIndex]);

  // Auto-scroll to first required field when entering signing mode
  useEffect(() => {
    if (step !== 'signing' || initialScrollDone.current || !nextIncomplete) return;
    const tpl = envelopeData?.templates?.[nextIncomplete.templateIndex];
    if (!tpl || !renderedPages[tpl.id]?.length) return;
    initialScrollDone.current = true;
    const fid = nextIncomplete.fieldId;
    setTimeout(() => {
      const el = document.querySelector(`[data-field-id="${fid}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el.tagName === 'INPUT') setTimeout(() => el.focus(), 400);
      }
    }, 500);
  }, [step, nextIncomplete, renderedPages, envelopeData]);

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
          {!envelopeData?.already_signed && envelopeData?.templates?.length > 0 && (
            <div className={s.downloadSection}>
              <button className={s.downloadBtn} onClick={handleDownload} disabled={downloading}>
                {downloading ? (<><span className={s.spinnerSmall} /> Preparing...</>) : 'Download Signed Documents'}
              </button>
              {downloadError && <div className={s.downloadError}>{downloadError}</div>}
            </div>
          )}
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
    <div className={s.page} style={totalRequired > 0 ? { paddingBottom: 120 } : undefined}>
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
                    activeFieldId={activeFieldId}
                    onFieldComplete={() => setPendingAdvance(true)}
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
              <div className={s.submitSection} data-section="submit">
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
          onSave={(dataUrl) => {
            applySignatureToAll(dataUrl, signatureModal.field.type);
            setPendingAdvance(true);
          }}
          onClose={() => setSignatureModal(null)}
        />
      )}

      {totalRequired > 0 && (
        <div className={s.guideBar}>
          <div className={s.guideProgressBar}>
            <div className={s.guideProgressFill} style={{ width: `${(completedCount / totalRequired) * 100}%` }} />
          </div>
          <div className={s.guideContent}>
            <div className={s.guideText}>
              {nextIncomplete ? (
                <>
                  <span className={s.guideStep}>Step {completedCount + 1} of {totalRequired}</span>
                  <span className={s.guideLabel}>
                    {nextIncomplete.label}
                    {templates.length > 1 && <span style={{ opacity: 0.7 }}>{' \u2014 '}{templates[nextIncomplete.templateIndex]?.name}</span>}
                  </span>
                </>
              ) : (
                <>
                  <span className={s.guideStep} style={{ color: '#15803D' }}>All {totalRequired} fields complete!</span>
                  <span className={s.guideLabel}>Ready to submit</span>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {completedCount > 0 && nextIncomplete && (
                <button className={s.guideBackBtn} onClick={handleGuideBack}>{'\u2190'} Back</button>
              )}
              <button
                className={s.guideBtn}
                onClick={handleGuideNext}
                style={!nextIncomplete ? { background: 'linear-gradient(135deg, #15803D, #16A34A)' } : undefined}
              >
                {nextIncomplete ? 'Next \u2192' : 'Review & Submit \u2192'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div>
    </div>
  );
}
