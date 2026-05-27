// Snooze popover — replaces the "Snooze 1 day" / "Snooze 1d" buttons
// in TasksDashboard and UpcomingFollowUpsPanel with a 5-option menu:
//
//   • 1 hour
//   • Tonight 6pm  (rolls to tomorrow 9am if already past 6pm)
//   • Tomorrow 9am
//   • Next Monday 9am
//   • Custom — datetime-local input + Apply
//
// Owns its own open/close state; consumers just render <SnoozePopover
// onSnooze={(date) => snooze(task.id, date)} />.

import { useEffect, useRef, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { SNOOZE_PRESETS } from '../../lib/snoozePresets';

export function SnoozePopover({ onSnooze, label = 'Snooze' }) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const containerRef = useRef(null);

  // Click outside to close — pointerdown is fired before focus changes
  // so we don't fight the popover's own clicks.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  const handlePreset = (compute) => {
    const date = compute(new Date());
    onSnooze(date);
    setOpen(false);
  };

  const handleCustomApply = () => {
    if (!customValue) return;
    const date = new Date(customValue);
    if (Number.isNaN(date.getTime())) return;
    if (date.getTime() <= Date.now()) return; // ignore past times
    onSnooze(date);
    setOpen(false);
    setCustomValue('');
  };

  return (
    <span ref={containerRef} style={containerStyle}>
      <button
        type="button"
        style={triggerStyle}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Clock size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        {label}
        <ChevronDown size={12} style={{ marginLeft: 4, verticalAlign: 'text-bottom' }} />
      </button>

      {open && (
        <div role="menu" style={menuStyle}>
          {SNOOZE_PRESETS.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              type="button"
              style={itemStyle}
              onClick={() => handlePreset(p.compute)}
            >
              {p.label}
            </button>
          ))}
          <div style={dividerStyle} />
          <div style={customRowStyle}>
            <input
              type="datetime-local"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              style={customInputStyle}
              aria-label="Custom snooze date and time"
            />
            <button
              type="button"
              onClick={handleCustomApply}
              style={customApplyStyle}
              disabled={!customValue}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Inline styles ──────────────────────────────────────────

const containerStyle = { position: 'relative', display: 'inline-block' };

const triggerStyle = {
  display: 'inline-flex', alignItems: 'center',
  padding: '6px 12px',
  background: '#fff',
  border: '1px solid #E0E4EA', borderRadius: 6,
  color: 'var(--tc-text-secondary)',
  fontSize: 13, cursor: 'pointer',
};

const menuStyle = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
  minWidth: 220,
  background: '#fff',
  border: '1px solid #E0E4EA', borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,16,40,0.12)',
  padding: 4,
  zIndex: 50,
};

const itemStyle = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '8px 12px',
  background: '#fff', border: 'none',
  fontSize: 13, color: 'var(--tc-navy)',
  cursor: 'pointer', borderRadius: 4,
};

const dividerStyle = {
  borderTop: '1px solid #EDF0F4',
  margin: '4px 0',
};

const customRowStyle = {
  display: 'flex', gap: 6, padding: '4px 8px 6px',
  alignItems: 'center',
};

const customInputStyle = {
  flex: 1, minWidth: 0,
  padding: '4px 8px',
  border: '1px solid #E0E4EA', borderRadius: 4,
  fontSize: 12,
};

const customApplyStyle = {
  padding: '4px 10px',
  border: 'none', borderRadius: 4,
  background: 'var(--tc-navy)', color: '#fff',
  fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
};
