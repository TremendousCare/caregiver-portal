import { useEffect, useRef, useState } from 'react';
import { FIELD_TYPES } from './sections';
import { moveRowDown, moveRowUp } from './listHelpers';
import { searchCommonMedications } from './commonMedications';
import { searchCommonAllergens } from './commonAllergens';
import forms from '../../styles/forms.module.css';
import s from './FieldRenderer.module.css';

// Dispatch table from field.suggestionsKey → search function.
// Keep this small — adding a key here makes that suggestion source
// available to any AUTOCOMPLETE field across the app.
const SUGGESTION_SOURCES = {
  commonMedications: searchCommonMedications,
  commonAllergens: searchCommonAllergens,
};

// ═══════════════════════════════════════════════════════════════
// FieldRenderer
//
// Dispatches on field.type → the appropriate form control. Every
// control follows the same contract:
//
//   (field, value, onChange, disabled?, siblingValues?) → JSX
//
// `onChange` is called with the new value. Debouncing / autosave is
// the caller's responsibility (the SectionEditor wraps onChange in
// useAutosave so we don't re-implement it here).
//
// Conditional fields: `field.conditional` shape is one of
//   { field: siblingId, in: [values] }
//   { field: siblingId, equals: value }
//   { field: siblingId, notEquals: value }
// If the condition isn't met, the field is hidden entirely.
// ═══════════════════════════════════════════════════════════════

export function FieldRenderer({ field, value, onChange, disabled, siblingValues }) {
  if (!shouldRender(field, siblingValues)) return null;

  const common = { field, value, onChange, disabled };

  switch (field.type) {
    case FIELD_TYPES.TEXT:        return <Field {...common}><TextControl {...common} /></Field>;
    case FIELD_TYPES.TEXTAREA:    return <Field {...common}><TextareaControl {...common} /></Field>;
    case FIELD_TYPES.DATE:        return <Field {...common}><DateControl {...common} /></Field>;
    case FIELD_TYPES.NUMBER:      return <Field {...common}><NumberControl {...common} /></Field>;
    case FIELD_TYPES.SELECT:      return <Field {...common}><SelectControl {...common} /></Field>;
    case FIELD_TYPES.MULTISELECT: return <Field {...common}><MultiselectControl {...common} /></Field>;
    case FIELD_TYPES.BOOLEAN:     return <Field {...common}><BooleanControl {...common} /></Field>;
    case FIELD_TYPES.YESNO:       return <Field {...common}><YesNoControl {...common} /></Field>;
    case FIELD_TYPES.YN:          return <Field {...common}><YNControl {...common} /></Field>;
    case FIELD_TYPES.PHONE:       return <Field {...common}><PhoneControl {...common} /></Field>;
    case FIELD_TYPES.EMAIL:       return <Field {...common}><EmailControl {...common} /></Field>;
    case FIELD_TYPES.LIST:        return <Field {...common}><ListControl {...common} /></Field>;
    case FIELD_TYPES.PRN:         return <Field {...common}><PRNControl {...common} /></Field>;
    case FIELD_TYPES.LEVEL_PICK:  return <Field {...common}><LevelPickControl {...common} /></Field>;
    case FIELD_TYPES.AUTOCOMPLETE: return <Field {...common}><AutocompleteControl {...common} /></Field>;
    default:                      return <Field {...common}><UnknownControl {...common} /></Field>;
  }
}


// ─── Conditional visibility ────────────────────────────────────

export function shouldRender(field, siblingValues) {
  if (!field?.conditional) return true;
  const sibs = siblingValues || {};
  const { field: sib, in: inValues, equals, notEquals } = field.conditional;
  const siblingValue = sibs[sib];

  if (Array.isArray(inValues)) {
    if (siblingValue == null) return false;
    return inValues.includes(siblingValue);
  }
  if (equals !== undefined) {
    // Empty string doesn't count as "has a date" for the notEquals/''
    // idiom used in healthProfile — treat '' as null for conditionals.
    const effective = siblingValue === '' ? null : siblingValue;
    return effective === equals;
  }
  if (notEquals !== undefined) {
    // Treat undefined / null / '' as equivalent "empty" for the
    // common `notEquals: ''` idiom ("show only if a value exists").
    const normalize = (v) => (v === '' || v == null ? null : v);
    return normalize(siblingValue) !== normalize(notEquals);
  }
  return true;
}


// ─── Shared Field wrapper (label + hint + CMS-485 badge) ───────

function Field({ field, children }) {
  return (
    <div className={s.field}>
      <label className={forms.fieldLabel}>
        {field.label}
        {field.required && <span className={s.requiredMark} title="Required">*</span>}
        {field.cms485 && <span className={s.cms485Badge} title="CMS-485 required field">485</span>}
      </label>
      {children}
      {field.help && <div className={s.helpText}>{field.help}</div>}
    </div>
  );
}


// ─── Controls ──────────────────────────────────────────────────

function TextControl({ field, value, onChange, disabled }) {
  return (
    <input
      type="text"
      className={forms.fieldInput}
      value={value ?? ''}
      placeholder={field.placeholder || ''}
      disabled={disabled}
      readOnly={field.readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextareaControl({ field, value, onChange, disabled }) {
  const rows = field.multiline ? 4 : 2;
  return (
    <textarea
      className={forms.fieldInput}
      rows={rows}
      value={value ?? ''}
      placeholder={field.placeholder || ''}
      disabled={disabled}
      readOnly={field.readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function DateControl({ field, value, onChange, disabled }) {
  return (
    <input
      type="date"
      className={forms.fieldInput}
      value={value ?? ''}
      disabled={disabled}
      readOnly={field.readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumberControl({ field, value, onChange, disabled }) {
  return (
    <input
      type="number"
      className={forms.fieldInput}
      value={value ?? ''}
      placeholder={field.placeholder || ''}
      disabled={disabled}
      readOnly={field.readOnly}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? null : Number(v));
      }}
    />
  );
}

function SelectControl({ field, value, onChange, disabled }) {
  return (
    <select
      className={forms.fieldInput}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">— select —</option>
      {(field.options || []).map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

function MultiselectControl({ field, value, onChange, disabled }) {
  const selected = Array.isArray(value) ? value : [];
  const toggle = (opt) => {
    if (selected.includes(opt)) {
      onChange(selected.filter((v) => v !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };
  return (
    <div className={s.chipGroup} role="group" aria-label={field.label}>
      {(field.options || []).map((opt) => (
        <button
          type="button"
          key={opt}
          className={`${s.chip} ${selected.includes(opt) ? s.chipSelected : ''}`}
          disabled={disabled}
          onClick={() => toggle(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function BooleanControl({ value, onChange, disabled }) {
  return (
    <label className={s.toggle}>
      <input
        type="checkbox"
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={s.toggleLabel}>{value ? 'Yes' : 'No'}</span>
    </label>
  );
}

function YesNoControl({ field, value, onChange, disabled }) {
  // Explicit Yes/No radios. Storage is the same boolean shape as
  // BOOLEAN (true / false / unset), so this can replace BOOLEAN on
  // any existing field without a data migration. The distinction
  // from BOOLEAN is that "unset" renders as no selection, making it
  // visually obvious that the question hasn't been answered yet —
  // unlike a checkbox where unchecked could mean either "I said no"
  // or "I haven't looked at this." Used in the Match Criteria
  // section where the team needs to know whether a requirement was
  // deliberately set.
  const answered = value === true || value === false;
  const isYes = value === true;
  return (
    <div className={s.radioRow}>
      <label className={s.radio}>
        <input
          type="radio"
          name={`yesno-${field.id}`}
          checked={answered && isYes}
          disabled={disabled}
          onChange={() => onChange(true)}
        />
        <span>Yes</span>
      </label>
      <label className={s.radio}>
        <input
          type="radio"
          name={`yesno-${field.id}`}
          checked={answered && !isYes}
          disabled={disabled}
          onChange={() => onChange(false)}
        />
        <span>No</span>
      </label>
    </div>
  );
}

function YNControl({ value, onChange, disabled, field }) {
  // Shape: { answer: 'Yes'|'No'|'Unknown', note?: string }
  // Also accepts plain string for back-compat with simple Y/N fields.
  const state = typeof value === 'object' && value !== null
    ? value
    : { answer: value || null, note: '' };

  const setAnswer = (answer) => onChange({ ...state, answer });
  const setNote = (note) => onChange({ ...state, note });

  const options = field.options || ['Yes', 'No', 'Unknown'];

  return (
    <div className={s.ynWrap}>
      <div className={s.radioRow}>
        {options.map((opt) => (
          <label key={opt} className={s.radio}>
            <input
              type="radio"
              name={`yn-${field.id}`}
              checked={state.answer === opt}
              disabled={disabled}
              onChange={() => setAnswer(opt)}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
      {state.answer && state.answer !== 'Unknown' && (
        <input
          type="text"
          className={`${forms.fieldInput} ${s.ynNote}`}
          placeholder="Optional note"
          value={state.note || ''}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
    </div>
  );
}

function PhoneControl({ field, value, onChange, disabled }) {
  return (
    <input
      type="tel"
      className={forms.fieldInput}
      value={value ?? ''}
      placeholder={field.placeholder || '(555) 555-5555'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function EmailControl({ field, value, onChange, disabled }) {
  return (
    <input
      type="email"
      className={forms.fieldInput}
      value={value ?? ''}
      placeholder={field.placeholder || 'name@example.com'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ListControl({ field, value, onChange, disabled }) {
  // Value: array of row objects shaped by field.subfields.
  const rows = Array.isArray(value) ? value : [];
  const ordered = Boolean(field.ordered);

  const updateRow = (idx, subId, newVal) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, [subId]: newVal } : r));
    onChange(next);
  };
  const addRow = () => {
    onChange([...rows, {}]);
  };
  const removeRow = (idx) => {
    onChange(rows.filter((_, i) => i !== idx));
  };
  const moveUp = (idx) => onChange(moveRowUp(rows, idx));
  const moveDown = (idx) => onChange(moveRowDown(rows, idx));

  return (
    <div className={s.listWrap}>
      {rows.length === 0 && (
        <div className={s.listEmpty}>No entries yet.</div>
      )}
      {rows.map((row, idx) => (
        <div key={idx} className={s.listRow}>
          {ordered && (
            <div className={s.listOrderControls}>
              <div className={s.listOrderNumber}>{idx + 1}</div>
              <button
                type="button"
                className={s.listOrderBtn}
                disabled={disabled || idx === 0}
                onClick={() => moveUp(idx)}
                aria-label="Move up"
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className={s.listOrderBtn}
                disabled={disabled || idx === rows.length - 1}
                onClick={() => moveDown(idx)}
                aria-label="Move down"
                title="Move down"
              >
                ↓
              </button>
            </div>
          )}
          <div className={s.listRowFields}>
            {field.subfields.map((sub) => (
              <div key={sub.id} className={s.listSubfield}>
                <label className={s.listSubLabel}>{sub.label}</label>
                <FieldRenderer
                  field={sub}
                  value={row[sub.id]}
                  onChange={(v) => updateRow(idx, sub.id, v)}
                  disabled={disabled}
                  siblingValues={row}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            className={s.listRemove}
            disabled={disabled}
            onClick={() => removeRow(idx)}
            aria-label="Remove entry"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className={s.listAdd}
        disabled={disabled}
        onClick={addRow}
      >
        + Add {singularize(field.label)}
      </button>
    </div>
  );
}

function PRNControl({ field, value, onChange, disabled }) {
  // P (Preferred) / R (Required) / N (Not needed)
  const tokens = [
    { key: 'P', label: 'Preferred', color: s.prnP },
    { key: 'R', label: 'Required', color: s.prnR },
    { key: 'N', label: 'Not needed', color: s.prnN },
  ];

  const current = value?.flag ?? null;
  const selectedOption = value?.option ?? null;

  const setFlag = (key) => {
    if (current === key) {
      onChange(null);
    } else {
      onChange({ ...(value || {}), flag: key });
    }
  };
  const setOption = (opt) => {
    onChange({ ...(value || {}), option: opt });
  };

  return (
    <div className={s.prnWrap}>
      <div className={s.prnFlags}>
        {tokens.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`${s.prnFlag} ${t.color} ${current === t.key ? s.prnFlagActive : ''}`}
            disabled={disabled}
            onClick={() => setFlag(t.key)}
            title={t.label}
          >
            {t.key}
          </button>
        ))}
      </div>
      {field.options && field.options.length > 0 && current && current !== 'N' && (
        <select
          className={`${forms.fieldInput} ${s.prnOption}`}
          value={selectedOption || ''}
          disabled={disabled}
          onChange={(e) => setOption(e.target.value || null)}
        >
          <option value="">— choose option —</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function LevelPickControl({ value, onChange, disabled }) {
  const levels = ['Independent', 'Setup only', 'Partial assist', 'Full assist', 'Dependent'];
  return (
    <div className={s.levelPick} role="group">
      {levels.map((lvl) => (
        <button
          type="button"
          key={lvl}
          className={`${s.level} ${value === lvl ? s.levelActive : ''}`}
          disabled={disabled}
          onClick={() => onChange(lvl)}
        >
          {lvl}
        </button>
      ))}
    </div>
  );
}

function AutocompleteControl({ field, value, onChange, disabled }) {
  // Free-text input with a filtered suggestion dropdown. The stored
  // value is always whatever's in the input — suggestions only speed
  // up entry. Custom values are preserved.
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);

  const search = SUGGESTION_SOURCES[field.suggestionsKey];
  const suggestions = (open && search) ? search(value, 8) : [];

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const pick = (option) => {
    onChange(option);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      pick(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className={s.autocompleteWrap} ref={rootRef}>
      <input
        type="text"
        className={forms.fieldInput}
        value={value ?? ''}
        placeholder={field.placeholder || ''}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIndex(-1); }}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className={s.autocompleteList} role="listbox">
          {suggestions.map((opt, idx) => (
            <li
              key={opt}
              role="option"
              aria-selected={idx === activeIndex}
              className={`${s.autocompleteItem} ${idx === activeIndex ? s.autocompleteItemActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(opt); }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UnknownControl({ field }) {
  return (
    <div className={s.unknown}>
      ⚠️ Unknown field type: <code>{field.type}</code>
    </div>
  );
}


// ─── Helpers ───────────────────────────────────────────────────

function singularize(label) {
  if (!label) return 'item';
  const trimmed = label.trim();
  if (trimmed.endsWith('ies')) return trimmed.slice(0, -3).toLowerCase() + 'y';
  if (trimmed.endsWith('s')) return trimmed.slice(0, -1).toLowerCase();
  return trimmed.toLowerCase();
}
