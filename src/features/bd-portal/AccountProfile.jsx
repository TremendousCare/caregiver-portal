import { useNavigate, useParams } from 'react-router-dom';
import { useBdAccountDetail } from './hooks/useBdAccountDetail';
import {
  formatActivityDate,
  formatAccountSubtitle,
  ACTIVITY_TYPE_ICONS,
  ACTIVITY_TYPE_LABELS,
  daysSince,
  isCold,
} from './lib/bdQueries';
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

  const cold = isCold(account);
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
          📷 Contact
        </button>
        <button
          type="button"
          className={s.referCta}
          onClick={() => navigate(`/bd/accounts/${account.id}/refer`)}
        >
          ⭐ Refer
        </button>
      </div>

      {/* Header */}
      <div className={s.card}>
        <h1 className={s.profileTitle}>
          {account.name}
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
              <a className={s.linkBtn} href={`tel:${account.phone}`}>📞 Call</a>
            )}
            {account.website && (
              <a className={s.linkBtn} href={account.website} target="_blank" rel="noreferrer">🌐 Website</a>
            )}
            {account.address && (
              <a
                className={s.linkBtn}
                href={`https://maps.apple.com/?q=${encodeURIComponent(account.address + (account.city ? ', ' + account.city : ''))}`}
                target="_blank"
                rel="noreferrer"
              >
                🗺️ Directions
              </a>
            )}
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
                <div style={{ minWidth: 0 }}>
                  <div className={s.contactName}>
                    {c.name}
                    {c.is_primary && <span className={`${s.roleBadge} ${s.primaryBadge}`}>primary</span>}
                    {c.role && <span className={s.roleBadge}>{c.role.replaceAll('_', ' ')}</span>}
                  </div>
                  {c.title && <div className={s.contactRole}>{c.title}</div>}
                </div>
                <div>
                  {c.phone_mobile && <a className={s.linkBtn} href={`tel:${c.phone_mobile}`}>📞</a>}
                  {c.email && <a className={s.linkBtn} href={`mailto:${c.email}`}>✉️</a>}
                </div>
              </div>
            ))}
          </div>
        )}
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
                  {ACTIVITY_TYPE_ICONS[a.activity_type] ?? '•'}
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
