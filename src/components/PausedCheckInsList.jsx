import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { setCaregiverAvailabilityCheckPaused } from '../lib/storage';
import btn from '../styles/buttons.module.css';
import cards from '../styles/cards.module.css';

// ═══════════════════════════════════════════════════════════════
// Paused Check-Ins List (Admin Settings → Automations area)
//
// Shows every caregiver who has been manually paused from the
// recurring availability check-in automation. Separate from the
// global SMS Opt-Outs list — a caregiver paused here still gets
// shift offers and other SMS. Only the "update your availability"
// recurring reminder is suppressed.
//
// Companion to the per-caregiver toggle on the Profile Card. Admins
// can see the full list in one place and resume any caregiver with
// one click.
// ═══════════════════════════════════════════════════════════════

export function PausedCheckInsList({ showToast }) {
  const [loading, setLoading] = useState(true);
  const [caregivers, setCaregivers] = useState([]);
  const [updatingId, setUpdatingId] = useState(null);

  const load = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('caregivers')
        .select(
          'id, first_name, last_name, phone, availability_check_paused_at, availability_check_paused_reason',
        )
        .eq('availability_check_paused', true)
        .order('availability_check_paused_at', { ascending: false });
      if (error) throw error;
      setCaregivers(data || []);
    } catch (err) {
      console.error('Failed to load paused check-ins list:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleResume = async (row) => {
    const name =
      `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.id;
    if (
      !window.confirm(
        `Resume availability check-ins for ${name}? They will start receiving the recurring "update your availability" texts again.`,
      )
    ) {
      return;
    }
    setUpdatingId(row.id);
    try {
      await setCaregiverAvailabilityCheckPaused(row.id, false);
      setCaregivers((prev) => prev.filter((r) => r.id !== row.id));
      showToast?.(`Resumed ${name}`);
    } catch (err) {
      console.error('Failed to resume:', err);
      showToast?.('Failed to resume. Please try again.');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <div>
          <h3 className={cards.profileCardTitle}>Paused Availability Check-Ins</h3>
          <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>
            Caregivers who will be skipped by the recurring availability reminder
          </span>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 28,
            height: 22,
            padding: '0 8px',
            borderRadius: 11,
            background: caregivers.length > 0 ? '#FFFBEB' : '#F0FDF4',
            color: caregivers.length > 0 ? '#A16207' : '#15803D',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {caregivers.length}
        </span>
      </div>
      <div style={{ padding: '16px 24px 20px' }}>
        {loading ? (
          <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading…</div>
        ) : caregivers.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '24px 16px',
              color: '#7A8BA0',
              border: '1px dashed #E0E4EA',
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            No caregivers are paused. Everyone is on the recurring availability
            check-in rotation.
          </div>
        ) : (
          <div
            style={{
              border: '1px solid #E0E4EA',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            {caregivers.map((row, i) => (
              <div
                key={row.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 140px auto',
                  alignItems: 'center',
                  padding: '10px 14px',
                  borderBottom:
                    i < caregivers.length - 1 ? '1px solid #F0F3F7' : 'none',
                  background: i % 2 === 0 ? '#fff' : '#FAFBFC',
                  fontSize: 13,
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: '#0F1724' }}>
                    {`${row.first_name || ''} ${row.last_name || ''}`.trim() || row.id}
                    {row.phone && (
                      <span
                        style={{
                          color: '#7A8BA0',
                          fontWeight: 400,
                          marginLeft: 8,
                        }}
                      >
                        {row.phone}
                      </span>
                    )}
                  </div>
                  {row.availability_check_paused_reason && (
                    <div
                      style={{
                        color: '#7A8BA0',
                        fontSize: 12,
                        fontStyle: 'italic',
                        marginTop: 2,
                      }}
                    >
                      "{row.availability_check_paused_reason}"
                    </div>
                  )}
                </div>
                <span style={{ color: '#7A8BA0', fontSize: 12 }}>
                  {row.availability_check_paused_at
                    ? `Paused ${new Date(
                        row.availability_check_paused_at,
                      ).toLocaleDateString()}`
                    : '—'}
                </span>
                <div style={{ justifySelf: 'end' }}>
                  <button
                    className={btn.editBtn}
                    style={{ padding: '5px 10px', fontSize: 11 }}
                    disabled={updatingId === row.id}
                    onClick={() => handleResume(row)}
                  >
                    {updatingId === row.id ? '…' : 'Resume'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && caregivers.length > 0 && (
          <div
            style={{
              fontSize: 11,
              color: '#7A8BA0',
              fontStyle: 'italic',
              marginTop: 10,
            }}
          >
            Pausing a caregiver here only affects the recurring availability
            check-in. Shift offers, confirmations, and other SMS continue to
            send normally.
          </div>
        )}
      </div>
    </div>
  );
}
