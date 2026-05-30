// ─── PushReminderCard ───
// One-tap opt-in for shift reminders, shown on the caregiver home screen
// when push is supported + configured and the caregiver hasn't enabled it.
// Hidden entirely when unsupported, unconfigured, already subscribed, or
// permission was previously denied. lucide-react icons (no emoji).

import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import {
  pushSupported,
  pushConfigured,
  notificationPermission,
  getExistingSubscription,
  enablePush,
} from '../../../lib/push/pushClient';
import s from '../CaregiverPortal.module.css';

export function PushReminderCard({ caregiver }) {
  const [status, setStatus] = useState('checking'); // checking|hidden|available|enabling|subscribed|dismissed
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!pushSupported() || !pushConfigured() || notificationPermission() === 'denied') {
        if (active) setStatus('hidden');
        return;
      }
      try {
        const sub = await getExistingSubscription();
        if (active) setStatus(sub ? 'subscribed' : 'available');
      } catch {
        if (active) setStatus('available');
      }
    })();
    return () => { active = false; };
  }, []);

  const onEnable = async () => {
    setError(null);
    setStatus('enabling');
    try {
      await enablePush(caregiver?.id);
      setStatus('subscribed');
    } catch (err) {
      setError(err?.message || 'Could not enable notifications.');
      setStatus('available');
    }
  };

  if (['checking', 'hidden', 'subscribed', 'dismissed'].includes(status)) return null;

  return (
    <div className={s.reminderCard} role="region" aria-label="Shift reminders">
      <BellRing className={s.reminderIcon} size={22} aria-hidden="true" />
      <div className={s.reminderBody}>
        <div className={s.reminderTitle}>Turn on shift reminders</div>
        <div className={s.muted}>
          Get a notification before each shift so you never miss one.
        </div>
        {error && <div className={s.error}>{error}</div>}
        <div className={s.reminderActions}>
          <button
            type="button"
            className={s.pwaToastBtn}
            onClick={onEnable}
            disabled={status === 'enabling'}
          >
            {status === 'enabling' ? 'Enabling…' : 'Turn on reminders'}
          </button>
          <button
            type="button"
            className={s.pwaToastDismiss}
            onClick={() => setStatus('dismissed')}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
