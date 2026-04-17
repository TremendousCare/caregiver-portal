import {
  DAY_OF_WEEK_LABELS_SHORT,
  DAY_OF_WEEK_LABELS_LONG,
  describeRecurrencePattern,
  emptyRecurrencePattern,
  hasRecurrencePattern,
  toggleDayInPattern,
} from './recurrenceHelpers';
import s from './RecurrencePatternEditor.module.css';

// ═══════════════════════════════════════════════════════════════
// RecurrencePatternEditor — Phase 7
//
// Embedded editor section inside the care plan form. Controlled
// component: parent owns the pattern state (which lives on
// draft.recurrencePattern) and passes it in as `value`.
//
// When the "Use a recurring weekly pattern" toggle is off, value
// should be null. When on, value is a full pattern object with
// days_of_week, start_time, end_time, etc.
// ═══════════════════════════════════════════════════════════════

export function RecurrencePatternEditor({ value, onChange, disabled }) {
  const enabled = hasRecurrencePattern(value) || (value && Array.isArray(value.days_of_week));
  const pattern = enabled ? value : emptyRecurrencePattern();

  const handleToggleEnabled = (e) => {
    if (e.target.checked) {
      onChange(emptyRecurrencePattern());
    } else {
      onChange(null);
    }
  };

  const handleToggleDay = (dow) => {
    onChange({
      ...pattern,
      days_of_week: toggleDayInPattern(pattern.days_of_week, dow),
    });
  };

  const setField = (field, val) => onChange({ ...pattern, [field]: val });

  const summary = describeRecurrencePattern(enabled ? pattern : null);

  return (
    <div className={s.editor}>
      <label className={s.toggleRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleToggleEnabled}
          disabled={disabled}
        />
        <span className={s.toggleLabel}>Use a recurring weekly pattern</span>
      </label>

      {enabled && (
        <div className={s.panel}>
          <div className={s.fieldLabel}>Days of week</div>
          <div className={s.daysRow} role="group" aria-label="Days of week">
            {DAY_OF_WEEK_LABELS_SHORT.map((label, dow) => {
              const isSelected = pattern.days_of_week.includes(dow);
              return (
                <button
                  key={dow}
                  type="button"
                  className={`${s.dayBtn} ${isSelected ? s.dayBtnActive : ''}`}
                  onClick={() => handleToggleDay(dow)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                  title={DAY_OF_WEEK_LABELS_LONG[dow]}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className={s.timeRow}>
            <label className={s.timeField}>
              <span className={s.fieldLabel}>Start time</span>
              <input
                type="time"
                className={s.input}
                value={pattern.start_time || ''}
                onChange={(e) => setField('start_time', e.target.value)}
                step="900"
                disabled={disabled}
              />
            </label>
            <label className={s.timeField}>
              <span className={s.fieldLabel}>End time</span>
              <input
                type="time"
                className={s.input}
                value={pattern.end_time || ''}
                onChange={(e) => setField('end_time', e.target.value)}
                step="900"
                disabled={disabled}
              />
            </label>
          </div>

          <div className={s.dateRow}>
            <label className={s.dateField}>
              <span className={s.fieldLabel}>
                Effective from <span className={s.hint}>(optional)</span>
              </span>
              <input
                type="date"
                className={s.input}
                value={pattern.start_date || ''}
                onChange={(e) => setField('start_date', e.target.value || null)}
                disabled={disabled}
              />
            </label>
            <label className={s.dateField}>
              <span className={s.fieldLabel}>
                Effective until <span className={s.hint}>(optional)</span>
              </span>
              <input
                type="date"
                className={s.input}
                value={pattern.end_date || ''}
                onChange={(e) => setField('end_date', e.target.value || null)}
                disabled={disabled}
              />
            </label>
          </div>

          <div className={s.summary} role="status">
            <span className={s.summaryLabel}>Preview:</span> {summary}
          </div>
        </div>
      )}
    </div>
  );
}
