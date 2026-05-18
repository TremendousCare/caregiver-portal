import { Clock } from 'lucide-react';
import { CLIENT_PHASES } from '../constants';
import { getClientOverdueStatus } from '../utils';

// Full-width red banner that surfaces at the top of the client profile
// when the client has been sitting in their current phase past the SLA
// window. Replaces the small "ACTION NEEDED" chip that used to sit
// inside the Next Steps card — at the top of the page it's harder to
// miss when the rep is scanning a stack of clients.

function formatOverdueDuration(ms) {
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return 'just now';
}

const PHASE_ACTION_HINT = {
  new_lead: 'Call now — every minute past the first hour cuts conversion.',
  initial_contact: 'Get the decision-maker on the phone and book the consultation.',
  consultation: 'Finish the consultation and book the in-home visit.',
  assessment: 'Complete the home visit and send a proposal.',
  consult: 'Finish the consultation and book the in-home visit.',
  proposal: 'Follow up on the proposal — momentum is fading.',
};

export function ClientOverdueBanner({ client }) {
  if (client?.archived) return null;
  const status = getClientOverdueStatus(client);
  if (!status) return null;

  const phaseInfo = CLIENT_PHASES.find((p) => p.id === status.phase);
  const phaseLabel = phaseInfo?.label || status.phase;
  const overdueText = formatOverdueDuration(status.overdueMs);
  const hint = PHASE_ACTION_HINT[status.phase] || 'Follow up to keep this client moving.';

  return (
    <div style={styles.banner} role="alert">
      <div style={styles.icon} aria-hidden="true">
        <Clock size={24} strokeWidth={2} />
      </div>
      <div style={styles.content}>
        <div style={styles.title}>
          {phaseLabel} is {overdueText} overdue
        </div>
        <div style={styles.hint}>{hint}</div>
      </div>
    </div>
  );
}

const styles = {
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '14px 20px',
    background: 'linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 100%)',
    border: '1px solid #FECACA',
    borderLeft: '4px solid #DC2626',
    borderRadius: 12,
    marginBottom: 16,
    boxShadow: '0 2px 8px rgba(220,38,38,0.08)',
  },
  icon: {
    fontSize: 24,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#991B1B',
    lineHeight: 1.3,
    marginBottom: 2,
    fontFamily: "'Outfit', sans-serif",
  },
  hint: {
    fontSize: 13,
    color: '#DC2626',
    fontWeight: 500,
    lineHeight: 1.45,
  },
};
