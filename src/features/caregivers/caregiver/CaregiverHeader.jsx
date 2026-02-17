import layout from '../../../styles/layout.module.css';
import btn from '../../../styles/buttons.module.css';
import progress from '../../../styles/progress.module.css';

export function CaregiverHeader({ caregiver, greenLight, onBack, onToggleGreenLight, onShowArchive, onUnarchive, onShowDelete }) {
  return (
    <div className={layout.detailHeader}>
      <button className={btn.backBtn} onClick={onBack}>← Back</button>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div className={layout.detailAvatar}>{caregiver.firstName?.[0]}{caregiver.lastName?.[0]}</div>
          <div>
            <h1 className={layout.detailName}>{caregiver.firstName} {caregiver.lastName}</h1>
            <div className={layout.detailMeta}>
              {caregiver.phone && <span>📞 {caregiver.phone}</span>}
              {caregiver.email && <span style={{ marginLeft: 16 }}>✉️ {caregiver.email}</span>}
              {caregiver.perId && <span style={{ marginLeft: 16 }}>🆔 PER {caregiver.perId}</span>}
            </div>
            {(caregiver.address || caregiver.city) && (
              <div className={layout.detailMeta} style={{ marginTop: 2 }}>
                📍 {[caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ')}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {greenLight && <span className={progress.greenLightBadgeLg}>🟢 Green Light</span>}
        {caregiver.archived && <span style={{ padding: '6px 14px', borderRadius: 8, background: '#FEF2F0', color: '#DC3545', fontWeight: 600, fontSize: 13 }}>Archived</span>}
        <button className={btn.greenLightBtn} onClick={onToggleGreenLight}>🛡️ Green Light Check</button>
        {!caregiver.archived ? (
          <button className={btn.dangerBtn} onClick={onShowArchive}>📦 Archive</button>
        ) : (
          <button className={btn.primaryBtn} onClick={() => onUnarchive(caregiver.id)}>↩️ Restore</button>
        )}
        <button className={btn.dangerBtn} style={{ background: '#7F1D1D', color: '#fff' }} onClick={onShowDelete}>🗑️ Delete</button>
      </div>
    </div>
  );
}
