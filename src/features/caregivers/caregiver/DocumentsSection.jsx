import { useState, useEffect, useCallback } from 'react';
import { DOCUMENT_TYPES, UPLOADABLE_DOCUMENT_TYPES } from '../../../lib/constants';
import { supabase } from '../../../lib/supabase';
import { fireEventTriggers } from '../../../lib/automations';
import { DocuSignSection } from './DocuSignSection';
import cards from '../../../styles/cards.module.css';
import btn from '../../../styles/buttons.module.css';
import cg from './caregiver.module.css';

export function DocumentsSection({ caregiver, currentUser, showToast, onUpdateCaregiver }) {
  const [documents, setDocuments] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(null);
  const [docsExpanded, setDocsExpanded] = useState(() => localStorage.getItem('tc_docs_expanded') === 'true');
  const [docTypes, setDocTypes] = useState(DOCUMENT_TYPES);
  const [editingDocTypes, setEditingDocTypes] = useState(false);
  const [docTypeDraft, setDocTypeDraft] = useState([]);

  // Uploadable document types (editable, persisted to app_settings)
  const [uploadableDocTypes, setUploadableDocTypes] = useState(UPLOADABLE_DOCUMENT_TYPES);
  const [editingUploadTypes, setEditingUploadTypes] = useState(false);
  const [uploadTypeDraft, setUploadTypeDraft] = useState([]);

  // Request Documents modal state
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [requestSelectedTypes, setRequestSelectedTypes] = useState([]);
  const [requestDelivery, setRequestDelivery] = useState('sms'); // 'sms' | 'email' | 'both'
  const [requestSending, setRequestSending] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);

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

  // Fetch uploadable document types from app_settings
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'uploadable_document_types')
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
          setUploadableDocTypes(data.value);
        }
      });
  }, []);

  const saveUploadableDocTypes = async (types) => {
    if (!supabase) return;
    const cleaned = types.filter((t) => t.label.trim());
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'uploadable_document_types', value: cleaned, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
      setUploadableDocTypes(cleaned);
      if (showToast) showToast('Upload document types saved!');
    } catch (err) {
      console.error('Failed to save uploadable document types:', err);
      if (showToast) showToast('Failed to save document types');
    }
  };

  // Fetch pending upload requests for this caregiver
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    supabase
      .from('document_upload_tokens')
      .select('*')
      .eq('caregiver_id', caregiver.id)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) setPendingRequests(data);
      });
  }, [caregiver?.id]);

  const generateToken = () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  const handleSendRequest = useCallback(async () => {
    if (!caregiver?.id || !supabase || requestSelectedTypes.length === 0) return;
    setRequestSending(true);
    try {
      const token = generateToken();
      const portalUrl = window.location.origin;
      const uploadUrl = `${portalUrl}/upload/${token}`;

      // Insert token into database
      const { error: insertErr } = await supabase
        .from('document_upload_tokens')
        .insert({
          caregiver_id: caregiver.id,
          token,
          requested_types: requestSelectedTypes,
          created_by: currentUser?.email || 'unknown',
        });
      if (insertErr) throw insertErr;

      // Build the message
      const docLabels = requestSelectedTypes.map((id) =>
        uploadableDocTypes.find((t) => t.id === id)?.label || id
      );
      const docsListText = docLabels.map((l) => `- ${l}`).join('\n');

      const smsMessage = `Hi ${caregiver.first_name}, Tremendous Care needs the following documents from you:\n${docsListText}\n\nPlease upload them here: ${uploadUrl}\n\nThis link expires in 7 days.`;

      const emailSubject = `Document Upload Request - Tremendous Care`;
      const emailBody = `<p>Hi ${caregiver.first_name},</p>
<p>We need the following documents from you:</p>
<ul>${docLabels.map((l) => `<li>${l}</li>`).join('')}</ul>
<p>Please upload them using the link below:</p>
<p><a href="${uploadUrl}" style="display:inline-block;padding:12px 24px;background:#2E4E8D;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Upload Documents</a></p>
<p>This link expires in 7 days.</p>
<p>Thank you,<br/>Tremendous Care</p>`;

      // Send via selected delivery method
      const promises = [];

      if ((requestDelivery === 'sms' || requestDelivery === 'both') && caregiver.phone) {
        promises.push(
          supabase.functions.invoke('bulk-sms', {
            body: {
              caregiver_ids: [caregiver.id],
              message: smsMessage,
              current_user: currentUser?.email || 'system',
            },
          })
        );
      }

      if ((requestDelivery === 'email' || requestDelivery === 'both') && caregiver.email) {
        promises.push(
          supabase.functions.invoke('bulk-email', {
            body: {
              client_ids: [],
              subject: emailSubject,
              message: emailBody,
              current_user: currentUser?.email || 'system',
              custom_recipients: [{ email: caregiver.email, name: `${caregiver.first_name} ${caregiver.last_name}` }],
            },
          })
        );
      }

      await Promise.allSettled(promises);

      // Refresh pending requests
      const { data: updated } = await supabase
        .from('document_upload_tokens')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (updated) setPendingRequests(updated);

      setShowRequestModal(false);
      setRequestSelectedTypes([]);
      if (showToast) showToast('Document upload link sent!');
    } catch (err) {
      console.error('Failed to send document request:', err);
      if (showToast) showToast(`Failed to send request: ${err.message || 'Unknown error'}`);
    } finally {
      setRequestSending(false);
    }
  }, [caregiver, currentUser, requestSelectedTypes, requestDelivery, showToast]);

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

        {/* Request Documents button + pending requests */}
        <div style={{ padding: '0 20px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowRequestModal(true); setRequestSelectedTypes([]); }}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '1px solid #2E4E8D', background: '#EBF0FA',
              color: '#2E4E8D', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            📤 Request Documents
          </button>
          {pendingRequests.length > 0 && (
            <span style={{ fontSize: 11, color: '#6B7B8F', fontWeight: 500 }}>
              {pendingRequests.length} pending request{pendingRequests.length > 1 ? 's' : ''}
              {pendingRequests.some((r) => r.used_at) && (
                <span style={{ color: '#15803D', marginLeft: 4 }}>
                  ({pendingRequests.filter((r) => r.used_at).length} with uploads)
                </span>
              )}
            </span>
          )}
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

      {/* Request Documents Modal */}
      {showRequestModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => setShowRequestModal(false)}>
          <div style={{
            background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 480,
            maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: 'var(--tc-font-heading)', fontSize: 18, fontWeight: 700, color: '#1A1A1A', marginBottom: 4 }}>
              Request Documents
            </h3>
            <p style={{ fontSize: 13, color: '#6B7B8F', marginBottom: 16 }}>
              Send {caregiver.first_name} a link to upload documents directly to their SharePoint folder.
            </p>

            {/* Document type checkboxes + edit mode */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#2E4E8D', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                  {editingUploadTypes ? 'Edit Document Types' : 'Select Documents to Request'}
                </div>
                {!editingUploadTypes ? (
                  <button
                    onClick={() => { setUploadTypeDraft(uploadableDocTypes.map((t) => ({ ...t }))); setEditingUploadTypes(true); }}
                    style={{ background: 'none', border: 'none', color: '#2E4E8D', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    ✏️ Edit Types
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => { saveUploadableDocTypes(uploadTypeDraft); setEditingUploadTypes(false); }}
                      style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#2E4E8D', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                    >Save</button>
                    <button
                      onClick={() => setEditingUploadTypes(false)}
                      style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #D1D5DB', background: '#fff', color: '#6B7B8F', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                    >Cancel</button>
                  </div>
                )}
              </div>

              {editingUploadTypes ? (
                <div>
                  {uploadTypeDraft.map((dt, idx) => (
                    <div key={dt.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' }}>
                      <input
                        value={dt.label}
                        onChange={(e) => setUploadTypeDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))}
                        placeholder="Document name..."
                        style={{
                          flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #D1D5DB',
                          fontSize: 13, fontFamily: 'inherit', background: '#FAFBFC',
                        }}
                      />
                      <button
                        onClick={() => setUploadTypeDraft((prev) => prev.filter((_, i) => i !== idx))}
                        style={{
                          padding: '4px 8px', borderRadius: 6, border: '1px solid #FCA5A5', background: '#FEF2F2',
                          color: '#DC2626', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >✕</button>
                    </div>
                  ))}
                  <button
                    onClick={() => setUploadTypeDraft((prev) => [...prev, { id: 'doc_' + Date.now().toString(36), label: '', required: false }])}
                    style={{
                      marginTop: 6, padding: '4px 0', background: 'none', border: 'none',
                      color: '#2E4E8D', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >＋ Add Document Type</button>
                </div>
              ) : (
                <>
                  {uploadableDocTypes.map((dt) => (
                    <label key={dt.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                      cursor: 'pointer', fontSize: 13, color: '#1A1A1A',
                    }}>
                      <input
                        type="checkbox"
                        checked={requestSelectedTypes.includes(dt.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setRequestSelectedTypes((prev) => [...prev, dt.id]);
                          } else {
                            setRequestSelectedTypes((prev) => prev.filter((id) => id !== dt.id));
                          }
                        }}
                        style={{ width: 16, height: 16, accentColor: '#2E4E8D' }}
                      />
                      <span style={{ fontWeight: 500 }}>{dt.label}</span>
                    </label>
                  ))}
                  <button
                    style={{
                      marginTop: 6, padding: '4px 0', background: 'none', border: 'none',
                      color: '#2E4E8D', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                    onClick={() => {
                      if (requestSelectedTypes.length === uploadableDocTypes.length) {
                        setRequestSelectedTypes([]);
                      } else {
                        setRequestSelectedTypes(uploadableDocTypes.map((t) => t.id));
                      }
                    }}
                  >
                    {requestSelectedTypes.length === uploadableDocTypes.length ? 'Deselect All' : 'Select All'}
                  </button>
                </>
              )}
            </div>

            {/* Delivery method */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#2E4E8D', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                Send Via
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { id: 'sms', label: 'SMS', icon: '💬', disabled: !caregiver.phone },
                  { id: 'email', label: 'Email', icon: '📧', disabled: !caregiver.email },
                  { id: 'both', label: 'Both', icon: '📤', disabled: !caregiver.phone || !caregiver.email },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    disabled={opt.disabled}
                    onClick={() => setRequestDelivery(opt.id)}
                    style={{
                      flex: 1, padding: '10px 8px', borderRadius: 10, cursor: opt.disabled ? 'not-allowed' : 'pointer',
                      border: requestDelivery === opt.id ? '2px solid #2E4E8D' : '1px solid #D1D5DB',
                      background: requestDelivery === opt.id ? '#EBF0FA' : '#FAFBFC',
                      color: opt.disabled ? '#B0B8C4' : '#1A1A1A',
                      fontSize: 12, fontWeight: 600, fontFamily: 'inherit', textAlign: 'center',
                      opacity: opt.disabled ? 0.5 : 1,
                    }}
                  >
                    <div>{opt.icon}</div>
                    <div>{opt.label}</div>
                  </button>
                ))}
              </div>
              {!caregiver.phone && !caregiver.email && (
                <div style={{ fontSize: 11, color: '#DC2626', marginTop: 6 }}>
                  No phone or email on file. Add contact info to send a request.
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowRequestModal(false)}
                style={{
                  padding: '10px 20px', borderRadius: 10, border: '1px solid #D1D5DB',
                  background: '#fff', color: '#6B7B8F', fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSendRequest}
                disabled={requestSelectedTypes.length === 0 || requestSending || (!caregiver.phone && !caregiver.email)}
                style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none',
                  background: requestSelectedTypes.length === 0 || requestSending ? '#B0B8C4' : 'linear-gradient(135deg, #2E4E8D 0%, #1a6b7a 100%)',
                  color: '#fff', fontSize: 13, fontWeight: 700,
                  cursor: requestSelectedTypes.length === 0 || requestSending ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit', minWidth: 140,
                }}
              >
                {requestSending ? 'Sending...' : `Send Request (${requestSelectedTypes.length})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
