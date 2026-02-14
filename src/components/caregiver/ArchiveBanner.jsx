import { PHASES } from '../../lib/constants';
import { ARCHIVE_REASONS } from './constants';

export function ArchiveBanner({ caregiver }) {
  if (!caregiver.archived) return null;

  return (
    <div style={{ background: '#FEF2F0', border: '1px solid #FECACA', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>📦</span>
        <strong style={{ color: '#DC3545', fontFamily: "'Outfit', sans-serif" }}>Archived Caregiver</strong>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, color: '#556270' }}>
        <div><span style={{ fontWeight: 600 }}>Reason:</span> {ARCHIVE_REASONS.find((r) => r.value === caregiver.archiveReason)?.label || caregiver.archiveReason || '—'}</div>
        {caregiver.archiveDetail && <div><span style={{ fontWeight: 600 }}>Detail:</span> {caregiver.archiveDetail}</div>}
        <div><span style={{ fontWeight: 600 }}>Phase at archive:</span> {PHASES.find((p) => p.id === caregiver.archivePhase)?.label || caregiver.archivePhase || '—'}</div>
        {caregiver.archivedAt && (
          <div>
            <span style={{ fontWeight: 600 }}>Archived:</span>{' '}
            {new Date(caregiver.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {caregiver.archivedBy ? ` by ${caregiver.archivedBy}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
