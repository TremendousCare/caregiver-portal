import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, Star, Phone, Globe, Map, Mail } from 'lucide-react';
import { useBdAccountDetail } from './hooks/useBdAccountDetail';
import {
  formatActivityDate,
  formatAccountSubtitle,
  ACTIVITY_TYPE_LABELS,
  daysSince,
  isCold,
  isProspect,
} from './lib/bdQueries';
import { ActivityTypeIcon } from './lib/activityTypeIcon';
import { updateAccountLocation } from './lib/bdMutations';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

function lastSeenLabel(account) {
  const d = daysSince(account?.last_activity_at);
  if (d === null || d === undefined) return 'Never visited';
  if (d === 0) return 'Last activity today';
  if (d === 1) return 'Last activity yesterday';
  return `Last activity ${d}d ago`;
}

function dollars(cents) {
  if (!cents) return null;
  return `$${(cents / 100).toFixed(0)}`;
}

export function AccountProfile() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const { loading, account, contacts, activities, error, refresh } = useBdAccountDetail(accountId);

  const [editingAddress, setEditingAddress] = useState(false);
  const [addrDraft, setAddrDraft]           = useState({ address: '', city: '', state: '', zip: '' });
  const [addrSaving, setAddrSaving]         = useState(false);
  const [addrError, setAddrError]           = useState('');

  function openAddressEditor() {
    setAddrDraft({
      address: account?.address ?? '',
      city:    account?.city    ?? '',
      state:   account?.state   ?? '',
      zip:     account?.zip     ?? '',
    });
    setAddrError('');
    setEditingAddress(true);
  }

  async function saveAddress() {
    setAddrError('');
    setAddrSaving(true);
    try {
      const { error: saveErr } = await updateAccountLocation(supabase, {
        accountId: account.id,
        draft: addrDraft,
      });
      if (saveErr) throw saveErr;
      setEditingAddress(false);
      refresh();
    } catch (e) {
      setAddrError(e?.message ?? 'Could not save address.');
    } finally {
      setAddrSaving(false);
    }
  }

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.detailHeader}>
          <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
        </div>
        <div className={s.empty}>Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={s.page}>
        <div className={s.detailHeader}>
          <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
        </div>
        <div className={s.error}>Couldn&rsquo;t load account: {error.message}</div>
        <button type="button" className={s.button} onClick={refresh}>Try again</button>
      </div>
    );
  }

  if (!account) {
    return (
      <div className={s.page}>
        <div className={s.detailHeader}>
          <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
        </div>
        <div className={s.empty}>Account not found.</div>
      </div>
    );
  }

  // Profile-level prospect check needs the live activity count (this
  // view doesn't get the pre-computed activity_count from the list
  // fetcher). We use the loaded activities array as the source of truth
  // and gate the prospect badge on source='research_import' AND no
  // logged activities — matching the same rule as `isProspect`. Once
  // the rep logs anything against the account the badge stops showing.
  const prospect = isProspect({
    source: account.source,
    activity_count: (activities ?? []).length,
  });
  const cold = !prospect && isCold(account);
  const subtitle = formatAccountSubtitle(account);

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
        <button
          type="button"
          className={s.logCta}
          onClick={() => navigate(`/bd/accounts/${account.id}/log`)}
          style={{ marginLeft: 'auto' }}
        >
          + Activity
        </button>
        <button
          type="button"
          className={s.contactCta}
          onClick={() => navigate(`/bd/accounts/${account.id}/contact`)}
        >
          <Camera size={16} strokeWidth={2} aria-hidden />
          <span>Contact</span>
        </button>
        <button
          type="button"
          className={s.referCta}
          onClick={() => navigate(`/bd/accounts/${account.id}/refer`)}
        >
          <Star size={16} strokeWidth={2} aria-hidden />
          <span>Refer</span>
        </button>
      </div>

      {/* Header */}
      <div className={s.card}>
        <h1 className={s.profileTitle}>
          {account.name}
          {prospect && <span className={`${s.tag} ${s.tagProspect}`}>prospect</span>}
          {cold && <span className={`${s.tag} ${s.tagCold}`}>cold</span>}
          {account.out_of_territory && <span className={s.tag}>out of territory</span>}
        </h1>
        <p className={s.profileSubtitle}>{subtitle}</p>
        <div className={s.profileMeta}>
          <span className={s.profileMetaItem}>{lastSeenLabel(account)}</span>
        </div>
        {(account.phone || account.website || account.address) && (
          <div>
            {account.phone && (
              <a className={s.linkBtn} href={`tel:${account.phone}`}>
                <Phone size={14} aria-hidden />
                <span>Call</span>
              </a>
            )}
            {account.website && (
              <a className={s.linkBtn} href={account.website} target="_blank" rel="noreferrer">
                <Globe size={14} aria-hidden />
                <span>Website</span>
              </a>
            )}
            {account.address && (
              <a
                className={s.linkBtn}
                href={`https://maps.apple.com/?q=${encodeURIComponent(account.address + (account.city ? ', ' + account.city : ''))}`}
                target="_blank"
                rel="noreferrer"
              >
                <Map size={14} aria-hidden />
                <span>Directions</span>
              </a>
            )}
          </div>
        )}

        {!account.address && !editingAddress && (
          <button
            type="button"
            className={s.addressCta}
            onClick={openAddressEditor}
            style={{ marginTop: 8 }}
          >
            + Add address
          </button>
        )}

        {editingAddress && (
          <div className={s.addressForm}>
            <input
              className={s.input}
              type="text"
              placeholder="Street address"
              value={addrDraft.address}
              onChange={(e) => setAddrDraft({ ...addrDraft, address: e.target.value })}
              autoFocus
            />
            <div className={s.addressRow}>
              <input
                className={s.input}
                type="text"
                placeholder="City"
                value={addrDraft.city}
                onChange={(e) => setAddrDraft({ ...addrDraft, city: e.target.value })}
              />
              <input
                className={s.input}
                type="text"
                placeholder="State"
                value={addrDraft.state}
                onChange={(e) => setAddrDraft({ ...addrDraft, state: e.target.value })}
                style={{ maxWidth: 72 }}
              />
              <input
                className={s.input}
                type="text"
                placeholder="Zip"
                inputMode="numeric"
                value={addrDraft.zip}
                onChange={(e) => setAddrDraft({ ...addrDraft, zip: e.target.value })}
                style={{ maxWidth: 96 }}
              />
            </div>
            {addrError && <div className={s.error}>{addrError}</div>}
            <div className={s.addressActions}>
              <button
                type="button"
                className={s.backBtn}
                onClick={() => setEditingAddress(false)}
                disabled={addrSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className={s.button}
                onClick={saveAddress}
                disabled={addrSaving}
                style={{ flex: 1 }}
              >
                {addrSaving ? 'Saving…' : 'Save address'}
              </button>
            </div>
          </div>
        )}
        {account.notes && (
          <p className={s.briefingText} style={{ marginTop: 8 }}>{account.notes}</p>
        )}
      </div>

      {/* Contacts */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Contacts ({contacts.length})</div>
        {contacts.length === 0 ? (
          <p className={s.empty}>No contacts yet.</p>
        ) : (
          <div>
            {contacts.map((c) => (
              <div key={c.id} className={s.contactRow}>
                <button
                  type="button"
                  className={s.contactRowBody}
                  onClick={() => navigate(`/bd/accounts/${account.id}/contact/${c.id}/edit`)}
                  aria-label={`Edit ${c.name}`}
                >
                  <div className={s.contactName}>
                    {c.name}
                    {c.is_primary && <span className={`${s.roleBadge} ${s.primaryBadge}`}>primary</span>}
                    {c.role && <span className={s.roleBadge}>{c.role.replaceAll('_', ' ')}</span>}
                  </div>
                  {c.title && <div className={s.contactRole}>{c.title}</div>}
                  {!c.phone_mobile && !c.phone_office && !c.email && (
                    <div className={s.contactMissing}>Tap to add phone / email</div>
                  )}
                </button>
                <div className={s.contactActions}>
                  {c.phone_mobile && (
                    <a
                      className={s.linkBtnIcon}
                      href={`tel:${c.phone_mobile}`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Call"
                    >
                      <Phone size={16} aria-hidden />
                    </a>
                  )}
                  {c.email && (
                    <a
                      className={s.linkBtnIcon}
                      href={`mailto:${c.email}`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Email"
                    >
                      <Mail size={16} aria-hidden />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className={s.contactAddRow}>
          <button
            type="button"
            className={s.addContactLink}
            onClick={() => navigate(`/bd/accounts/${account.id}/contact/new`)}
          >
            + Add contact manually
          </button>
          <button
            type="button"
            className={s.addContactLink}
            onClick={() => navigate(`/bd/accounts/${account.id}/contact`)}
          >
            <Camera size={14} aria-hidden />
            <span>Snap a card</span>
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Timeline ({activities.length})</div>
        {activities.length === 0 ? (
          <p className={s.empty}>No activity yet.</p>
        ) : (
          <div className={s.timeline}>
            {activities.map((a) => (
              <div key={a.id} className={s.timelineItem}>
                <div className={s.timelineIcon} aria-hidden>
                  <ActivityTypeIcon type={a.activity_type} size={18} />
                </div>
                <div className={s.timelineBody}>
                  <div className={s.timelineHeader}>
                    <span className={s.timelineType}>
                      {ACTIVITY_TYPE_LABELS[a.activity_type] ?? a.activity_type}
                      {a.spend_cents > 0 && <span className={s.spend}>{dollars(a.spend_cents)}</span>}
                    </span>
                    <span className={s.timelineDate}>{formatActivityDate(a.occurred_at)}</span>
                  </div>
                  {a.notes && <p className={s.timelineNotes}>{a.notes}</p>}
                  {a.created_by && <div className={s.timelineAuthor}>— {a.created_by}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
