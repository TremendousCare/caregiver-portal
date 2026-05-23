import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useApp } from '../shared/context/AppContext';
import { updateOrgSettings } from '../features/accounting/storage';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';

// Lead Notification Settings card.
//
// Backs `organizations.settings.lead_notifications`. Saves go through
// the existing org-settings-update edge function which gates on admin
// role + validates the patch shape (see PR 2 changes in
// supabase/functions/org-settings-update/index.ts).
//
// Recipient picker reads from team_members so a single directory is the
// source of truth for name + phone — changing a team member's phone in
// Settings → Team Members updates outbound SMS targeting on the next
// notification with no edit here required.
//
// SMS section hides team members who do not have a phone on file
// (sending SMS to nobody is silent failure — easier to surface the
// "fix the team directory first" hint by greying the option out).

const TZ_OPTIONS = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'UTC',
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);

function formatHour(h) {
  if (h === 0) return '12:00 AM (midnight)';
  if (h === 12) return '12:00 PM (noon)';
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}

function isValidHttpsOrEmpty(value) {
  if (!value) return true;
  return /^https:\/\/[^\s]+$/.test(value);
}

export function LeadNotificationSettings({ showToast }) {
  const { currentOrgSettings, refreshOrgSettings } = useApp();
  const config = currentOrgSettings?.lead_notifications || {};

  const [teamMembers, setTeamMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [saving, setSaving] = useState(false);

  // Local draft state, hydrated from currentOrgSettings. Mutated by
  // every form input; flushed on Save.
  const [draftEnabled, setDraftEnabled] = useState(config.enabled === true);
  const [draftSmsEmails, setDraftSmsEmails] = useState(
    Array.isArray(config.sms_recipient_emails) ? config.sms_recipient_emails : [],
  );
  const [draftTeamsUrl, setDraftTeamsUrl] = useState(
    typeof config.teams_webhook_url === 'string' ? config.teams_webhook_url : '',
  );
  const [draftToastEmails, setDraftToastEmails] = useState(
    Array.isArray(config.toast_recipient_emails) ? config.toast_recipient_emails : [],
  );
  const [draftQuietStart, setDraftQuietStart] = useState(
    Number.isInteger(config.quiet_hours_start_hour) ? config.quiet_hours_start_hour : 21,
  );
  const [draftQuietEnd, setDraftQuietEnd] = useState(
    Number.isInteger(config.quiet_hours_end_hour) ? config.quiet_hours_end_hour : 7,
  );
  const [draftQuietTz, setDraftQuietTz] = useState(
    typeof config.quiet_hours_timezone === 'string' && config.quiet_hours_timezone
      ? config.quiet_hours_timezone
      : 'America/Los_Angeles',
  );

  // Re-hydrate when settings reload (after a save, or after the app
  // refreshes the org settings from another tab).
  useEffect(() => {
    const c = currentOrgSettings?.lead_notifications || {};
    setDraftEnabled(c.enabled === true);
    setDraftSmsEmails(Array.isArray(c.sms_recipient_emails) ? c.sms_recipient_emails : []);
    setDraftTeamsUrl(typeof c.teams_webhook_url === 'string' ? c.teams_webhook_url : '');
    setDraftToastEmails(Array.isArray(c.toast_recipient_emails) ? c.toast_recipient_emails : []);
    setDraftQuietStart(Number.isInteger(c.quiet_hours_start_hour) ? c.quiet_hours_start_hour : 21);
    setDraftQuietEnd(Number.isInteger(c.quiet_hours_end_hour) ? c.quiet_hours_end_hour : 7);
    setDraftQuietTz(
      typeof c.quiet_hours_timezone === 'string' && c.quiet_hours_timezone
        ? c.quiet_hours_timezone
        : 'America/Los_Angeles',
    );
  }, [currentOrgSettings]);

  // Load active team members for the recipient pickers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('team_members')
          .select('email, display_name, job_title, personal_phone, is_active')
          .order('display_name', { ascending: true });
        if (error) throw error;
        if (!cancelled) {
          setTeamMembers((data || []).filter((m) => m.is_active !== false));
        }
      } catch (err) {
        console.error('LeadNotificationSettings: failed to load team_members', err);
      } finally {
        if (!cancelled) setLoadingMembers(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Members eligible for SMS (must have a phone on file). Stable
  // reference — useMemo so the checklist doesn't re-render on every
  // keystroke elsewhere in the form.
  const smsEligibleMembers = useMemo(
    () => teamMembers.filter((m) => m.personal_phone && m.personal_phone.trim()),
    [teamMembers],
  );

  function toggleEmailInList(list, email, setter) {
    const lower = email.toLowerCase();
    const isPresent = list.some((e) => e.toLowerCase() === lower);
    if (isPresent) {
      setter(list.filter((e) => e.toLowerCase() !== lower));
    } else {
      setter([...list, email]);
    }
  }

  async function save() {
    if (!isValidHttpsOrEmpty(draftTeamsUrl)) {
      showToast?.('Teams webhook URL must start with https:// (or be left blank).');
      return;
    }
    setSaving(true);
    try {
      await updateOrgSettings({
        section: 'lead_notifications',
        patch: {
          enabled: draftEnabled,
          sms_recipient_emails: draftSmsEmails,
          teams_webhook_url: draftTeamsUrl.trim(),
          toast_recipient_emails: draftToastEmails,
          quiet_hours_start_hour: Number(draftQuietStart),
          quiet_hours_end_hour: Number(draftQuietEnd),
          quiet_hours_timezone: draftQuietTz,
        },
      });
      await refreshOrgSettings?.();
      showToast?.('Lead notification settings saved.');
    } catch (err) {
      showToast?.(`Save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleCard title="Lead Notifications" description="New-lead alerts via SMS, Teams, and in-portal">
      <div style={{ padding: '20px 24px' }}>
        {/* ── Enable toggle ── */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draftEnabled}
              onChange={(e) => setDraftEnabled(e.target.checked)}
              disabled={saving}
            />
            <span>
              Lead notifications are <strong>{draftEnabled ? 'ON' : 'OFF'}</strong>
            </span>
          </label>
          <p style={{ fontSize: 12, color: '#7A8BA0', marginTop: 6, marginLeft: 26, lineHeight: 1.5 }}>
            When ON, every new client lead entering the pipeline triggers an SMS to the configured recipients,
            a post in the Teams channel, and an in-portal toast for the named users.
            Quiet hours (set below) defer SMS and Teams to morning; in-portal toasts always fire immediately.
          </p>
        </div>

        {/* ── SMS recipients ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>SMS recipients</div>
          <p style={{ fontSize: 12, color: '#7A8BA0', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
            Each checked team member receives a text on every new lead.
            Only team members with a phone number in Settings &rarr; Team Members are listed here.
          </p>
          {loadingMembers ? (
            <div style={{ fontSize: 13, color: '#7A8BA0' }}>Loading team members&hellip;</div>
          ) : smsEligibleMembers.length === 0 ? (
            <div style={{ fontSize: 13, color: '#7A8BA0', fontStyle: 'italic' }}>
              No team members have a phone number on file. Add one in Settings &rarr; Team Members first.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
              {smsEligibleMembers.map((m) => {
                const checked = draftSmsEmails.some((e) => e.toLowerCase() === m.email.toLowerCase());
                return (
                  <label key={m.email} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, padding: '8px 10px', border: '1px solid #E0E4EA', borderRadius: 10, cursor: 'pointer', background: checked ? '#F0F7FF' : '#fff' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmailInList(draftSmsEmails, m.email, setDraftSmsEmails)}
                      disabled={saving}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{m.display_name || m.email}</div>
                      <div style={{ fontSize: 11, color: '#7A8BA0' }}>{m.email}</div>
                      <div style={{ fontSize: 11, color: '#7A8BA0' }}>{m.personal_phone}</div>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Teams webhook ── */}
        <div style={{ marginBottom: 24 }}>
          <label className={forms.field}>
            <span className={forms.fieldLabel}>Microsoft Teams channel webhook URL</span>
            <input
              type="text"
              className={forms.fieldInput}
              value={draftTeamsUrl}
              onChange={(e) => setDraftTeamsUrl(e.target.value)}
              placeholder="https://prod-XX.westus.logic.azure.com:443/workflows/..."
              disabled={saving}
            />
          </label>
          <p style={{ fontSize: 12, color: '#7A8BA0', marginTop: 6, lineHeight: 1.5 }}>
            In Teams, create a Power Automate workflow with the &ldquo;When a Teams webhook request is received&rdquo; trigger
            followed by a &ldquo;Post message in a chat or channel&rdquo; action targeting your sales channel.
            Save the workflow, copy the HTTP POST URL it generates, and paste it here.
            Leave blank to skip the Teams channel post.
          </p>
        </div>

        {/* ── In-portal toast recipients ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>In-portal toast recipients</div>
          <p style={{ fontSize: 12, color: '#7A8BA0', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
            Pops a toast and increments the bell-icon unread count for the checked users while they have the portal open.
            Always fires immediately, even during quiet hours.
          </p>
          {loadingMembers ? (
            <div style={{ fontSize: 13, color: '#7A8BA0' }}>Loading team members&hellip;</div>
          ) : teamMembers.length === 0 ? (
            <div style={{ fontSize: 13, color: '#7A8BA0', fontStyle: 'italic' }}>
              No team members configured. Add them in Settings &rarr; Team Members.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
              {teamMembers.map((m) => {
                const checked = draftToastEmails.some((e) => e.toLowerCase() === m.email.toLowerCase());
                return (
                  <label key={m.email} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, padding: '8px 10px', border: '1px solid #E0E4EA', borderRadius: 10, cursor: 'pointer', background: checked ? '#F0F7FF' : '#fff' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmailInList(draftToastEmails, m.email, setDraftToastEmails)}
                      disabled={saving}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{m.display_name || m.email}</div>
                      <div style={{ fontSize: 11, color: '#7A8BA0' }}>{m.email}</div>
                      {m.job_title ? <div style={{ fontSize: 11, color: '#7A8BA0' }}>{m.job_title}</div> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Quiet hours ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Quiet hours</div>
          <p style={{ fontSize: 12, color: '#7A8BA0', marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
            SMS and Teams posts received between these hours are deferred until end-of-quiet-hours the next morning.
            In-portal toasts ignore this window. Hours are in the timezone selected below.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label className={forms.field}>
              <span className={forms.fieldLabel}>Quiet starts at</span>
              <select
                className={forms.fieldInput}
                value={draftQuietStart}
                onChange={(e) => setDraftQuietStart(Number(e.target.value))}
                disabled={saving}
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{formatHour(h)}</option>
                ))}
              </select>
            </label>
            <label className={forms.field}>
              <span className={forms.fieldLabel}>Quiet ends at</span>
              <select
                className={forms.fieldInput}
                value={draftQuietEnd}
                onChange={(e) => setDraftQuietEnd(Number(e.target.value))}
                disabled={saving}
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h} value={h}>{formatHour(h)}</option>
                ))}
              </select>
            </label>
            <label className={forms.field}>
              <span className={forms.fieldLabel}>Timezone</span>
              <select
                className={forms.fieldInput}
                value={draftQuietTz}
                onChange={(e) => setDraftQuietTz(e.target.value)}
                disabled={saving}
              >
                {TZ_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* ── Save ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid #E0E4EA', paddingTop: 16 }}>
          <button
            type="button"
            className={btn.primaryBtn}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save Lead Notification Settings'}
          </button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
