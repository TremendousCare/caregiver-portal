import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { UPLOADABLE_DOCUMENT_TYPES } from '../../lib/constants';
import s from './UploadPage.module.css';

const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.heic'];

function getDocLabel(typeId) {
  return UPLOADABLE_DOCUMENT_TYPES.find((t) => t.id === typeId)?.label || typeId;
}

export function UploadPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tokenData, setTokenData] = useState(null);

  // Per-document state: { [docTypeId]: { file, uploading, uploaded, error } }
  const [docStates, setDocStates] = useState({});
  const fileInputRefs = useRef({});

  // Validate token on mount
  useEffect(() => {
    if (!token || !supabase) {
      setError('Invalid link.');
      setLoading(false);
      return;
    }

    supabase.functions.invoke('caregiver-doc-upload', {
      body: { action: 'validate_token', token },
    }).then(({ data, error: fnErr }) => {
      if (fnErr || data?.error) {
        setError(data?.error || fnErr?.message || 'Invalid or expired link.');
      } else {
        setTokenData(data);
        // Initialize doc states — mark already-uploaded docs
        const states = {};
        const requestedTypes = data.requested_types || [];
        for (const typeId of requestedTypes) {
          const existing = (data.uploaded_docs || []).find((d) => d.document_type === typeId);
          states[typeId] = {
            file: null,
            uploading: false,
            uploaded: !!existing,
            uploadedFile: existing?.file_name || null,
            uploadedAt: existing?.uploaded_at || null,
            error: null,
          };
        }
        setDocStates(states);
      }
      setLoading(false);
    });
  }, [token]);

  const updateDocState = useCallback((typeId, updates) => {
    setDocStates((prev) => ({ ...prev, [typeId]: { ...prev[typeId], ...updates } }));
  }, []);

  const handleFileSelect = useCallback((typeId, file) => {
    if (!file) return;

    // Validate extension
    const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      updateDocState(typeId, { error: `File type not allowed. Accepted: ${ALLOWED_EXTENSIONS.join(', ')}` });
      return;
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      updateDocState(typeId, { error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.` });
      return;
    }

    updateDocState(typeId, { file, error: null });
  }, [updateDocState]);

  const handleUpload = useCallback(async (typeId) => {
    const state = docStates[typeId];
    if (!state?.file || !supabase) return;

    updateDocState(typeId, { uploading: true, error: null });

    try {
      // Convert to base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(state.file);
      });

      const { data, error: fnErr } = await supabase.functions.invoke('caregiver-doc-upload', {
        body: {
          action: 'upload',
          token,
          document_type: typeId,
          file_name: state.file.name,
          file_content_base64: base64,
        },
      });

      if (fnErr || data?.error) {
        throw new Error(data?.error || fnErr?.message || 'Upload failed.');
      }

      updateDocState(typeId, {
        uploading: false,
        uploaded: true,
        uploadedFile: state.file.name,
        uploadedAt: new Date().toISOString(),
        file: null,
      });
    } catch (err) {
      updateDocState(typeId, { uploading: false, error: err.message || 'Upload failed. Please try again.' });
    }
  }, [docStates, token, updateDocState]);

  const handleRemoveFile = useCallback((typeId) => {
    updateDocState(typeId, { file: null, error: null });
    if (fileInputRefs.current[typeId]) fileInputRefs.current[typeId].value = '';
  }, [updateDocState]);

  // Check if all requested docs are uploaded
  const allUploaded = tokenData && Object.values(docStates).length > 0 &&
    Object.values(docStates).every((s) => s.uploaded);

  // ── Render ──

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
        </div>
        <div className={s.card}>
          <div className={s.loading}>
            <div className={s.spinner} />
            <div>Loading...</div>
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
        </div>
        <div className={s.card}>
          <div className={s.expired}>
            <div className={s.expiredIcon}>&#128279;</div>
            <div className={s.expiredTitle}>Link Unavailable</div>
            <div className={s.expiredText}>{error}</div>
          </div>
        </div>
        <div className={s.footer}>Tremendous Care &copy; {new Date().getFullYear()}</div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.logo}>Tremendous<span className={s.logoAccent}>Care</span></div>
        <div className={s.tagline}>Caregiver Portal</div>
        <div className={s.title}>
          {allUploaded ? 'All Documents Received!' : 'Upload Your Documents'}
        </div>
        {!allUploaded && (
          <div className={s.subtitle}>
            Hi {tokenData.caregiver_first_name}, please upload the requested documents below.
          </div>
        )}
      </div>

      <div className={s.card}>
        {allUploaded ? (
          <div className={s.allDone}>
            <div className={s.allDoneIcon}>&#10003;</div>
            <div className={s.allDoneTitle}>Thank You!</div>
            <div className={s.allDoneText}>
              All requested documents have been uploaded successfully.
              Your coordinator will review them shortly. You can close this page.
            </div>
          </div>
        ) : (
          (tokenData.requested_types || []).map((typeId) => {
            const state = docStates[typeId] || {};
            return (
              <div key={typeId} className={`${s.docRow} ${state.uploaded ? s.docRowUploaded : ''}`}>
                <div className={s.docHeader}>
                  <div className={s.docLabel}>{getDocLabel(typeId)}</div>
                  <div className={`${s.docStatus} ${state.uploaded ? s.statusUploaded : s.statusPending}`}>
                    {state.uploaded ? 'Uploaded' : 'Needed'}
                  </div>
                </div>

                {state.uploaded ? (
                  <div className={s.uploadedInfo}>
                    {state.uploadedFile} &mdash; uploaded {new Date(state.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                ) : (
                  <div className={s.fileArea}>
                    {!state.file && !state.uploading && (
                      <div
                        className={s.fileDropZone}
                        onClick={() => fileInputRefs.current[typeId]?.click()}
                      >
                        <div className={s.fileDropLabel}>
                          <span className={s.fileDropAccent}>Choose a file</span> or drag it here
                        </div>
                        <div className={s.fileDropHint}>
                          PDF, DOC, JPG, PNG &middot; Max {MAX_FILE_SIZE_MB}MB
                        </div>
                        <input
                          ref={(el) => { fileInputRefs.current[typeId] = el; }}
                          type="file"
                          accept={ALLOWED_EXTENSIONS.join(',')}
                          style={{ display: 'none' }}
                          onChange={(e) => handleFileSelect(typeId, e.target.files?.[0])}
                        />
                      </div>
                    )}

                    {state.file && !state.uploading && (
                      <>
                        <div className={s.selectedFile}>
                          <span className={s.fileName}>{state.file.name}</span>
                          <button className={s.removeFileBtn} onClick={() => handleRemoveFile(typeId)}>&times;</button>
                        </div>
                        <button
                          className={s.uploadBtn}
                          onClick={() => handleUpload(typeId)}
                        >
                          Upload Document
                        </button>
                      </>
                    )}

                    {state.uploading && (
                      <div className={s.uploadingIndicator}>
                        <span className={s.spinnerSmall} />
                        Uploading...
                      </div>
                    )}

                    {state.error && (
                      <div className={s.error}>
                        <div className={s.errorText}>{state.error}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className={s.footer}>Tremendous Care &copy; {new Date().getFullYear()}</div>
    </div>
  );
}
