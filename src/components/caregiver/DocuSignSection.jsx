import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { DOCUSIGN_STATUSES } from '../../lib/constants';
import btn from '../../styles/buttons.module.css';
import s from './DocuSignSection.module.css';

export function DocuSignSection({ caregiver, currentUser, showToast }) {
  const [envelopes, setEnvelopes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem('tc_docusign_expanded') === 'true');
  const [showDropdown, setShowDropdown] = useState(false);
  const [confirmSend, setConfirmSend] = useState(null);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
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
        .from('docusign_envelopes')
        .select('*')
        .eq('caregiver_id', caregiver.id)
        .order('sent_at', { ascending: false });
      if (!error && data) setEnvelopes(data);
    } catch (err) {
      console.warn('DocuSign envelopes fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [caregiver?.id]);

  // Fetch configured templates from app_settings
  const fetchTemplates = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'docusign_templates')
        .single();
      if (data?.value && Array.isArray(data.value)) {
        setTemplates(data.value);
      }
    } catch (err) {
      // Not configured yet — that's fine
    }
  }, []);

  useEffect(() => { fetchEnvelopes(); fetchTemplates(); }, [fetchEnvelopes, fetchTemplates]);

  // Send envelope
  const handleSend = useCallback(async (templateIds, templateNames, isPacket) => {
    if (!caregiver?.email) {
      showToast?.('Caregiver has no email address configured.');
      return;
    }
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const body = {
        action: isPacket ? 'send_packet' : 'send_envelope',
        caregiver_id: caregiver.id,
        caregiver_email: caregiver.email,
        caregiver_name: `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
        sent_by: currentUser?.email || '',
      };

      if (!isPacket) {
        body.template_ids = templateIds;
        body.template_names = templateNames;
      }

      const { data, error } = await supabase.functions.invoke('docusign-integration', {
        body,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      showToast?.(`DocuSign envelope sent to ${caregiver.email}`);
      await fetchEnvelopes();
    } catch (err) {
      console.error('DocuSign send failed:', err);
      showToast?.(`Failed to send: ${err.message || 'Unknown error'}`);
    } finally {
      setSending(false);
      setConfirmSend(null);
    }
  }, [caregiver, currentUser, showToast, fetchEnvelopes]);

  // Confirmation handlers
  const requestSendPacket = () => {
    setConfirmSend({ type: 'packet' });
    setShowDropdown(false);
  };

  const requestSendIndividual = (template) => {
    setConfirmSend({ type: 'individual', templateId: template.templateId, templateName: template.name });
    setShowDropdown(false);
  };

  const confirmAndSend = () => {
    if (confirmSend.type === 'packet') {
      const ids = templates.map(t => t.templateId);
      const names = templates.map(t => t.name);
      handleSend(ids, names, true);
    } else {
      handleSend([confirmSend.templateId], [confirmSend.templateName], false);
    }
  };

  // Resend a declined/voided envelope
  const handleResend = (envelope) => {
    if (envelope.template_ids?.length > 1) {
      setConfirmSend({ type: 'packet' });
    } else {
      setConfirmSend({
        type: 'individual',
        templateId: envelope.template_ids?.[0],
        templateName: envelope.template_names?.[0] || 'Document',
      });
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    localStorage.setItem('tc_docusign_expanded', String(next));
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
          DocuSign eSignatures
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {loading && <span className={s.spinner} />}
          {envelopes.length > 0 && (
            <span style={{
              padding: '4px 10px', borderRadius: 10, fontSize: 12, fontWeight: 600,
              background: envelopes.every(e => e.status === 'completed') ? '#DCFCE7' : '#FEF9C3',
              color: envelopes.every(e => e.status === 'completed') ? '#166534' : '#854D0E',
            }}>
              {envelopes.filter(e => e.status === 'completed').length} of {envelopes.length} signed
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
                        key={t.id || t.templateId}
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
              No DocuSign templates configured.{' '}
              <span className={s.settingsLink}>Configure in Settings</span>
            </div>
          )}

          {/* Envelope List */}
          {envelopes.length > 0 && (
            <div className={s.envelopeList}>
              {envelopes.map((env) => {
                const statusConfig = DOCUSIGN_STATUSES[env.status] || DOCUSIGN_STATUSES.sent;
                const canResend = ['declined', 'voided'].includes(env.status);
                const displayName = env.template_names?.length > 1
                  ? `Full Onboarding Packet (${env.template_names.length} docs)`
                  : env.template_names?.[0] || 'DocuSign Envelope';
                return (
                  <div key={env.id} className={s.envelopeItem}>
                    <div className={s.envelopeInfo}>
                      <div className={s.envelopeName}>{displayName}</div>
                      <div className={s.envelopeMeta}>
                        Sent {formatDate(env.sent_at)}
                        {env.completed_at && ` \u00B7 Signed ${formatDate(env.completed_at)}`}
                        {env.status === 'delivered' && ' \u00B7 Awaiting signature'}
                        {env.status === 'viewed' && ' \u00B7 Opened by signer'}
                        {env.sent_by && ` \u00B7 by ${env.sent_by.split('@')[0]}`}
                      </div>
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
                    {canResend && (
                      <button className={s.resendBtn} onClick={() => handleResend(env)}>
                        Resend
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Empty state for envelopes */}
          {envelopes.length === 0 && templates.length > 0 && (
            <div className={s.emptyState}>
              No envelopes sent yet. Use the buttons above to send documents for signature.
            </div>
          )}
        </>
      )}

      {/* Confirmation Modal */}
      {confirmSend && (
        <div className={s.confirmOverlay} onClick={(e) => { if (e.target === e.currentTarget) setConfirmSend(null); }}>
          <div className={s.confirmCard}>
            <div className={s.confirmTitle}>Send DocuSign Envelope</div>
            <div className={s.confirmText}>
              {confirmSend.type === 'packet'
                ? `Send the full onboarding packet (${templates.length} documents) to ${caregiver?.email}?`
                : `Send "${confirmSend.templateName}" to ${caregiver?.email}?`
              }
            </div>
            <div className={s.confirmActions}>
              <button
                className={btn.secondaryBtn}
                style={{ padding: '9px 20px', fontSize: 13 }}
                onClick={() => setConfirmSend(null)}
                disabled={sending}
              >
                Cancel
              </button>
              <button
                className={btn.primaryBtn}
                style={{ padding: '9px 20px', fontSize: 13, opacity: sending ? 0.6 : 1 }}
                onClick={confirmAndSend}
                disabled={sending}
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
