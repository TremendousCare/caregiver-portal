import { CLIENT_PHASES, CLIENT_PRIORITIES } from '../constants';
import { getClientPhase } from '../utils';
import layout from '../../../styles/layout.module.css';
import btn from '../../../styles/buttons.module.css';
import progress from '../../../styles/progress.module.css';

export function ClientHeader({ client, onBack, onShowArchive, onUnarchive, onShowDelete, onAddNote }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);

  return (
    <div className={layout.detailHeader}>
      <button className={btn.backBtn} onClick={onBack}>← Back</button>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div className={layout.detailAvatar}>{client.firstName?.[0]}{client.lastName?.[0]}</div>
          <div>
            <h1 className={layout.detailName}>{client.firstName} {client.lastName}</h1>
            <div className={layout.detailMeta}>
              {client.phone && <span>📞 {client.phone}</span>}
              {client.email && <span style={{ marginLeft: 16 }}>✉️ {client.email}</span>}
              {client.careRecipientName && <span style={{ marginLeft: 16 }}>👤 Care for: {client.careRecipientName}</span>}
            </div>
            {(client.address || client.city) && (
              <div className={layout.detailMeta} style={{ marginTop: 2 }}>
                📍 {[client.address, client.city, client.state, client.zip].filter(Boolean).join(', ')}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {/* Phase badge */}
        {phaseInfo && (
          <span
            className={progress.phaseBadge}
            style={{
              background: `${phaseInfo.color}18`,
              color: phaseInfo.color,
              border: `1px solid ${phaseInfo.color}30`,
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {phaseInfo.icon} {phaseInfo.label}
          </span>
        )}
        {/* Priority badge */}
        {priorityInfo && priorityInfo.id !== 'normal' && (
          <span
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: `${priorityInfo.color}18`,
              color: priorityInfo.color,
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {priorityInfo.label}
          </span>
        )}
        {/* Archived badge */}
        {client.archived && (
          <span style={{ padding: '6px 14px', borderRadius: 8, background: '#FEF2F0', color: '#DC3545', fontWeight: 600, fontSize: 13 }}>
            Archived
          </span>
        )}
        {/* Quick action buttons */}
        {client.phone && (
          <>
            <a
              href={`sms:${client.phone}`}
              className={btn.secondaryBtn}
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              💬 Text
            </a>
            <a
              href={`tel:${client.phone}`}
              className={btn.secondaryBtn}
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              📞 Call
            </a>
          </>
        )}
        {client.email && (
          <a
            href={`mailto:${client.email}`}
            className={btn.secondaryBtn}
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            ✉️ Email
          </a>
        )}
        <button
          className={btn.secondaryBtn}
          onClick={() => onAddNote(client.id, { text: '', type: 'call' })}
          title="Log a phone call"
        >
          📋 Log Call
        </button>
        {!client.archived ? (
          <button className={btn.dangerBtn} onClick={onShowArchive}>📦 Archive</button>
        ) : (
          <button className={btn.primaryBtn} onClick={() => onUnarchive(client.id)}>↩️ Restore</button>
        )}
        <button className={btn.dangerBtn} style={{ background: '#7F1D1D', color: '#fff' }} onClick={onShowDelete}>🗑️ Delete</button>
      </div>
    </div>
  );
}
