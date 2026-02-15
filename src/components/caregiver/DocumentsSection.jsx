import { useState, useEffect } from 'react';
import { DOCUMENT_TYPES } from '../../lib/constants';
import { supabase } from '../../lib/supabase';
import { fireEventTriggers } from '../../lib/automations';
import { DocuSignSection } from './DocuSignSection';
import cards from '../../styles/cards.module.css';
import btn from '../../styles/buttons.module.css';
import cg from './caregiver.module.css';

export function DocumentsSection({ caregiver, currentUser, showToast, onUpdateCaregiver }) {
  const [documents, setDocuments] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(null);
  const [docsExpanded, setDocsExpanded] = useState(() => localStorage.getItem('tc_docs_expanded') === 'true');
  const [docTypes, setDocTypes] = useState(DOCUMENT_TYPES);
  const [editingDocTypes, setEditingDocTypes] = useState(false);
  const [docTypeDraft, setDocTypeDraft] = useState([]);

  // Fetch documents from caregiver_documents table
  const fetchDocuments = async () => {
    if (!caregiver?.id || !supabase) return;
    setDocsLoading(true);
    try {
      const { data, error } = await supabase
        .from('caregiver_documents')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .order('uploaded_at', { ascending: false });
      if (!error && data) setDocuments(data);
    } catch (err) {
      console.warn('Documents fetch error:', err);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => { fetchDocuments(); }, [caregiver?.id]);

  // Realtime subscription: auto-refresh when documents are inserted (e.g., DocuSign auto-upload)
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    const channel = supabase
      .channel(`caregiver-docs-${caregiver.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'caregiver_documents', filter: `caregiver_id=eq.${caregiver.id}` },
        (payload) => {
          setDocuments((prev) => [payload.new, ...prev]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'caregiver_documents', filter: `caregiver_id=eq.${caregiver.id}` },
        (payload) => {
          setDocuments((prev) => prev.filter((d) => d.id !== payload.old.id));
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [caregiver?.id]);

  // Fetch custom document types from app_settings
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'document_types')
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
          setDocTypes(data.value);
        }
      });
  }, []);

  const saveDocTypes = async (types) => {
    if (!supabase) return;
    const cleaned = types.filter((t) => t.label.trim());
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'document_types', value: cleaned, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
      setDocTypes(cleaned);
    } catch (err) {
      console.error('Failed to save document types:', err);
      if (showToast) showToast('Failed to save document types');
    }
  };

  const handleDocUpload = async (docType, file) => {
    if (!file || !supabase) return;
    setUploadingDoc(docType);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: {
          action: 'upload_file',
          caregiver_id: caregiver.id,
          document_type: docType,
          file_name: file.name,
          file_content_base64: base64,
          uploaded_by: currentUser?.email || '',
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      await fetchDocuments();
      if (onUpdateCaregiver) {
        const { data: updated } = await supabase
          .from('caregivers')
          .select('tasks')
          .eq('id', caregiver.id)
          .single();
        if (updated?.tasks) {
          onUpdateCaregiver(caregiver.id, { tasks: updated.tasks });
        }
      }

      // Fire document_uploaded automation trigger
      const docLabel = docTypes.find((d) => d.id === docType)?.label || docType;
      fireEventTriggers('document_uploaded', caregiver, {
        document_type: docType,
        document_label: docLabel,
      });
    } catch (err) {
      console.error('Upload failed:', err);
      if (showToast) showToast(`Upload failed: ${err.message || 'Unknown error'}`);
    } finally {
      setUploadingDoc(null);
    }
  };

  const handleDocDownload = async (docId) => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'get_download_url', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.download_url) window.open(data.download_url, '_blank');
    } catch (err) {
      console.error('Download failed:', err);
      if (showToast) showToast(`Download failed: ${err.message || 'Unknown error'}`);
    }
  };

  const handleDocView = (webUrl) => {
    if (webUrl) window.open(webUrl, '_blank');
  };

  const handleDocDelete = async (docId, docName) => {
    if (!confirm(`Delete "${docName}"? This will remove it from SharePoint and the portal.`)) return;
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'delete_file', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await fetchDocuments();
      const { data: updated } = await supabase
        .from('caregivers')
        .select('tasks')
        .eq('id', caregiver.id)
        .single();
      if (updated?.tasks && onUpdateCaregiver) {
        onUpdateCaregiver(caregiver.id, { tasks: updated.tasks });
      }
    } catch (err) {
      console.error('Delete failed:', err);
      if (showToast) showToast(`Delete failed: ${err.message || 'Unknown error'}`);
    }
  };

  const uploadedTypes = new Set(documents.map((d) => d.document_type));

  return (
    <div className={cards.profileCard}>
      <div
        className={cards.profileCardHeader}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => { const next = !docsExpanded; setDocsExpanded(next); localStorage.setItem('tc_docs_expanded', String(next)); }}
      >
        <h3 className={cards.profileCardTitle}>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: docsExpanded ? 'rotate(90deg)' : 'rotate(0deg)', marginRight: 6, fontSize: 12 }}>▶</span>
          📄 Documents
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {docsLoading && (
            <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          )}
          <span style={{
            padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600,
            background: documents.length === docTypes.length ? '#DCFCE7' : '#FEF9C3',
            color: documents.length === docTypes.length ? '#166534' : '#854D0E',
          }}>
            {uploadedTypes.size} of {docTypes.length} received
          </span>
        </div>
      </div>

      {docsExpanded && <>
        {/* Progress bar */}
        <div style={{ padding: '0 20px 12px' }}>
          <div style={{ height: 6, background: '#E5E7EB', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((uploadedTypes.size / docTypes.length) * 100)}%`, background: uploadedTypes.size === docTypes.length ? '#16A34A' : '#2E4E8D', borderRadius: 3, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Document list header with edit button */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 20px 8px' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F' }}>{editingDocTypes ? 'Editing Document Types' : 'Required Documents'}</span>
          {!editingDocTypes ? (
            <button className={btn.editBtn} onClick={() => { setDocTypeDraft(docTypes.map((t) => ({ ...t }))); setEditingDocTypes(true); }}>✏️ Edit</button>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => { saveDocTypes(docTypeDraft); setEditingDocTypes(false); }}>Save</button>
              <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setEditingDocTypes(false)}>Cancel</button>
            </div>
          )}
        </div>

        {/* Document type editor */}
        {editingDocTypes ? (
          <div style={{ padding: '0 20px 16px' }}>
            {docTypeDraft.map((dt, idx) => (
              <div key={dt.id} className={cg.row}>
                <span className={cg.handle}>⠿</span>
                <input className={cg.input} value={dt.label} onChange={(e) => setDocTypeDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))} placeholder="Document name..." />
                <label className={cg.criticalToggle} title="Mark as required">
                  <input type="checkbox" checked={!!dt.required} onChange={(e) => setDocTypeDraft((prev) => prev.map((t, i) => i === idx ? { ...t, required: e.target.checked } : t))} />
                  <span className={cg.criticalLabel}>Required</span>
                </label>
                <button className={cg.moveBtn} disabled={idx === 0} onClick={() => setDocTypeDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
                <button className={cg.moveBtn} disabled={idx === docTypeDraft.length - 1} onClick={() => setDocTypeDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
                <button className={cg.deleteBtn} onClick={() => setDocTypeDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
              </div>
            ))}
            <button className={cg.addBtn} onClick={() => setDocTypeDraft((prev) => [...prev, { id: 'doc_' + Date.now().toString(36), label: '', required: false }])}>＋ Add Document Type</button>
          </div>
        ) : (

        <div style={{ padding: '0 20px 16px' }}>
          {docTypes.map((docType) => {
            const uploaded = documents.filter((d) => d.document_type === docType.id);
            const hasDoc = uploaded.length > 0;
            const isUploading = uploadingDoc === docType.id;
            return (
              <div key={docType.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
                borderBottom: '1px solid #F0F0F0',
              }}>
                {/* Status icon */}
                <span style={{
                  width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, flexShrink: 0,
                  background: hasDoc ? '#DCFCE7' : '#FEE2E2',
                  color: hasDoc ? '#166534' : '#DC2626',
                }}>
                  {hasDoc ? '✓' : '—'}
                </span>

                {/* Doc info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1A1A1A' }}>{docType.label}</span>
                    {docType.required && !hasDoc && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#FEE2E2', color: '#DC2626', fontWeight: 600 }}>Required</span>
                    )}
                  </div>
                  {hasDoc && uploaded.map((doc) => (
                    <div key={doc.id} style={{ fontSize: 12, color: '#6B7B8F', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.file_name}</span>
                      <span>{new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      {doc.uploaded_by && <span>by {doc.uploaded_by.split('@')[0]}</span>}
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {hasDoc && uploaded.map((doc) => (
                    <div key={doc.id} style={{ display: 'flex', gap: 4 }}>
                      {doc.sharepoint_web_url && (
                        <button
                          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #D1D5DB', background: '#FAFBFC', color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                          onClick={() => handleDocView(doc.sharepoint_web_url)}
                          title="View in SharePoint"
                        >View</button>
                      )}
                      <button
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #D1D5DB', background: '#FAFBFC', color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        onClick={() => handleDocDownload(doc.id)}
                        title="Download file"
                      >Download</button>
                      <button
                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                        onClick={() => handleDocDelete(doc.id, doc.file_name)}
                        title="Delete document"
                      >✕</button>
                    </div>
                  ))}
                  {/* Upload button */}
                  <label style={{
                    padding: '4px 10px', borderRadius: 6, border: '1px solid #D1D5DB',
                    background: isUploading ? '#EBF0FA' : '#FAFBFC',
                    color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: isUploading ? 'wait' : 'pointer', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: 4, opacity: isUploading ? 0.7 : 1,
                  }}>
                    {isUploading ? (
                      <>
                        <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid #D1D5DB', borderTopColor: '#2E4E8D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        Uploading...
                      </>
                    ) : (
                      <>{hasDoc ? 'Replace' : 'Upload'}</>
                    )}
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                      style={{ display: 'none' }}
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleDocUpload(docType.id, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
        )}
      </>}

      {/* DocuSign eSignatures Section */}
      <DocuSignSection
        caregiver={caregiver}
        currentUser={currentUser}
        showToast={showToast}
      />
    </div>
  );
}
