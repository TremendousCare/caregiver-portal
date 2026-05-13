import { useEffect, useState } from 'react';
import { getCurrentPosition } from './useBdLogActivity';
import { findNearestAccount } from '../lib/bdQueries';

// Asks the browser for the rep's current position once, then surfaces
// the nearest account within `radiusMeters` (default 200m). Result is
// `{ status, position, nearest }`:
//   - status: 'idle' | 'locating' | 'ready' | 'unavailable'
//   - position: { lat, lng } | null
//   - nearest: { account, distance_meters } | null
//
// Pure no-op when geolocation is denied or no account in the list has
// a precise coordinate. Never blocks rendering — the Today screen
// continues to show the briefing and counters whether this resolves
// or not.
export function useBdNearbyAccount(accounts, { radiusMeters = 200, enabled = true } = {}) {
  const [status, setStatus]     = useState('idle');
  const [position, setPosition] = useState(null);
  const [nearest, setNearest]   = useState(null);

  useEffect(() => {
    if (!enabled) return;
    if (!Array.isArray(accounts) || accounts.length === 0) return;
    let cancelled = false;
    setStatus('locating');
    getCurrentPosition().then((pos) => {
      if (cancelled) return;
      if (!pos) {
        setStatus('unavailable');
        return;
      }
      setPosition(pos);
      setNearest(findNearestAccount(accounts, pos, { radiusMeters }));
      setStatus('ready');
    });
    return () => { cancelled = true; };
    // We intentionally only re-run when the account count changes.
    // Re-running on every array identity change would re-prompt for
    // location whenever React re-renders the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts?.length, enabled, radiusMeters]);

  return { status, position, nearest };
}
