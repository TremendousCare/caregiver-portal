import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useApp } from '../../../shared/context/AppContext';
import { deriveInterviewCardState } from '../../../../supabase/functions/_shared/helpers/bookings.ts';
import s from './InterviewCard.module.css';

// Module-level cache for staff name lookups. Microsoft Bookings staff
// directories don't change often and `list_staff` is the same call for
// every caregiver in the org. Keyed by `${businessId}:${staffId}`.
// Survives across InterviewCard mounts within a single page load.
const staffNameCache = new Map();

function formatLong(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

function formatRelative(iso, now = Date.now()) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMs = ts - now;
  const future = diffMs >= 0;
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60000);
  const hours = Math.round(absMs / 3600000);
  const days = Math.round(absMs / 86400000);
  let phrase;
  if (minutes < 60) phrase = `${minutes} min`;
  else if (hours < 24) phrase = `${hours} hr`;
  else phrase = `${days} day${days === 1 ? '' : 's'}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

export function InterviewCard({ caregiver, showToast }) {
  const { currentOrgSettings } = useApp();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staffName, setStaffName] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const bookingsConfig = currentOrgSettings?.bookings || {};
  const publicUrl = bookingsConfig.public_url || '';
  const businessId = bookingsConfig.business_id || '';

  // ── Fetch latest interview row for this caregiver ──
  const fetchRow = useCallback(async () => {
    if (!supabase || !caregiver?.id) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('caregiver_interviews')
      .select('*')
      .eq('caregiver_id', caregiver.id)
      .order('start_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    setRow(data || null);
    setLoading(false);
  }, [caregiver?.id]);

  useEffect(() => {
    setLoading(true);
    fetchRow();
  }, [fetchRow]);

  // ── Realtime subscription so the 5-minute poll's writes show up live ──
  useEffect(() => {
    if (!supabase || !caregiver?.id) return;
    const channel = supabase
      .channel(`interview-card-${caregiver.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'caregiver_interviews', filter: `caregiver_id=eq.${caregiver.id}` },
        () => fetchRow(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [caregiver?.id, fetchRow]);

  // ── Resolve staff name. Option A: read default_staff_id from
  //    org settings, fetch list_staff once, cache by (business, staff).
  //    TODO Option B (multi-staff): cache table or per-org staff
  //    directory once a second recruiter joins. ──
  useEffect(() => {
    const staffId = (row?.staff_member_ids && row.staff_member_ids[0]) || bookingsConfig.default_staff_id;
    if (!staffId || !businessId) { setStaffName(''); return; }
    const cacheKey = `${businessId}:${staffId}`;
    if (staffNameCache.has(cacheKey)) {
      setStaffName(staffNameCache.get(cacheKey));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { data, error } = await supabase.functions.invoke('bookings-integration', {
          body: { action: 'list_staff', business_id: businessId },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (error || data?.error) return;
        const list = data?.staff || [];
        for (const member of list) {
          staffNameCache.set(`${businessId}:${member.id}`, member.display_name || '');
        }
        if (!cancelled) {
          setStaffName(staffNameCache.get(cacheKey) || '');
        }
      } catch {
        // Non-fatal — card still renders without staff name.
      }
    })();
    return () => { cancelled = true; };
  }, [businessId, bookingsConfig.default_staff_id, row?.staff_member_ids]);

  const state = useMemo(() => deriveInterviewCardState(row, Date.now()), [row]);

  const copyLink = useCallback(async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      showToast?.('Booking link copied to clipboard');
    } catch {
      showToast?.(`Booking link: ${publicUrl}`);
    }
  }, [publicUrl, showToast]);

  const openReschedule = useCallback(() => {
    if (!publicUrl) return;
    window.open(publicUrl, '_blank', 'noopener,noreferrer');
  }, [publicUrl]);

  const handleCancel = useCallback(async () => {
    if (!row?.graph_appointment_id || !businessId) return;
    if (!window.confirm('Cancel this interview? Microsoft will email the caregiver a cancellation notice.')) return;
    setCancelling(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data, error } = await supabase.functions.invoke('bookings-integration', {
        body: {
          action: 'cancel_appointment',
          business_id: businessId,
          appointment_id: row.graph_appointment_id,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      showToast?.('Interview cancelled.');
      // Realtime should refresh the row, but refetch as a safety net.
      await fetchRow();
    } catch (err) {
      console.error('Cancel failed:', err);
      showToast?.(`Cancel failed: ${err.message || 'Unknown error'}`);
    } finally {
      setCancelling(false);
    }
  }, [row?.graph_appointment_id, businessId, fetchRow, showToast]);

  if (loading) return null;

  // ── State-specific rendering ──
  let badge, badgeClass, cardClass, title, subtitle, actions;

  if (state === 'not_yet_booked') {
    badge = 'Not Booked';
    badgeClass = s.badgeNeutral;
    cardClass = s.card;
    title = 'No interview scheduled yet';
    subtitle = publicUrl
      ? 'Share the booking link so the caregiver can pick a time.'
      : 'Bookings is not configured for this organization.';
    actions = publicUrl ? (
      <>
        <button className={`${s.btn} ${s.btnSecondary}`} onClick={copyLink}>Copy Booking Link</button>
        <a className={`${s.btn} ${s.btnSecondary}`} href={publicUrl} target="_blank" rel="noopener noreferrer">Open Page</a>
      </>
    ) : null;
  } else if (state === 'booked') {
    badge = 'Booked';
    badgeClass = s.badgeBooked;
    cardClass = `${s.card} ${s.cardBooked}`;
    const when = formatLong(row.start_at);
    const rel = formatRelative(row.start_at);
    title = when ? `${when}${rel ? `  (${rel})` : ''}` : 'Booked';
    subtitle = staffName ? `with ${staffName}` : '';
    actions = (
      <>
        {row.join_web_url && (
          <a className={`${s.btn} ${s.btnPrimary}`} href={row.join_web_url} target="_blank" rel="noopener noreferrer">
            Join Teams
          </a>
        )}
        {publicUrl && (
          <button className={`${s.btn} ${s.btnSecondary}`} onClick={openReschedule}>
            Reschedule
          </button>
        )}
        <button
          className={`${s.btn} ${s.btnDanger} ${cancelling ? s.btnDisabled : ''}`}
          onClick={handleCancel}
          disabled={cancelling}
        >
          {cancelling ? 'Cancelling...' : 'Cancel'}
        </button>
      </>
    );
  } else if (state === 'cancelled') {
    badge = 'Cancelled';
    badgeClass = s.badgeCancelled;
    cardClass = `${s.card} ${s.cardCancelled}`;
    const when = formatLong(row.start_at);
    title = 'Interview cancelled';
    subtitle = when ? `was scheduled for ${when}` : '';
    actions = publicUrl ? (
      <button className={`${s.btn} ${s.btnSecondary}`} onClick={copyLink}>Copy Booking Link</button>
    ) : null;
  } else {
    // completed
    badge = 'Completed';
    badgeClass = s.badgeCompleted;
    cardClass = `${s.card} ${s.cardCompleted}`;
    const when = formatLong(row.start_at);
    const rel = formatRelative(row.start_at);
    title = when ? `Completed ${rel ? rel : when}` : 'Interview completed';
    subtitle = [staffName ? `with ${staffName}` : '', when].filter(Boolean).join(' · ');
    actions = null;
  }

  return (
    <div className={cardClass}>
      <div className={s.header}>
        <span className={s.headerIcon}>{'\u{1F4C5}'}</span>
        <span className={s.headerTitle}>Interview</span>
        <span className={`${s.badge} ${badgeClass}`}>{badge}</span>
      </div>
      <div className={s.title}>{title}</div>
      {subtitle && <div className={s.subtitle}>{subtitle}</div>}
      {actions && <div className={s.actionsRow}>{actions}</div>}
    </div>
  );
}
