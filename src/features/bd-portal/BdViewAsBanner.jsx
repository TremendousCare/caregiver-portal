import { Eye, X } from 'lucide-react';
import { useBdViewAs } from './context/BdViewAsContext';
import { repDisplayName } from './lib/bdViewAs';
import s from './BdPortal.module.css';

// Persistent banner shown while an owner is mirroring another rep's
// portal. Makes the audit view impossible to mistake for the owner's own
// instance and gives a one-tap exit. Renders nothing when not viewing-as,
// so it's safe to mount unconditionally at the top of BDApp.
export function BdViewAsBanner() {
  const { isViewingAs, effectiveRep, clearViewAs } = useBdViewAs();

  if (!isViewingAs) return null;

  const name = repDisplayName(effectiveRep);

  return (
    <div className={s.viewAsBanner} role="status">
      <span className={s.viewAsBannerIcon} aria-hidden>
        <Eye size={18} strokeWidth={2} />
      </span>
      <div className={s.viewAsBannerBody}>
        <div className={s.viewAsBannerTitle}>Viewing as {name}</div>
        <div className={s.viewAsBannerSub}>Read-only audit view — changes are disabled</div>
      </div>
      <button
        type="button"
        className={s.viewAsExitBtn}
        onClick={clearViewAs}
      >
        <X size={14} strokeWidth={2} aria-hidden /> Exit
      </button>
    </div>
  );
}
