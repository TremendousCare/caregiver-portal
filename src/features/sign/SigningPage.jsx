import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import s from './SigningPage.module.css';

// ─── Signature Pad (canvas-based drawing) ───
function SignaturePad({ onSave, width = 320, height = 120 }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  const getPos = useCallback((e) => {
    const canvas = canvasRef.current;
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
    const ctx = canvasRef.current.getContext('2d');
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
    setHasDrawn(true);
  }, [getPos]);

  const draw = useCallback((e) => {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const pos = getPos(e);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }, [drawing, getPos]);

  const stopDraw = useCallback(() => {
    if (!drawing) return;
    setDrawing(false);
    if (onSave && canvasRef.current) {
      onSave(canvasRef.current.toDataURL('image/png'));
    }
  }, [drawing, onSave]);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
    if (onSave) onSave(null);
  }, [onSave]);

  return (
    <div className={s.sigPadWrapper}>
      <canvas
        ref={canvasRef}
        width={width * 2}
        height={height * 2}
        style={{ width, height }}
        className={s.sigCanvas}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={stopDraw}
        onMouseLeave={stopDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={stopDraw}
      />
      {hasDrawn && (
        <button type="button" className={s.sigClearBtn} onClick={clear}>Clear</button>
      )}
      {!hasDrawn && <div className={s.sigPlaceholder}>Draw your signature above</div>}
    </div>
  );
}

// ─── Type-to-Sign ───
function TypeSignature({ onSave }) {
  const [text, setText] = useState('');

  const handleChange = (e) => {
    setText(e.target.value);
    // Convert typed text to a data URL via a temporary canvas
    if (e.target.value.trim()) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'italic 48px "Dancing Script", "Brush Script MT", cursive, serif';
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.target.value, 20, 100);
      onSave(canvas.toDataURL('image/png'));
    } else {
      onSave(null);
    }
  };

  return (
    <div className={s.typeSignWrapper}>
      <input
        type="text"
        className={s.typeSignInput}
        placeholder="Type your full name"
        value={text}
        onChange={handleChange}
        autoComplete="off"
      />
      {text && (
        <div className={s.typeSignPreview}>{text}</div>
      )}
    </div>
  );
}

// ─── Main Signing Page ───
export function SigningPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [envelopeData, setEnvelopeData] = useState(null);
  const [step, setStep] = useState('consent'); // consent | signing | complete
  const [currentDocIndex, setCurrentDocIndex] = useState(0);
  const [fieldValues, setFieldValues] = useState({}); // { templateId: { fieldId: value } }
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [sigMode, setSigMode] = useState('draw'); // draw | type
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Validate token on mount
  useEffect(() => {
    if (!token || !supabase) {
      setError('Invalid link.');
      setLoading(false);
      return;
    }

    supabase.functions.invoke('esign', {
      body: { action: 'validate_signing', token },
    }).then(({ data, error: fnErr }) => {
      if (fnErr || data?.error) {
        if (data?.error === 'already_signed') {
          setStep('complete');
          setEnvelopeData({ already_signed: true });
        } else {
          setError(data?.error || fnErr?.message || 'Invalid or expired link.');
        }
      } else {
        setEnvelopeData(data);
        // Initialize field values with auto-fills
        const initial = {};
        for (const tpl of (data.templates || [])) {
          initial[tpl.id] = {};
          for (const field of (tpl.fields || [])) {
            if (field.type === 'date') {
              initial[tpl.id][field.id] = new Date().toLocaleDateString('en-US');
            }
          }
        }
        setFieldValues(initial);
      }
      setLoading(false);
    });
  }, [token]);

  // Record view when entering signing step
  useEffect(() => {
    if (step === 'signing' && token && supabase) {
      supabase.functions.invoke('esign', {
        body: { action: 'record_view', token },
      }).catch(() => { /* fire-and-forget */ });
    }
  }, [step, token]);

  const updateFieldValue = useCallback((templateId, fieldId, value) => {
    setFieldValues((prev) => ({
      ...prev,
      [templateId]: { ...(prev[templateId] || {}), [fieldId]: value },
    }));
  }, []);

  // Apply signature to all signature fields across all templates
  const applySignatureToAll = useCallback((sigDataUrl, fieldType = 'signature') => {
    if (!envelopeData?.templates) return;
    setFieldValues((prev) => {
      const updated = { ...prev };
      for (const tpl of envelopeData.templates) {
        updated[tpl.id] = { ...(updated[tpl.id] || {}) };
        for (const field of (tpl.fields || [])) {
          if (field.type === fieldType) {
            updated[tpl.id][field.id] = sigDataUrl;
          }
        }
      }
      return updated;
    });
  }, [envelopeData]);

  // Check if all required fields are filled
  const allRequiredFilled = useCallback(() => {
    if (!envelopeData?.templates) return false;
    for (const tpl of envelopeData.templates) {
      for (const field of (tpl.fields || [])) {
        if (field.required) {
          const val = fieldValues[tpl.id]?.[field.id];
          if (!val) return false;
        }
      }
    }
    return true;
  }, [envelopeData, fieldValues]);

  const handleSubmit = async () => {
    if (!consentAgreed) {
      setSubmitError('Please check the consent box to confirm you agree to sign electronically.');
      return;
    }
    if (!allRequiredFilled()) {
      setSubmitError('Please complete all required fields (signature, date) before submitting.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('esign', {
        body: {
          action: 'submit_signature',
          token,
          field_values: fieldValues,
          consent_agreed: true,
        },
      });

      if (fnErr || data?.error) {
        if (data?.error === 'already_signed') {
          setStep('complete');
          return;
        }
        throw new Error(data?.error || fnErr?.message || 'Submission failed');
      }

      setStep('complete');
    } catch (err) {
      setSubmitError(err.message || 'Failed to submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const templates = envelopeData?.templates || [];
  const currentTemplate = templates[currentDocIndex];

  // ─── Render ───

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
          <div className={s.tagline}>Document Signing</div>
        </div>
        <div className={s.card}>
          <div className={s.loading}>
            <div className={s.spinner} />
            <div>Loading documents...</div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
          <div className={s.tagline}>Document Signing</div>
        </div>
        <div className={s.card}>
          <div className={s.expired}>
            <div className={s.expiredIcon}>!</div>
            <div className={s.expiredTitle}>Unable to Load</div>
            <div className={s.expiredText}>{error}</div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Complete ───
  if (step === 'complete') {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
          <div className={s.tagline}>Document Signing</div>
        </div>
        <div className={s.card}>
          <div className={s.allDone}>
            <div className={s.allDoneIcon}>&#10003;</div>
            <div className={s.allDoneTitle}>
              {envelopeData?.already_signed ? 'Already Signed' : 'Signing Complete!'}
            </div>
            <div className={s.allDoneText}>
              {envelopeData?.already_signed
                ? 'These documents have already been signed. No further action is needed.'
                : 'Your documents have been signed and submitted successfully. Copies have been uploaded to your file. Thank you!'}
            </div>
          </div>
        </div>
        <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div>
      </div>
    );
  }

  // ─── Consent ───
  if (step === 'consent') {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
          <div className={s.tagline}>Document Signing</div>
          <div className={s.title}>Hi {envelopeData?.caregiver_name?.split(' ')[0] || 'there'}!</div>
          <div className={s.subtitle}>
            You have {templates.length} document{templates.length !== 1 ? 's' : ''} to review and sign.
          </div>
        </div>
        <div className={s.card}>
          <div className={s.consentSection}>
            <h3 className={s.consentTitle}>Electronic Signature Consent</h3>
            <p className={s.consentText}>
              By proceeding, you agree to review and electronically sign the following document{templates.length !== 1 ? 's' : ''}:
            </p>
            <ul className={s.docList}>
              {templates.map((t) => (
                <li key={t.id} className={s.docListItem}>{t.name}</li>
              ))}
            </ul>
            <p className={s.consentText}>
              You agree that your electronic signature is the legal equivalent of your handwritten signature
              and that you consent to conduct this transaction electronically under the ESIGN Act (15 U.S.C. &sect; 7001).
            </p>
            <button className={s.primaryBtn} onClick={() => setStep('signing')}>
              Continue to Sign
            </button>
          </div>
        </div>
        <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div>
      </div>
    );
  }

  // ─── Signing ───
  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
        <div className={s.tagline}>Document Signing</div>
      </div>

      <div className={s.card}>
        {/* Document navigation */}
        {templates.length > 1 && (
          <div className={s.docNav}>
            {templates.map((t, i) => {
              const filled = (t.fields || []).filter((f) => f.required).every((f) => fieldValues[t.id]?.[f.id]);
              return (
                <button
                  key={t.id}
                  className={`${s.docNavItem} ${i === currentDocIndex ? s.docNavActive : ''} ${filled ? s.docNavComplete : ''}`}
                  onClick={() => setCurrentDocIndex(i)}
                >
                  {filled ? '\u2713 ' : ''}{i + 1}. {t.name}
                </button>
              );
            })}
          </div>
        )}

        {currentTemplate && (
          <>
            <h3 className={s.docTitle}>{currentTemplate.name}</h3>

            {/* PDF viewer — rendered in iframe */}
            {currentTemplate.pdf_url && (
              <div className={s.pdfViewer}>
                <iframe
                  src={`${currentTemplate.pdf_url}#toolbar=0`}
                  className={s.pdfFrame}
                  title={currentTemplate.name}
                />
              </div>
            )}

            {/* Signature fields for this document */}
            <div className={s.fieldsSection}>
              <h4 className={s.fieldsTitle}>Complete the fields below</h4>

              {(currentTemplate.fields || []).map((field) => (
                <div key={field.id} className={s.fieldRow}>
                  <label className={s.fieldLabel}>
                    {field.type === 'signature' ? 'Signature' :
                     field.type === 'initials' ? 'Initials' :
                     field.type === 'date' ? 'Date' :
                     field.type === 'checkbox' ? (field.label || 'Checkbox') :
                     (field.label || 'Text')}
                    {field.required && <span className={s.requiredMark}>*</span>}
                  </label>

                  {(field.type === 'signature' || field.type === 'initials') && (
                    <div>
                      <div className={s.sigModeToggle}>
                        <button
                          type="button"
                          className={`${s.sigModeBtn} ${sigMode === 'draw' ? s.sigModeActive : ''}`}
                          onClick={() => setSigMode('draw')}
                        >Draw</button>
                        <button
                          type="button"
                          className={`${s.sigModeBtn} ${sigMode === 'type' ? s.sigModeActive : ''}`}
                          onClick={() => setSigMode('type')}
                        >Type</button>
                      </div>
                      {sigMode === 'draw' ? (
                        <SignaturePad
                          width={field.type === 'initials' ? 160 : 320}
                          height={field.type === 'initials' ? 80 : 120}
                          onSave={(dataUrl) => {
                            applySignatureToAll(dataUrl, field.type);
                          }}
                        />
                      ) : (
                        <TypeSignature
                          onSave={(dataUrl) => {
                            applySignatureToAll(dataUrl, field.type);
                          }}
                        />
                      )}
                      {fieldValues[currentTemplate.id]?.[field.id] && (
                        <div className={s.fieldCheck}>&#10003; Applied to all documents</div>
                      )}
                    </div>
                  )}

                  {field.type === 'date' && (
                    <input
                      type="text"
                      className={s.fieldInput}
                      value={fieldValues[currentTemplate.id]?.[field.id] || ''}
                      onChange={(e) => updateFieldValue(currentTemplate.id, field.id, e.target.value)}
                      placeholder="MM/DD/YYYY"
                    />
                  )}

                  {field.type === 'text' && (
                    <input
                      type="text"
                      className={s.fieldInput}
                      value={fieldValues[currentTemplate.id]?.[field.id] || ''}
                      onChange={(e) => updateFieldValue(currentTemplate.id, field.id, e.target.value)}
                      placeholder={field.label || 'Enter text'}
                    />
                  )}

                  {field.type === 'checkbox' && (
                    <label className={s.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={!!fieldValues[currentTemplate.id]?.[field.id]}
                        onChange={(e) => updateFieldValue(currentTemplate.id, field.id, e.target.checked)}
                      />
                      <span>{field.label || 'I agree'}</span>
                    </label>
                  )}
                </div>
              ))}
            </div>

            {/* Document navigation buttons */}
            <div className={s.navButtons}>
              {currentDocIndex > 0 && (
                <button className={s.secondaryBtn} onClick={() => setCurrentDocIndex((i) => i - 1)}>
                  Previous
                </button>
              )}
              {currentDocIndex < templates.length - 1 ? (
                <button className={s.primaryBtn} onClick={() => setCurrentDocIndex((i) => i + 1)}>
                  Next Document
                </button>
              ) : (
                <>
                  {/* Final consent + submit */}
                  <div style={{ flex: 1 }} />
                </>
              )}
            </div>

            {/* Show submit section on last document */}
            {currentDocIndex === templates.length - 1 && (
              <div className={s.submitSection}>
                <label className={s.consentCheckbox}>
                  <input
                    type="checkbox"
                    checked={consentAgreed}
                    onChange={(e) => setConsentAgreed(e.target.checked)}
                  />
                  <span>
                    I agree to sign {templates.length > 1 ? 'these documents' : 'this document'} electronically.
                    My electronic signature is the legal equivalent of my handwritten signature.
                  </span>
                </label>

                {submitError && <div className={s.errorBanner}>{submitError}</div>}

                <button
                  className={s.submitBtn}
                  onClick={handleSubmit}
                  disabled={submitting || !consentAgreed || !allRequiredFilled()}
                >
                  {submitting ? (
                    <><span className={s.spinnerSmall} /> Submitting...</>
                  ) : (
                    `Complete Signing (${templates.length} document${templates.length !== 1 ? 's' : ''})`
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className={s.footer}>Tremendous Care &middot; Secure Electronic Signatures</div>
    </div>
  );
}
