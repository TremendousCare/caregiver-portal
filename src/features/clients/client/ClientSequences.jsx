import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';

// ─── ClientSequences Section ────────────────────────────────
export function ClientSequences({ client, currentUser, showToast }) {
  const [enrollments, setEnrollments] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showStartForm, setShowStartForm] = useState(false);
  const [selectedSequence, setSelectedSequence] = useState('');
  const [startFromStep, setStartFromStep] = useState(0);
  const [enrolling, setEnrolling] = useState(false);
  const [showPast, setShowPast] = useState(false);

  // ─── Load enrollments + available sequences ───
  const loadData = useCallback(async () => {
    try {
      const [enrollRes, seqRes] = await Promise.all([
        supabase
          .from('client_sequence_enrollments')
          .select('*, client_sequences(*)')
          .eq('client_id', client.id)
          .order('started_at', { ascending: false }),
        supabase
          .from('client_sequences')
          .select('*')
          .eq('enabled', true),
      ]);

      if (enrollRes.data) setEnrollments(enrollRes.data);
      if (seqRes.data) setSequences(seqRes.data);
    } catch (err) {
      console.warn('ClientSequences load error:', err);
    } finally {
      setLoading(false);
    }
  }, [client.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Realtime subscription ───
  useEffect(() => {
    const channel = supabase
      .channel(`enrollments-${client.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'client_sequence_enrollments',
        filter: `client_id=eq.${client.id}`,
      }, () => {
        loadData();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [client.id, loadData]);

  // ─── Start a sequence ───
  const handleStartSequence = async () => {
    if (!selectedSequence || enrolling) return;
    setEnrolling(true);

    try {
      const { error } = await supabase
        .from('client_sequence_enrollments')
        .insert({
          client_id: client.id,
          sequence_id: selectedSequence,
          status: 'active',
          current_step: startFromStep,
          started_by: currentUser?.email || 'unknown',
          start_from_step: startFromStep,
        });

      if (error) {
        if (error.code === '23505') {
          showToast?.('Client is already active in this sequence');
        } else {
          showToast?.('Failed to start sequence');
          console.warn('Enrollment error:', error);
        }
      } else {
        showToast?.('Sequence started!');
        setShowStartForm(false);
        setSelectedSequence('');
        setStartFromStep(0);
        loadData();
      }
    } catch (err) {
      showToast?.('Failed to start sequence');
    } finally {
      setEnrolling(false);
    }
  };

  // ─── Stop a sequence ───
  const handleStopSequence = async (enrollmentId) => {
    try {
      // Cancel enrollment
      await supabase
        .from('client_sequence_enrollments')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          cancel_reason: 'manual',
          cancelled_by: currentUser?.email || 'unknown',
        })
        .eq('id', enrollmentId);

      // Get the enrollment to cancel pending log rows
      const enrollment = enrollments.find((e) => e.id === enrollmentId);
      if (enrollment) {
        await supabase
          .from('client_sequence_log')
          .update({ status: 'cancelled' })
          .eq('sequence_id', enrollment.sequence_id)
          .eq('client_id', client.id)
          .eq('status', 'pending');

        // Add auto-note
        const seqName = enrollment.client_sequences?.name || 'Unknown';
        const currentNotes = Array.isArray(client.notes) ? client.notes : [];
        await supabase
          .from('clients')
          .update({
            notes: [...currentNotes, {
              text: `Sequence "${seqName}" manually cancelled by ${currentUser?.email || 'admin'}.`,
              type: 'auto',
              timestamp: Date.now(),
              author: 'System',
            }],
          })
          .eq('id', client.id);
      }

      showToast?.('Sequence stopped');
      loadData();
    } catch (err) {
      showToast?.('Failed to stop sequence');
    }
  };

  // ─── Derived data ───
  const activeEnrollments = enrollments.filter((e) => e.status === 'active');
  const pastEnrollments = enrollments.filter((e) => e.status !== 'active');

  // Sequences available for enrollment (not already active)
  const activeSequenceIds = new Set(activeEnrollments.map((e) => e.sequence_id));
  const availableSequences = sequences.filter((s) => !activeSequenceIds.has(s.id));

  const selectedSeqObj = sequences.find((s) => s.id === selectedSequence);
  const selectedSteps = selectedSeqObj?.steps || [];

  if (loading) return null;

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getCancelLabel = (enrollment) => {
    if (enrollment.cancel_reason === 'response_detected') {
      return 'Auto-cancelled — client responded';
    }
    if (enrollment.cancel_reason === 'manual') {
      return `Cancelled by ${enrollment.cancelled_by || 'admin'}`;
    }
    if (enrollment.cancel_reason === 'phase_changed') {
      return 'Cancelled — phase changed';
    }
    return 'Cancelled';
  };

  return (
    <div style={{
      background: '#fff', borderRadius: 16, padding: '20px 22px',
      border: '1px solid rgba(0,0,0,0.05)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.02)',
      marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#1E293B' }}>Sequences</span>
          {activeEnrollments.length > 0 && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              background: '#DBEAFE', color: '#1E40AF', fontWeight: 600,
            }}>
              {activeEnrollments.length} active
            </span>
          )}
        </div>
        <button
          onClick={() => setShowStartForm(!showStartForm)}
          style={{
            padding: '6px 14px', borderRadius: 8, border: 'none',
            background: '#10B981', color: '#fff', fontSize: 12,
            fontWeight: 600, cursor: 'pointer',
          }}
        >
          {showStartForm ? 'Cancel' : '+ Start Sequence'}
        </button>
      </div>

      {/* Start Sequence Form */}
      {showStartForm && (
        <div style={{
          background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
          padding: 16, marginBottom: 16,
        }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
              Select Sequence
            </label>
            <select
              value={selectedSequence}
              onChange={(e) => { setSelectedSequence(e.target.value); setStartFromStep(0); }}
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                border: '1px solid #D1D5DB', fontSize: 13, background: '#fff',
              }}
            >
              <option value="">Choose a sequence...</option>
              {availableSequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({(s.steps || []).length} steps){s.trigger_phase ? ` — triggers on ${s.trigger_phase}` : ' — manual only'}
                </option>
              ))}
            </select>
          </div>

          {selectedSequence && selectedSteps.length > 0 && (
            <>
              {/* Step preview */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                  Steps Preview
                </label>
                <div style={{ fontSize: 12, color: '#6B7280' }}>
                  {selectedSteps.map((step, idx) => (
                    <div key={idx} style={{
                      padding: '4px 8px', marginBottom: 2,
                      background: idx === startFromStep ? '#D1FAE5' : 'transparent',
                      borderRadius: 4,
                    }}>
                      Step {idx + 1}: {step.action_type === 'send_sms' ? 'SMS' : step.action_type === 'send_email' ? 'Email' : 'Task'}
                      {step.delay_hours > 0 ? ` (after ${step.delay_hours}h)` : ' (immediate)'}
                      {idx < startFromStep && ' ✓ skip'}
                    </div>
                  ))}
                </div>
              </div>

              {/* Start from step picker */}
              {selectedSteps.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
                    Start from step
                  </label>
                  <select
                    value={startFromStep}
                    onChange={(e) => setStartFromStep(Number(e.target.value))}
                    style={{
                      padding: '6px 10px', borderRadius: 6,
                      border: '1px solid #D1D5DB', fontSize: 13, background: '#fff',
                    }}
                  >
                    {selectedSteps.map((step, idx) => (
                      <option key={idx} value={idx}>
                        Step {idx + 1}: {step.action_type === 'send_sms' ? 'SMS' : step.action_type === 'send_email' ? 'Email' : 'Task'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                onClick={handleStartSequence}
                disabled={enrolling}
                style={{
                  padding: '8px 18px', borderRadius: 8, border: 'none',
                  background: enrolling ? '#9CA3AF' : '#059669', color: '#fff',
                  fontSize: 13, fontWeight: 600, cursor: enrolling ? 'not-allowed' : 'pointer',
                }}
              >
                {enrolling ? 'Starting...' : 'Confirm & Start'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Active Enrollments */}
      {activeEnrollments.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activeEnrollments.map((enrollment) => {
            const seq = enrollment.client_sequences;
            const totalSteps = seq?.steps?.length || 0;
            const progress = totalSteps > 0 ? Math.round((enrollment.current_step / totalSteps) * 100) : 0;

            return (
              <div key={enrollment.id} style={{
                border: '1px solid #E2E8F0', borderRadius: 10, padding: '12px 16px',
                background: '#FAFBFC',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 13, color: '#1E293B' }}>
                      {seq?.name || 'Unknown Sequence'}
                    </span>
                    {seq?.stop_on_response !== false && (
                      <span style={{
                        fontSize: 10, padding: '1px 5px', borderRadius: 4, marginLeft: 6,
                        background: '#D1FAE5', color: '#065F46',
                      }}>
                        Stops on response
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleStopSequence(enrollment.id)}
                    style={{
                      padding: '4px 12px', borderRadius: 6, border: '1px solid #FCA5A5',
                      background: '#FEF2F2', color: '#DC2626', fontSize: 11,
                      fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Stop
                  </button>
                </div>

                {/* Progress bar */}
                <div style={{
                  height: 6, background: '#E5E7EB', borderRadius: 3, marginBottom: 6, overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', width: `${progress}%`, background: '#10B981',
                    borderRadius: 3, transition: 'width 0.3s',
                  }} />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6B7280' }}>
                  <span>Step {enrollment.current_step} of {totalSteps}</span>
                  <span>Started {formatDate(enrollment.started_at)} by {enrollment.started_by === 'system' ? 'Auto' : enrollment.started_by}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', padding: '12px 0' }}>
          No active sequences for this client.
        </div>
      )}

      {/* Past Enrollments */}
      {pastEnrollments.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowPast(!showPast)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: '#6B7280', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {showPast ? '▾' : '▸'} Past Sequences ({pastEnrollments.length})
          </button>

          {showPast && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pastEnrollments.map((enrollment) => {
                const seq = enrollment.client_sequences;
                return (
                  <div key={enrollment.id} style={{
                    border: '1px solid #E5E7EB', borderRadius: 8, padding: '10px 14px',
                    background: '#F9FAFB', opacity: 0.8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 12, color: '#374151' }}>
                          {seq?.name || 'Unknown'}
                        </span>
                        <span style={{
                          fontSize: 10, padding: '1px 5px', borderRadius: 4, marginLeft: 6,
                          background: enrollment.status === 'completed' ? '#D1FAE5' : '#FEE2E2',
                          color: enrollment.status === 'completed' ? '#065F46' : '#991B1B',
                        }}>
                          {enrollment.status === 'completed' ? 'Completed' : getCancelLabel(enrollment)}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedSequence(enrollment.sequence_id);
                          setStartFromStep(0);
                          setShowStartForm(true);
                        }}
                        style={{
                          padding: '3px 10px', borderRadius: 6, border: '1px solid #D1D5DB',
                          background: '#fff', color: '#374151', fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Re-enroll
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
                      {formatDate(enrollment.started_at)} — {formatDate(enrollment.cancelled_at || enrollment.completed_at)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
