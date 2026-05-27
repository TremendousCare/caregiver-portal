import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import styles from './SearchableSelect.module.css';

/**
 * Accessible, type-to-filter single-select combobox.
 *
 * Props:
 *   - value: current selected value (string). Empty string = the empty option.
 *   - onChange: (value) => void
 *   - options: array of { value, label, searchText? }. `searchText` defaults
 *       to `label` and is what's matched against the user's query.
 *   - emptyOption: { value, label } — pinned to the top, ignored by filtering
 *       (e.g., { value: '', label: 'All clients' }). Optional.
 *   - placeholder: shown in the search input when empty.
 *   - ariaLabel: accessible label when no visible <label> is associated.
 *   - id: optional id for the trigger button (for label htmlFor).
 *   - className: optional, applied to the outer wrapper.
 *   - disabled: optional.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  emptyOption,
  placeholder = 'Search…',
  ariaLabel,
  id,
  className,
  disabled,
}) {
  const generatedId = useId();
  const triggerId = id || `searchable-select-${generatedId}`;
  const listId = `${triggerId}-list`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const allOptions = useMemo(() => {
    const base = options || [];
    return emptyOption ? [emptyOption, ...base] : base;
  }, [options, emptyOption]);

  const selectedOption = useMemo(
    () => allOptions.find((o) => o.value === value) || null,
    [allOptions, value],
  );

  // Filtered list: the empty option is always pinned at the top regardless
  // of the query so users can always clear the filter.
  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    const matches = (options || []).filter((o) => {
      const text = (o.searchText ?? o.label ?? '').toLowerCase();
      return text.includes(q);
    });
    return emptyOption ? [emptyOption, ...matches] : matches;
  }, [allOptions, options, emptyOption, query]);

  // Open / close lifecycle: reset query and highlight, focus the input.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setHighlight(0);
      return;
    }
    // Focus the search input on the next tick so the open animation
    // doesn't steal focus back.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Clamp highlight when the filtered list shrinks.
  useEffect(() => {
    if (highlight >= filteredOptions.length) {
      setHighlight(Math.max(0, filteredOptions.length - 1));
    }
  }, [filteredOptions.length, highlight]);

  // Keep the highlighted row visible as the user arrows through.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${highlight}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, open, filteredOptions.length]);

  const selectOption = (opt) => {
    if (!opt) return;
    onChange?.(opt.value);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filteredOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectOption(filteredOptions[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(filteredOptions.length - 1);
    }
  };

  const triggerLabel =
    selectedOption?.label || emptyOption?.label || placeholder;

  return (
    <div
      ref={wrapperRef}
      className={`${styles.wrapper} ${className || ''}`}
    >
      <button
        type="button"
        id={triggerId}
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        <ChevronDown size={14} className={styles.triggerIcon} aria-hidden="true" />
      </button>

      {open && (
        <div className={styles.popover} role="dialog">
          <div className={styles.searchRow}>
            <Search size={14} className={styles.searchIcon} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={
                filteredOptions[highlight]
                  ? `${listId}-opt-${highlight}`
                  : undefined
              }
              className={styles.searchInput}
              placeholder={placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={handleKeyDown}
            />
            {query && (
              <button
                type="button"
                className={styles.clearBtn}
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>

          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-labelledby={triggerId}
            className={styles.list}
          >
            {filteredOptions.length === 0 ? (
              <li className={styles.empty} role="presentation">
                No matches
              </li>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isHighlighted = idx === highlight;
                return (
                  <li
                    key={`${opt.value}-${idx}`}
                    id={`${listId}-opt-${idx}`}
                    data-index={idx}
                    role="option"
                    aria-selected={isSelected}
                    className={`${styles.option} ${
                      isHighlighted ? styles.optionHighlighted : ''
                    } ${isSelected ? styles.optionSelected : ''}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={(e) => {
                      // Use mousedown so the input doesn't blur first and
                      // collapse the popover before the click fires.
                      e.preventDefault();
                      selectOption(opt);
                    }}
                  >
                    {opt.label}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
