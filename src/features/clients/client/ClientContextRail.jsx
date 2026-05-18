import {
  Phone,
  Mail,
  MapPin,
  Heart,
  Clock as ClockIcon,
  CalendarDays,
  Wallet,
  Megaphone,
  Pencil,
} from 'lucide-react';
import { CLIENT_PRIORITIES } from '../constants';
import { getDaysSinceCreated } from '../utils';

// ClientContextRail
// =================
// Sticky right-side rail that surfaces the highest-value client
// metadata at all times while the rep is working in the main column.
// Read-only — for editing, the "Edit details" button scrolls down to
// the full ClientProfileCard which is the canonical edit surface.
//
// Scope choice: surface only the fields a rep needs glance access to
// during a call or follow-up. The full ~20-field ClientProfileCard
// stays as the authoritative edit form below — the rail is for
// orientation, the card is for changes.

export function ClientContextRail({ client, onEdit }) {
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const showPriority = priorityInfo && priorityInfo.id !== 'normal';
  const days = getDaysSinceCreated(client);
  const fullAddress = [client.address, client.city, client.state, client.zip].filter(Boolean).join(', ');
  const mapsHref = fullAddress
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`
    : null;
  const hasAnyContact = client.phone || client.email || fullAddress;
  const hasAnyRecipient = client.careRecipientName || client.careRecipientAge || client.relationship;
  const hasAnyNeeds = client.hoursNeeded || client.startDatePreference || client.budgetRange;
  const hasSource = client.referralSource || client.referralDetail;

  return (
    <aside style={styles.rail} aria-label="Client quick info">
      <header style={styles.railHeader}>
        <span style={styles.railTitle}>Quick info</span>
        <span style={styles.dayCount}>Day {days}</span>
      </header>

      {showPriority && (
        <div style={{
          ...styles.priorityBadge,
          background: `${priorityInfo.color}18`,
          color: priorityInfo.color,
          border: `1px solid ${priorityInfo.color}30`,
        }}>
          {priorityInfo.label} priority
        </div>
      )}

      {hasAnyContact && (
        <Section title="Contact">
          {client.phone && (
            <Row icon={Phone} label="Phone">
              <a href={`tel:${client.phone}`} style={styles.link}>{client.phone}</a>
            </Row>
          )}
          {client.email && (
            <Row icon={Mail} label="Email">
              <a href={`mailto:${client.email}`} style={styles.link}>{client.email}</a>
            </Row>
          )}
          {fullAddress && (
            <Row icon={MapPin} label="Address">
              {mapsHref ? (
                <a href={mapsHref} target="_blank" rel="noreferrer" style={styles.link}>
                  {fullAddress}
                </a>
              ) : fullAddress}
            </Row>
          )}
        </Section>
      )}

      {hasAnyRecipient && (
        <Section title="Care recipient">
          {client.careRecipientName && (
            <Row icon={Heart} label="Name">
              {client.careRecipientName}
              {client.careRecipientAge ? `, ${client.careRecipientAge}` : ''}
            </Row>
          )}
          {client.relationship && (
            <Row label="Relationship">{client.relationship}</Row>
          )}
        </Section>
      )}

      {hasAnyNeeds && (
        <Section title="Needs">
          {client.hoursNeeded && (
            <Row icon={ClockIcon} label="Hours">{client.hoursNeeded}</Row>
          )}
          {client.startDatePreference && (
            <Row icon={CalendarDays} label="Start">{client.startDatePreference}</Row>
          )}
          {client.budgetRange && (
            <Row icon={Wallet} label="Budget">{client.budgetRange}</Row>
          )}
        </Section>
      )}

      {hasSource && (
        <Section title="Source">
          <Row icon={Megaphone} label="Referral">
            {[client.referralSource, client.referralDetail].filter(Boolean).join(' — ') || '—'}
          </Row>
        </Section>
      )}

      <button type="button" style={styles.editBtn} onClick={onEdit}>
        <Pencil size={13} strokeWidth={2} aria-hidden /> Edit details
      </button>
    </aside>
  );
}

function Section({ title, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ icon: Icon, label, children }) {
  return (
    <div style={styles.row}>
      {Icon && <Icon size={13} strokeWidth={2} aria-hidden style={styles.rowIcon} />}
      <div style={styles.rowBody}>
        <div style={styles.rowLabel}>{label}</div>
        <div style={styles.rowValue}>{children}</div>
      </div>
    </div>
  );
}

const styles = {
  rail: {
    position: 'sticky',
    top: 16,
    background: '#FFFFFF',
    borderRadius: 18,
    border: '1px solid rgba(0,0,0,0.05)',
    padding: '18px 18px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    fontFamily: 'inherit',
  },
  railHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  railTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#0F1724',
    fontFamily: "'Outfit', sans-serif",
    letterSpacing: -0.2,
  },
  dayCount: {
    fontSize: 11,
    fontWeight: 700,
    color: '#7A8BA0',
    background: '#F4F6FA',
    padding: '3px 8px',
    borderRadius: 6,
  },

  priorityBadge: {
    padding: '4px 10px',
    borderRadius: 6,
    fontWeight: 700,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    alignSelf: 'flex-start',
  },

  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingTop: 8,
    borderTop: '1px solid #F0F2F6',
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: '#7A8BA0',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowIcon: {
    color: '#7A8BA0',
    flexShrink: 0,
    marginTop: 3,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 1,
  },
  rowValue: {
    fontSize: 13,
    fontWeight: 500,
    color: '#1A1A1A',
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  link: {
    color: '#2E4E8D',
    textDecoration: 'none',
    fontWeight: 500,
  },

  editBtn: {
    marginTop: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    color: '#2E4E8D',
    background: '#EBF0FA',
    border: '1px solid #C7D2E2',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
};
