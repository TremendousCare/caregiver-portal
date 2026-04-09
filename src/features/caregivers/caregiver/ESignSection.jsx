import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { ESIGN_STATUSES } from '../../../lib/constants';
import btn from '../../../styles/buttons.module.css';
import s from './ESignSection.module.css';

export function ESignSection({ caregiver, currentUser, showToast }) {
  const [envelopes, setEnvelopes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [signedDocs, setSignedDocs] = useState([]); // caregiver_documents uploaded by esign-system
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem('tc_esign_expanded') === 'true');
  const [showDropdown, setShowDropdown] = useState(false);
  const [confirmSend, setConfirmSend] = useState(null);
  const [sendVia, setSendVia] = useState('sms');
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Fetch envelopes for this caregiver
  const fetchEnvelopes = useCallback(async () => {
    if (!caregiver?.id || !supabase) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('esign_envelopes')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .order('sent_at', { ascending: false });
      if (!error && data) setEnvelopes(data);
    } catch (err) {
      console.warn('eSign envelopes fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [caregiver?.id]);

  // Fetch active templates
  const fetchTemplates = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data } = await supabase
        .from('esign_templates')
        .select('id, name')
        .eq('active', true)
        .order('sort_order');
      if (data) setTemplates(data);
    } catch (err) {
      // No templates configured yet
    }
  }, []);

  // Fetch signed documents uploaded by esign-system
  const fetchSignedDocs = useCallback(async () => {
    if (!caregiver?.id || !supabase) return;
    try {
      const { data } = await supabase
        .from('caregiver_documents')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .eq('uploaded_by', 'esign-system')
        .order('uploaded_at', { ascending: false });
      if (data) setSignedDocs(data);
    } catch (_) {}
  }, [caregiver?.id]);

  useEffect(() => { fetchEnvelopes(); fetchTemplates(); fetchSignedDocs(); }, [fetchEnvelopes, fetchTemplates, fetchSignedDocs]);

  // View document in SharePoint
  const handleDocView = useCallback((webUrl) => {
    if (webUrl) window.open(webUrl, '_blank');
  }, []);

  // Download document
  const handleDocDownload = useCallback(async (docId) => {
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'get_download_url', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.download_url) window.open(data.download_url, '_blank');
    } catch (err) {
      showToast?.(`Download failed: ${err.message || 'Unknown error'}`);
    }
  }, [showToast]);

  // Delete document
  const handleDocDelete = useCallback(async (docId, docName) => {
    if (!confirm(`Delete "${docName}"? This will remove it from SharePoint.`)) return;
    try {
      const { data, error } = await supabase.functions.invoke('sharepoint-docs', {
        body: { action: 'delete_file', doc_id: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await fetchSignedDocs();
      showToast?.('Document deleted.');
    } catch (err) {
      showToast?.(`Delete failed: ${err.message || 'Unknown error'}`);
    }
  }, [showToast, fetchSignedDocs]);

  // Realtime subscription for envelope status changes
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    const channel = supabase
      .channel(`esign-envelopes-${caregiver.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'esign_envelopes', filter: `caregiver_id=eq.${caregiver.id}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setEnvelopes((prev) => [payload.new, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setEnvelopes((prev) =>
              prev.map((env) => env.id === payload.new.id ? { ...env, ...payload.new } : env)
            );
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [caregiver?.id]);

  // Send envelope
  const handleSend = useCallback(async (templateIds, templateNames, isPacket) => {
    if (!caregiver?.phone && !caregiver?.email) {
      showToast?.('Caregiver has no phone or email configured.');
      return;
    }
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const body = {
        action: 'create_envelope',
        caregiver_id: caregiver.id,
        caregiver_name: `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
        caregiver_email: caregiver.email || '',
        caregiver_phone: caregiver.phone || '',
        sent_by: currentUser?.email || '',
        send_via: sendVia,
        is_packet: isPacket,
      };

      if (!isPacket) {
        body.template_ids = templateIds;
      }

      const { data, error } = await supabase.functions.invoke('esign', {
        body,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const via = sendVia === 'both' ? 'SMS and email' : sendVia === 'email' ? 'email' : 'SMS';
      showToast?.(`Signing request sent via ${via} to ${caregiver.firstName}`);
      await fetchEnvelopes();
    } catch (err) {
      console.error('eSign send failed:', err);
      showToast?.(`Failed to send: ${err.message || 'Unknown error'}`);
    } finally {
      setSending(false);
      setConfirmSend(null);
    }
  }, [caregiver, currentUser, sendVia, showToast, fetchEnvelopes]);

  // Void envelope
  const handleVoid = useCallback(async (envelopeId) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data, error } = await supabase.functions.invoke('esign', {
        body: { action: 'void_envelope', envelope_id: envelopeId, voided_by: currentUser?.email },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      showToast?.('Signing request cancelled.');
      await fetchEnvelopes();
    } catch (err) {
      showToast?.(`Failed to void: ${err.message || 'Unknown error'}`);
    }
  }, [currentUser, showToast, fetchEnvelopes]);

  // Resend envelope
  const handleResend = useCallback(async (envelopeId) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data, error } = await supabase.functions.invoke('esign', {
        body: { action: 'resend', envelope_id: envelopeId, resent_by: currentUser?.email },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      showToast?.('Signing reminder sent.');
      await fetchEnvelopes();
    } catch (err) {
      showToast?.(`Failed to resend: ${err.message || 'Unknown error'}`);
    }
  }, [currentUser, showToast, fetchEnvelopes]);

  // Confirmation handlers
  const requestSendPacket = () => {
    setConfirmSend({ type: 'packet' });
    setShowDropdown(false);
  };

  const requestSendIndividual = (template) => {
    setConfirmSend({ type: 'individual', templateId: template.id, templateName: template.name });
    setShowDropdown(false);
  };

  const confirmAndSend = () => {
    if (confirmSend.type === 'packet') {
      const ids = templates.map((t) => t.id);
      const names = templates.map((t) => t.name);
      handleSend(ids, names, true);
    } else {
      handleSend([confirmSend.templateId], [confirmSend.templateName], false);
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('tc_esign_expanded', String(next));
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const noTemplates = templates.length === 0;

  return (
    <div className={s.section}>
      {/* Header */}
      <div className={s.header} onClick={toggleExpanded}>
        <div className={s.headerTitle}>
          <span className={`${s.arrow} ${expanded ? s.arrowExpanded : ''}`}>&#9654;</span>
          eSignatures
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loading && <span className={s.spinner} />}
          {envelopes.length > 0 && (
            <span style={{
              padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600,
              background: envelopes.every((e) => e.status === 'signed') ? '#DCFCE7' : '#FEF9C3',
              color: envelopes.every((e) => e.status === 'signed') ? '#166534' : '#854D0E',
            }}>
              {envelopes.filter((e) => e.status === 'signed').length} of {envelopes.length} signed
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <>
          {/* Send Actions */}
          {!noTemplates ? (
            <div className={s.actions}>
              <button
                className={s.sendPacketBtn}
                onClick={requestSendPacket}
                disabled={sending || noTemplates}
              >
                {sending ? 'Sending...' : 'Send Full Packet'}
              </button>

              <div className={s.dropdown} ref={dropdownRef}>
                <button
                  className={s.sendIndividualBtn}
                  onClick={() => setShowDropdown(!showDropdown)}
                  disabled={sending}
                >
                  Send Individual &#9662;
                </button>
                {showDropdown && (
                  <div className={s.dropdownMenu}>
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        className={s.dropdownItem}
                        onClick={() => requestSendIndividual(t)}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={s.emptyState}>
              No eSign templates configured.{' '}
              <span className={s.settingsLink}>Configure in Settings</span>
            </div>
          )}

          {/* Envelope List */}
          {envelopes.length > 0 && (
            <div className={s.envelopeList}>
              {envelopes.map((env) => {
                const statusConfig = ESIGN_STATUSES[env.status] || ESIGN_STATUSES.sent;
                const canResend = ['declined', 'voided', 'expired', 'sent', 'viewed'].includes(env.status);
                const canVoid = ['sent', 'viewed'].includes(env.status);
                const displayName = env.template_names?.length > 1
                  ? `Full Onboarding Packet (${env.template_names.length} docs)`
                  : env.template_names?.[0] || 'eSign Envelope';
                // Find matching signed documents for this envelope
                const envDocs = env.status === 'signed'
                  ? signedDocs.filter((doc) => {
                      // Match by template names in filename or by upload time near signed_at
                      const signedDate = env.signed_at ? new Date(env.signed_at).toISOString().split('T')[0] : '';
                      return doc.file_name?.includes('_Signed_') && doc.file_name?.includes(signedDate);
                    })
                  : [];

                return (
                  <div key={env.id} className={s.envelopeItem}>
                    <div className={s.envelopeInfo}>
                      <div className={s.envelopeName}>{displayName}</div>
                      <div className={s.envelopeMeta}>
                        Sent {formatDate(env.sent_at)}
                        {env.sent_by ? ` by ${env.sent_by.split('@')[0]}` : ''}
                        {env.signed_at ? ` \u00B7 Signed ${formatDate(env.signed_at)}` : ''}
                      </div>

                      {/* Document actions for signed envelopes */}
                      {env.status === 'signed' && envDocs.length > 0 && (
                        <div className={s.docActions}>
                          {envDocs.map((doc) => (
                            <div key={doc.id} className={s.docActionRow}>
                              <span className={s.docFileName}>{doc.file_name}</span>
                              {doc.sharepoint_web_url && (
                                <button className={s.docActionBtn} onClick={() => handleDocView(doc.sharepoint_web_url)} title="View in SharePoint">
                                  View
                                </button>
                              )}
                              <button className={s.docActionBtn} onClick={() => handleDocDownload(doc.id)} title="Download">
                                Download
                              </button>
                              <button className={s.docActionBtn} onClick={() => handleDocDelete(doc.id, doc.file_name)} title="Delete" style={{ color: '#DC2626' }}>
                                Delete
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {env.status === 'signed' && envDocs.length === 0 && env.documents_uploaded && (
                        <div className={s.envelopeMeta} style={{ marginTop: 4, fontStyle: 'italic' }}>
                          Documents uploaded to SharePoint
                        </div>
                      )}
                    </div>
                    <span
                      className={s.statusBadge}
                      style={{
                        background: statusConfig.bg,
                        color: statusConfig.color,
                        border: `1px solid ${statusConfig.border}`,
                      }}
                    >
                      {statusConfig.label}
                    </span>
                    {canResend && env.status !== 'signed' && (
                      <button className={s.resendBtn} onClick={() => handleResend(env.id)}>
                        Resend
                      </button>
                    )}
                    {canVoid && (
                      <button
                        className={s.resendBtn}
                        onClick={() => { if (confirm('Cancel this signing request?')) handleVoid(env.id); }}
                        style={{ color: '#DC2626' }}
                      >
                        Void
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Confirmation Modal */}
      {confirmSend && (
        <div className={s.confirmOverlay} onClick={() => setConfirmSend(null)}>
          <div className={s.confirmCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={s.confirmTitle}>Send for eSignature</h3>
            <div className={s.confirmText}>
              {confirmSend.type === 'packet'
                ? `Send all ${templates.length} documents to ${caregiver.firstName} ${caregiver.lastName} for signing?`
                : `Send "${confirmSend.templateName}" to ${caregiver.firstName} ${caregiver.lastName} for signing?`}
            </div>

            {/* Send via selector */}
            <div className={s.sendViaRow}>
              <span className={s.sendViaLabel}>Send via:</span>
              <div className={s.sendViaOptions}>
                {[
                  { value: 'sms', label: 'SMS' },
                  { value: 'email', label: 'Email' },
                  { value: 'both', label: 'Both' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    className={`${s.sendViaBtn} ${sendVia === opt.value ? s.sendViaActive : ''}`}
                    onClick={() => setSendVia(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.confirmActions}>
              <button className={btn.secondaryBtn} onClick={() => setConfirmSend(null)}>Cancel</button>
              <button className={btn.primaryBtn} onClick={confirmAndSend} disabled={sending}>
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
