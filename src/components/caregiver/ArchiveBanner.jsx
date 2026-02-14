import { PHASES } from '../../lib/constants';
import { ARCHIVE_REASONS } from './constants';
import cg from './caregiver.module.css';

export function ArchiveBanner({ caregiver }) {
  if (!caregiver.archived) return null;

  return (
    <div className={cg.archiveBanner}>
      <div className={cg.archiveBannerHeader}>
        <span className={cg.archiveBannerIcon}>📦</span>
        <strong className={cg.archiveBannerTitle}>Archived Caregiver</strong>
      </div>
      <div className={cg.archiveBannerDetails}>
        <div><span className={cg.archiveBannerLabel}>Reason:</span> {ARCHIVE_REASONS.find((r) => r.value === caregiver.archiveReason)?.label || caregiver.archiveReason || '—'}</div>
        {caregiver.archiveDetail && <div><span className={cg.archiveBannerLabel}>Detail:</span> {caregiver.archiveDetail}</div>}
        <div><span className={cg.archiveBannerLabel}>Phase at archive:</span> {PHASES.find((p) => p.id === caregiver.archivePhase)?.label || caregiver.archivePhase || '—'}</div>
        {caregiver.archivedAt && (
          <div>
            <span className={cg.archiveBannerLabel}>Archived:</span>{' '}
            {new Date(caregiver.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {caregiver.archivedBy ? ` by ${caregiver.archivedBy}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
