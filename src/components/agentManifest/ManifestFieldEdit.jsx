// Phase 0.5 PR B — per-field manifest edit modal.
//
// Locked §9 D9: in-page accordion for the read view + per-field
// modals for the actual editing. This component is the modal.
//
// Field types handled:
//   - 'text'         — name (single-line input)
//   - 'textarea'     — system_prompt (multi-line)
//   - 'number'       — max_iterations (with min/max guards)
//   - 'multiselect'  — tool_allowlist (checkbox grid against the
//                     hard-coded per-agent universe — locked D1)
//   - 'json'         — autonomy_profile, context_recipe,
//                     outcome_definition (textarea + parse)
//
// Validation runs on change; the Save button stays disabled until the
// validator returns ok=true. Warnings (e.g. unknown model per D2) are
// shown but don't block save.

import { useEffect, useMemo, useState } from 'react';
import {
  validateName,
  validateSystemPrompt,
  validateMaxIterations,
  validateModel,
  validateToolAllowlist,
  validateAutonomyProfile,
  validateJsonObject,
  parseJsonText,
} from './validators';

export function ManifestFieldEdit({
  field,
  label,
  initialValue,
  fieldType,           // 'text' | 'textarea' | 'number' | 'multiselect' | 'json'
  knownTools,          // for 'multiselect' only
  onSave,              // (newValue) => void
  onClose,
}) {
  const [value, setValue] = useState(() => initialValue);
  const [jsonText, setJsonText] = useState(() =>
    fieldType === 'json' ? JSON.stringify(initialValue ?? {}, null, 2) : ''
  );

  const validation = useMemo(() => {
    switch (fieldType) {
      case 'text':
        return field === 'name' ? validateName(value) : validateModel(value);
      case 'textarea':
        return validateSystemPrompt(value);
      case 'number':
        return validateMaxIterations(value);
      case 'multiselect':
        return validateToolAllowlist(value, knownTools || []);
      case 'json': {
        const parsed = parseJsonText(jsonText);
        if (!parsed.ok) return parsed;
        if (field === 'autonomy_profile') return validateAutonomyProfile(parsed.value);
        return validateJsonObject(parsed.value, label);
      }
      default:
        return { ok: false, error: `Unknown field type: ${fieldType}` };
    }
  }, [fieldType, field, value, jsonText, knownTools, label]);

  // ESC closes; Cmd/Ctrl+Enter saves. Standard modal expectations.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (validation.ok) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  function handleSave() {
    if (!validation.ok) return;
    let outValue = value;
    if (fieldType === 'json') {
      const parsed = parseJsonText(jsonText);
      if (!parsed.ok) return; // shouldn't happen; validation already ok
      outValue = parsed.value;
    }
    onSave(outValue);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17, 24, 39, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${label}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF',
          borderRadius: 8,
          padding: 24,
          width: 'min(720px, 92vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#111827' }}>
            Edit {label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 22,
              cursor: 'pointer',
              color: '#6B7280',
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Editor surface — branches by type */}
        <div style={{ marginBottom: 12 }}>
          {fieldType === 'text' && (
            <input
              type="text"
              value={value ?? ''}
              onChange={(e) => setValue(e.target.value)}
              style={inputStyle}
              autoFocus
            />
          )}
          {fieldType === 'textarea' && (
            <textarea
              value={value ?? ''}
              onChange={(e) => setValue(e.target.value)}
              rows={16}
              style={{ ...inputStyle, fontFamily: monoFont, resize: 'vertical' }}
              autoFocus
            />
          )}
          {fieldType === 'number' && (
            <input
              type="number"
              value={value ?? ''}
              onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
              min={1}
              max={50}
              style={{ ...inputStyle, width: 120 }}
              autoFocus
            />
          )}
          {fieldType === 'multiselect' && (
            <ToolMultiSelect
              value={value || []}
              knownTools={knownTools || []}
              onChange={setValue}
            />
          )}
          {fieldType === 'json' && (
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={16}
              style={{ ...inputStyle, fontFamily: monoFont, resize: 'vertical' }}
              autoFocus
              spellCheck={false}
            />
          )}
        </div>

        {/* Validation feedback */}
        {!validation.ok && (
          <div style={{ color: '#B42318', fontSize: 13, marginBottom: 12 }}>
            {validation.error}
          </div>
        )}
        {validation.ok && validation.warning && (
          <div style={{ color: '#92400E', fontSize: 13, marginBottom: 12 }}>
            ⚠ {validation.warning}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!validation.ok}
            onClick={handleSave}
            style={{
              ...btnPrimary,
              opacity: validation.ok ? 1 : 0.5,
              cursor: validation.ok ? 'pointer' : 'not-allowed',
            }}
            title="⌘/Ctrl + Enter"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolMultiSelect({ value, knownTools, onChange }) {
  const set = new Set(value);
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: '#6B7280',
          marginBottom: 8,
        }}
      >
        {value.length} of {knownTools.length} tools selected
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 6,
          maxHeight: 320,
          overflow: 'auto',
          border: '1px solid #E5E7EB',
          borderRadius: 6,
          padding: 12,
        }}
      >
        {knownTools.map(tool => {
          const checked = set.has(tool);
          return (
            <label
              key={tool}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontFamily: monoFont,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...value, tool]);
                  } else {
                    onChange(value.filter(t => t !== tool));
                  }
                }}
              />
              {tool}
            </label>
          );
        })}
      </div>
    </div>
  );
}

const monoFont = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid #D1D5DB',
  borderRadius: 6,
  fontSize: 13,
  background: '#FFFFFF',
  color: '#111827',
  boxSizing: 'border-box',
};

const btnPrimary = {
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid #4338CA',
  background: '#4F46E5',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 500,
};

const btnSecondary = {
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid #D1D5DB',
  background: '#FFFFFF',
  color: '#374151',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
