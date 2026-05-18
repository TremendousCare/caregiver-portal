import { useEffect, useRef, useState } from 'react';
import {
  Heart,
  MessageSquare,
  Phone,
  Mail,
  PhoneCall,
  MoreHorizontal,
  Archive,
  Undo2,
  Trash2,
} from 'lucide-react';
import { CLIENT_PHASES, CLIENT_PRIORITIES } from '../constants';
import { getClientPhase } from '../utils';
import { ClientPhaseIcon } from '../lib/clientPhaseIcon';
import layout from '../../../styles/layout.module.css';
import btn from '../../../styles/buttons.module.css';
import progress from '../../../styles/progress.module.css';
import { PhoneCallButton } from '../../voice/PhoneCallButton';
import { AvatarUpload } from '../../../shared/components/AvatarUpload';

// Header diet: quick-contact actions (Text / Call / Email / Log call)
// stay visible as compact icon+label buttons so a rep can act from the
// top of the page. Destructive / one-time actions (Archive, Restore,
// Delete) move behind a "More" overflow menu so they don't sit next to
// the avatar where a stray click is expensive.
export function ClientHeader({ client, onBack, onShowArchive, onUnarchive, onShowDelete, onAddNote, onUpdateClient }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);
  const priorityInfo = CLIENT_PRIORITIES.find((p) => p.id === client.priority);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className={layout.detailHeader}>
      <button className={btn.backBtn} onClick={onBack}>← Back</button>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <AvatarUpload
            entityType="clients"
            entityId={client.id}
            currentPath={client.avatarPath}
            firstName={client.firstName}
            lastName={client.lastName}
            size="lg"
            onChange={(newPath) => onUpdateClient?.(client.id, { avatarPath: newPath })}
          />
          <div>
            <h1 className={layout.detailName}>{client.firstName} {client.lastName}</h1>
            <div className={layout.detailMeta}>
              {client.phone && (
                <span>
                  {client.phone}
                  <PhoneCallButton phone={client.phone} compact />
                </span>
              )}
              {client.email && <span style={{ marginLeft: 16 }}>{client.email}</span>}
              {client.careRecipientName && (
                <span style={{ marginLeft: 16, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Heart size={13} strokeWidth={2} aria-hidden /> Care for: {client.careRecipientName}
                </span>
              )}
            </div>
            {(client.address || client.city) && (
              <div className={layout.detailMeta} style={{ marginTop: 2 }}>
                {[client.address, client.city, client.state, client.zip].filter(Boolean).join(', ')}
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <ClientPhaseIcon phaseId={phase} size={14} />
            {phaseInfo.label}
          </span>
        )}
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
        {client.archived && (
          <span style={{ padding: '6px 14px', borderRadius: 8, background: '#FEF2F0', color: '#DC3545', fontWeight: 600, fontSize: 13 }}>
            Archived
          </span>
        )}

        {client.phone && (
          <>
            <a
              href={`sms:${client.phone}`}
              className={btn.secondaryBtn}
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="Send a text"
            >
              <MessageSquare size={14} strokeWidth={2} aria-hidden /> Text
            </a>
            <a
              href={`tel:${client.phone}`}
              className={btn.secondaryBtn}
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="Call this client"
            >
              <Phone size={14} strokeWidth={2} aria-hidden /> Call
            </a>
          </>
        )}
        {client.email && (
          <a
            href={`mailto:${client.email}`}
            className={btn.secondaryBtn}
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Send an email"
          >
            <Mail size={14} strokeWidth={2} aria-hidden /> Email
          </a>
        )}
        <button
          className={btn.secondaryBtn}
          onClick={() => onAddNote(client.id, { text: '', type: 'call' })}
          title="Log a phone call"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <PhoneCall size={14} strokeWidth={2} aria-hidden /> Log call
        </button>

        {/* Overflow menu for destructive / less-frequent actions */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className={btn.secondaryBtn}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More actions"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 10px' }}
          >
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden />
          </button>
          {menuOpen && (
            <div style={overflowMenuStyle} role="menu">
              {!client.archived ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); onShowArchive(); }}
                  style={menuItemStyle}
                >
                  <Archive size={14} strokeWidth={2} aria-hidden /> Archive client
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); onUnarchive(client.id); }}
                  style={menuItemStyle}
                >
                  <Undo2 size={14} strokeWidth={2} aria-hidden /> Restore client
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onShowDelete(); }}
                style={{ ...menuItemStyle, color: '#B91C1C' }}
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden /> Delete permanently
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const overflowMenuStyle = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  minWidth: 200,
  background: '#FFFFFF',
  border: '1px solid #E2E8F0',
  borderRadius: 10,
  boxShadow: '0 10px 25px rgba(0,0,0,0.10)',
  padding: 6,
  zIndex: 20,
};

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  fontWeight: 500,
  color: '#1A1A1A',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
};
