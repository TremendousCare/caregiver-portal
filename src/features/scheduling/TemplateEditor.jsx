import { useEffect, useMemo, useRef, useState } from 'react';
import s from './TemplateEditor.module.css';

// ═══════════════════════════════════════════════════════════════
// TemplateEditor — Phase 5c
//
// Reusable editable SMS template box with:
//   - Editable textarea
//   - "Insert placeholder ▾" dropdown for merge fields
//   - Live preview rendered with sample merge field values
//   - Optional "Save as new default" checkbox
//   - Character counter with warn/over thresholds
//
// Used by both BroadcastModal and ConfirmAssignDialog. The caller
// owns the template string and onChange; this component is
// controlled, no hidden state for the template text.
// ═══════════════════════════════════════════════════════════════

const CHAR_WARN_THRESHOLD = 160;
const CHAR_HARD_LIMIT = 1600;

/**
 * Standard list of placeholder metadata shared across the scheduling
 * template editors. Each entry has:
 *   - key:   the merge field name (without curly braces)
 *   - label: plain-English display name for the dropdown
 */
export const SCHEDULING_PLACEHOLDERS = [
  { key: 'firstName', label: "Caregiver's first name" },
  { key: 'lastName', label: "Caregiver's last name" },
  { key: 'clientName', label: "Client's name" },
  { key: 'careRecipient', label: "Care recipient's name" },
  { key: 'dayOfWeek', label: 'Day of week (Mon)' },
  { key: 'dateLabel', label: 'Short date (May 4)' },
  { key: 'startTime', label: 'Start time (8:00a)' },
  { key: 'endTime', label: 'End time (12:00p)' },
  { key: 'timeRange', label: 'Time range (8:00a-12:00p)' },
  { key: 'duration', label: 'Duration (4h / 30m)' },
  { key: 'location', label: 'Shift location / address' },
  { key: 'replyInstruction', label: 'Reply instruction (broadcast only)' },
];

export function TemplateEditor({
  value,
  onChange,
  previewText,
  previewLabel,
  placeholders = SCHEDULING_PLACEHOLDERS,
  saveAsDefault = false,
  onToggleSaveAsDefault,
  showSaveAsDefault = true,
  rows = 3,
  label = 'Message',
  disabled = false,
}) {
  const textareaRef = useRef(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close the dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return undefined;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Insert a `{{placeholder}}` token at the current cursor position
  // in the textarea. If the textarea isn't focused (e.g. user opened
  // the dropdown without clicking in the text first), we append at
  // the end instead of the start — appending is almost always what
  // the user actually wants.
  const insertPlaceholder = (key) => {
    const token = `{{${key}}}`;
    const el = textareaRef.current;
    if (!el) {
      onChange(`${value || ''}${token}`);
      setDropdownOpen(false);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const before = value.substring(0, start);
    const after = value.substring(end);
    const next = `${before}${token}${after}`;
    onChange(next);
    // Move caret after the inserted token on the next tick
    requestAnimationFrame(() => {
      el.focus();
      const caretPos = start + token.length;
      el.setSelectionRange(caretPos, caretPos);
    });
    setDropdownOpen(false);
  };

  const charCount = (value || '').length;
  const overSoftLimit = charCount > CHAR_WARN_THRESHOLD;
  const overHardLimit = charCount > CHAR_HARD_LIMIT;

  return (
    <div className={s.editor}>
      <div className={s.editorHeader}>
        <span className={s.label}>{label}</span>
        <div className={s.headerRight}>
          <div className={s.dropdownWrap} ref={dropdownRef}>
            <button
              type="button"
              className={s.placeholderBtn}
              onClick={() => setDropdownOpen((v) => !v)}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={dropdownOpen}
            >
              Insert placeholder ▾
            </button>
            {dropdownOpen && (
              <div className={s.dropdownMenu} role="menu">
                {placeholders.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={s.dropdownItem}
                    onClick={() => insertPlaceholder(p.key)}
                    role="menuitem"
                  >
                    <span className={s.dropdownItemLabel}>{p.label}</span>
                    <span className={s.dropdownItemKey}>{`{{${p.key}}}`}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={s.charCount}>
            <span className={overHardLimit ? s.charOver : overSoftLimit ? s.charWarn : ''}>
              {charCount}
            </span>{' '}
            chars
          </div>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        className={s.textarea}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        placeholder="Message template — click &ldquo;Insert placeholder&rdquo; for merge fields"
      />

      {previewText && (
        <div className={s.preview}>
          <div className={s.previewLabel}>{previewLabel || 'Preview'}</div>
          <div className={s.previewText}>{previewText}</div>
        </div>
      )}

      {showSaveAsDefault && (
        <label className={s.saveAsDefaultRow}>
          <input
            type="checkbox"
            checked={!!saveAsDefault}
            onChange={(e) => onToggleSaveAsDefault?.(e.target.checked)}
            disabled={disabled}
          />
          <span>Save this message as the new default template</span>
        </label>
      )}
    </div>
  );
}
