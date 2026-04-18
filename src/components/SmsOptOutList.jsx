import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { setCaregiverSmsOptOut } from '../lib/storage';
import btn from '../styles/buttons.module.css';
import cards from '../styles/cards.module.css';

// ═══════════════════════════════════════════════════════════════
// SMS Opt-Out List (Admin Settings → Automations area)
//
// Shows every caregiver and client who has opted out of SMS — either
// by texting STOP (source = 'keyword') or because an admin paused
// them manually (source = 'admin'). Lets the admin re-subscribe with
// one click. This is the single "who is blocked from automated SMS"
// source of truth.
//
// Clients are shown in a grouped section but cannot be re-subscribed
// from this view in v1 — only caregivers have a helper in storage.js.
// Admins can flip a client back via the client profile directly.
// ═══════════════════════════════════════════════════════════════

export function SmsOptOutList({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [caregivers, setCaregivers] = useState([]);
  const [clients, setClients] = useState([]);
  const [updatingId, setUpdatingId] = useState(null);

  const load = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [cgRes, clRes] = await Promise.all([
        supabase
          .from('caregivers')
          .select('id, first_name, last_name, phone, sms_opted_out_at, sms_opted_out_source')
          .eq('sms_opted_out', true)
          .order('sms_opted_out_at', { ascending: false }),
        supabase
          .from('clients')
          .select('id, first_name, last_name, phone, sms_opted_out_at, sms_opted_out_source')
          .eq('sms_opted_out', true)
          .order('sms_opted_out_at', { ascending: false }),
      ]);
      if (cgRes.error) throw cgRes.error;
      if (clRes.error) throw clRes.error;
      setCaregivers(cgRes.data || []);
      setClients(clRes.data || []);
    } catch (err) {
      console.error('Failed to load SMS opt-out list:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleResubscribeCaregiver = async (row) => {
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.id;
    if (!window.confirm(`Re-subscribe ${name} to SMS? They will start receiving automated and manual texts again.`)) {
      return;
    }
    setUpdatingId(row.id);
    try {
      await setCaregiverSmsOptOut(row.id, false);
      setCaregivers((prev) => prev.filter((r) => r.id !== row.id));
      showToast?.(`Re-subscribed ${name}`);
    } catch (err) {
      console.error('Failed to re-subscribe:', err);
      showToast?.('Failed to re-subscribe. Please try again.');
    } finally {
      setUpdatingId(null);
    }
  };

  const totalOptedOut = caregivers.length + clients.length;

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <div>
          <h3 className={cards.profileCardTitle}>SMS Opt-Outs</h3>
          <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>
            Caregivers and clients who are blocked from receiving automated SMS
          </span>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 28, height: 22, padding: '0 8px', borderRadius: 11,
          background: totalOptedOut > 0 ? '#FEF2F2' : '#F0FDF4',
          color: totalOptedOut > 0 ? '#991B1B' : '#15803D',
          fontSize: 11, fontWeight: 700,
        }}>
          {totalOptedOut}
        </span>
      </div>
      <div style={{ padding: '16px 24px 20px' }}>
        {loading ? (
          <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading…</div>
        ) : totalOptedOut === 0 ? (
          <div style={{
            textAlign: 'center', padding: '24px 16px', color: '#7A8BA0',
            border: '1px dashed #E0E4EA', borderRadius: 10, fontSize: 13,
          }}>
            No opt-outs. Everyone is reachable by SMS.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {caregivers.length > 0 && (
              <Section
                title="Caregivers"
                rows={caregivers}
                allowResubscribe
                updatingId={updatingId}
                onResubscribe={handleResubscribeCaregiver}
              />
            )}
            {clients.length > 0 && (
              <Section
                title="Clients"
                rows={clients}
                allowResubscribe={false}
                updatingId={updatingId}
                onResubscribe={null}
              />
            )}
            <div style={{
              fontSize: 11, color: '#7A8BA0', fontStyle: 'italic',
              paddingTop: 8, borderTop: '1px dashed #E0E4EA',
            }}>
              Opt-outs happen when a recipient replies STOP to a text, or when an admin pauses
              SMS from their profile. Required for TCPA / carrier compliance.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, rows, allowResubscribe, updatingId, onResubscribe }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#2E4E8D',
        textTransform: 'uppercase', letterSpacing: 1.1, marginBottom: 8,
      }}>
        {title} ({rows.length})
      </div>
      <div style={{ border: '1px solid #E0E4EA', borderRadius: 10, overflow: 'hidden' }}>
        {rows.map((row, i) => (
          <div
            key={row.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 120px 140px auto',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: i < rows.length - 1 ? '1px solid #F0F3F7' : 'none',
              background: i % 2 === 0 ? '#fff' : '#FAFBFC',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, color: '#0F1724' }}>
              {`${row.first_name || ''} ${row.last_name || ''}`.trim() || row.id}
              {row.phone && (
                <span style={{ color: '#7A8BA0', fontWeight: 400, marginLeft: 8 }}>
                  {row.phone}
                </span>
              )}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 5,
              textAlign: 'center', justifySelf: 'start',
              background: row.sms_opted_out_source === 'keyword' ? '#FEF2F2' : '#FFFBEB',
              color: row.sms_opted_out_source === 'keyword' ? '#991B1B' : '#A16207',
              border: `1px solid ${row.sms_opted_out_source === 'keyword' ? '#FECACA' : '#FDE68A'}`,
            }}>
              {row.sms_opted_out_source === 'keyword' ? 'Replied STOP' : 'Admin paused'}
            </span>
            <span style={{ color: '#7A8BA0', fontSize: 12 }}>
              {row.sms_opted_out_at
                ? new Date(row.sms_opted_out_at).toLocaleDateString()
                : '—'}
            </span>
            <div style={{ justifySelf: 'end' }}>
              {allowResubscribe && onResubscribe ? (
                <button
                  className={btn.editBtn}
                  style={{ padding: '5px 10px', fontSize: 11 }}
                  disabled={updatingId === row.id}
                  onClick={() => onResubscribe(row)}
                >
                  {updatingId === row.id ? '…' : 'Re-subscribe'}
                </button>
              ) : (
                <span style={{ fontSize: 11, color: '#7A8BA0', fontStyle: 'italic' }}>
                  Manage from profile
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
