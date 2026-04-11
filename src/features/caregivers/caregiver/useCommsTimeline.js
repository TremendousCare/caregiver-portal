import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../../../lib/supabase';

/**
 * Shared hook for fetching and merging communication timeline data.
 * Used by both ActivityLog and MessagingCenter.
 *
 * Fetches RingCentral data (SMS + calls) and Outlook data (emails),
 * merges with portal notes, and deduplicates entries that appear in both sources.
 */
export function useCommsTimeline(caregiver) {
  const [rcData, setRcData] = useState({ sms: [], calls: [] });
  const [rcLoading, setRcLoading] = useState(false);
  const [outlookEmails, setOutlookEmails] = useState([]);
  const [emailLoading, setEmailLoading] = useState(false);
  const accessTokenRef = useRef('');

  // Get Supabase access token for recording playback URLs
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      accessTokenRef.current = session?.access_token || '';
    });
  }, []);

  // Fetch RingCentral communication data
  useEffect(() => {
    if (!caregiver?.id || !supabase) return;
    let cancelled = false;
    setRcLoading(true);
    supabase.functions.invoke('get-communications', {
      body: { caregiver_id: caregiver.id, days_back: 90 },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        console.warn('RC fetch failed:', error);
        setRcData({ sms: [], calls: [] });
      } else {
        setRcData({ sms: data.sms || [], calls: data.calls || [] });
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('RC fetch error:', err);
        setRcData({ sms: [], calls: [] });
      }
    }).finally(() => {
      if (!cancelled) setRcLoading(false);
    });
    return () => { cancelled = true; };
  }, [caregiver?.id]);

  // Fetch Outlook email history for this caregiver
  useEffect(() => {
    if (!caregiver?.email || !supabase) return;
    let cancelled = false;
    setEmailLoading(true);
    supabase.functions.invoke('outlook-integration', {
      body: {
        action: 'search_emails',
        email_address: caregiver.email,
        days_back: 90,
        limit: 25,
      },
    }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data || !data.emails) {
        console.warn('Outlook email fetch failed:', error);
        setOutlookEmails([]);
      } else {
        // Transform Outlook results into note-like format
        const transformed = data.emails.map((e) => ({
          id: `outlook-${e.id}`,
          type: 'email',
          source: 'outlook',
          direction: e.from?.toLowerCase() === caregiver.email?.toLowerCase() ? 'inbound' : 'outbound',
          subject: e.subject,
          text: `Email — Subject: ${e.subject}\n\n${e.preview || ''}`,
          fullBody: null, // lazy-loaded on thread expand
          timestamp: new Date(e.date).getTime(),
          author: e.from_name || e.from,
          conversationId: e.conversation_id,
          outlookId: e.id,
          hasAttachments: e.has_attachments || false,
        }));
        setOutlookEmails(transformed);
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('Outlook email fetch error:', err);
        setOutlookEmails([]);
      }
    }).finally(() => {
      if (!cancelled) setEmailLoading(false);
    });
    return () => { cancelled = true; };
  }, [caregiver?.email]);

  // Merge portal notes + RC data into unified timeline (newest first)
  const mergedTimeline = useMemo(() => {
    const portalEntries = (caregiver.notes || []).map((n, i) => ({
      ...n,
      id: `portal-${i}`,
      source: n.source || 'portal',
      timestamp: n.timestamp || n.date,
    }));

    const rcEntries = [...rcData.sms, ...rcData.calls];

    // Deduplication: skip RC entries that match portal notes within 2 minutes
    const portalOutboundTexts = portalEntries.filter(
      (n) => n.type === 'text' && n.direction === 'outbound' && n.source === 'portal'
    );
    const portalRCNotes = portalEntries.filter((n) => n.source === 'ringcentral');
    const deduped = rcEntries.filter((rc) => {
      const rcTime = new Date(rc.timestamp).getTime();
      if (rc.type === 'text' && rc.direction === 'outbound') {
        if (portalOutboundTexts.some((pn) => Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000)) return false;
      }
      if (portalRCNotes.some((pn) => {
        if (pn.type !== rc.type || pn.direction !== rc.direction) return false;
        return Math.abs(rcTime - new Date(pn.timestamp).getTime()) < 120000;
      })) return false;
      return true;
    });

    // Deduplicate Outlook emails against portal email notes
    // Match by subject + timestamp within 5 minutes
    const portalEmails = portalEntries.filter((n) => n.type === 'email');
    const dedupedOutlook = outlookEmails.filter((oe) => {
      const oeTime = new Date(oe.timestamp).getTime();
      const oeSubject = (oe.subject || '').toLowerCase();
      return !portalEmails.some((pe) => {
        const peSubject = (pe.subject || '').toLowerCase();
        // Also check the text field for legacy notes: "Email sent — Subject: ..."
        const peTextSubject = (pe.text || '').toLowerCase();
        const subjectMatch = (peSubject && oeSubject.includes(peSubject))
          || (oeSubject && peTextSubject.includes(oeSubject))
          || (peSubject && peSubject.includes(oeSubject));
        const timeMatch = Math.abs(oeTime - new Date(pe.timestamp).getTime()) < 300000; // 5 min
        return subjectMatch && timeMatch;
      });
    });

    return [...portalEntries, ...deduped, ...dedupedOutlook].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [caregiver.notes, rcData, outlookEmails]);

  // SMS messages sorted chronologically (oldest first) for chat view
  const smsMessages = useMemo(() => {
    return mergedTimeline
      .filter((n) => n.type === 'text')
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [mergedTimeline]);

  // Email messages (newest first)
  const emailMessages = useMemo(() => {
    return mergedTimeline.filter((n) => n.type === 'email');
  }, [mergedTimeline]);

  // Call + voicemail entries (newest first)
  const callEntries = useMemo(() => {
    return mergedTimeline.filter((n) => n.type === 'call' || n.type === 'voicemail');
  }, [mergedTimeline]);

  // "Needs response" detection: most recent SMS is inbound with no subsequent outbound
  const needsResponse = useMemo(() => {
    if (smsMessages.length === 0) return false;
    const mostRecent = smsMessages[smsMessages.length - 1]; // last = newest (sorted ASC)
    if (mostRecent.direction !== 'inbound') return false;
    const age = Date.now() - new Date(mostRecent.timestamp).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return false; // older than 7 days
    return true;
  }, [smsMessages]);

  const refreshComms = () => {
    if (!caregiver?.id || !supabase) return;
    setRcLoading(true);
    supabase.functions.invoke('get-communications', {
      body: { caregiver_id: caregiver.id, days_back: 90 },
    }).then(({ data, error }) => {
      if (error || !data) {
        setRcData({ sms: [], calls: [] });
      } else {
        setRcData({ sms: data.sms || [], calls: data.calls || [] });
      }
    }).catch(() => {
      setRcData({ sms: [], calls: [] });
    }).finally(() => {
      setRcLoading(false);
    });
  };

  return {
    mergedTimeline,
    smsMessages,
    emailMessages,
    callEntries,
    rcLoading,
    emailLoading,
    accessToken: accessTokenRef,
    needsResponse,
    refreshComms,
  };
}
