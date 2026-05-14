// ─────────────────────────────────────────────────────────────────
// ToolsFAB — single bottom-right launcher for workspace tools.
//
// One circular FAB with a "tools" (grid) icon. Click to fan out into
// labeled child buttons for each tool (AI assistant, RC phone).
// Selecting a child opens that tool's panel and collapses the fan.
//
// Design rationale (vs. multiple bottom-right FABs):
//   - One bubble at rest, instead of two competing for the corner.
//   - Extensible — adding a third tool later is just one entry in
//     the children array.
//   - Material Design "speed dial" pattern; familiar from many
//     enterprise apps (Slack, Notion, Linear).
//
// Tradeoff: opening AI chat is now 2 clicks instead of 1. The
// IncomingCallToast still pops independently of this launcher, so
// inbound call handling is unaffected.
//
// State: owned here. Passes `open` + `onClose` down into AIChatbot
// and RingCentralEmbeddable, both of which support controlled mode.
// Click-outside / Escape close the fan menu (not the tool panel
// itself, which closes via its own × button).
// ─────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid, X, Phone, Sparkles } from 'lucide-react';
import { AIChatbot } from './AIChatbot';
import { RingCentralEmbeddable } from '../../features/voice/RingCentralEmbeddable';
import { useVoice } from '../context/VoiceContext';
import s from './ToolsFAB.module.css';

const TOOLS = [
  { key: 'ai', label: 'AI Assistant', Icon: Sparkles, tone: 'ai' },
  { key: 'rc', label: 'RingCentral', Icon: Phone, tone: 'rc' },
];

export function ToolsFAB({ caregiverId = null, currentUser }) {
  const [openTool, setOpenTool] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef(null);
  const { dialerOpenRequest } = useVoice();

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleSelectTool = useCallback((key) => {
    setOpenTool((prev) => (prev === key ? null : key));
    setMenuOpen(false);
  }, []);

  const handleCloseTool = useCallback(() => setOpenTool(null), []);

  // Surface the RC dialer panel whenever VoiceContext signals a
  // request (the IncomingCallToast bumps the counter after a
  // successful Answer postMessage). Counter > 0 means at least one
  // request has fired; we open RC and close the fan menu.
  useEffect(() => {
    if (dialerOpenRequest > 0) {
      setOpenTool('rc');
      setMenuOpen(false);
    }
  }, [dialerOpenRequest]);

  // Close the fan-out on Escape or click outside the launcher area.
  // We do NOT close the tool panel itself this way — those have their
  // own close buttons, and an Escape mid-call would be infuriating.
  useEffect(() => {
    if (!menuOpen) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') closeMenu();
    }
    function onPointer(e) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target)) closeMenu();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [menuOpen, closeMenu]);

  return (
    <>
      <AIChatbot
        caregiverId={caregiverId}
        currentUser={currentUser}
        open={openTool === 'ai'}
        onClose={handleCloseTool}
      />
      <RingCentralEmbeddable
        open={openTool === 'rc'}
        onClose={handleCloseTool}
      />

      <div className={s.container} ref={containerRef}>
        {menuOpen && (
          <ul className={s.menu} role="menu" aria-label="Open a tool">
            {TOOLS.map(({ key, label, Icon, tone }, index) => (
              <li
                key={key}
                role="none"
                className={s.menuItem}
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <span className={s.menuLabel}>{label}</span>
                <button
                  type="button"
                  role="menuitem"
                  className={`${s.child} ${s[`child_${tone}`]}`}
                  onClick={() => handleSelectTool(key)}
                  aria-label={`Open ${label}`}
                  aria-pressed={openTool === key}
                >
                  <Icon size={20} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className={`${s.fab} ${menuOpen ? s.fabOpen : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? 'Close tools' : 'Open tools'}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          {menuOpen ? <X size={24} /> : <LayoutGrid size={22} />}
        </button>
      </div>
    </>
  );
}
