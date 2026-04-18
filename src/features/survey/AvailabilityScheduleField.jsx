import { useMemo } from 'react';

// ═══════════════════════════════════════════════════════════════
// Availability Schedule Field (survey question type)
//
// Structured input for the `availability_schedule` question. The
// applicant picks weekday pills, then adds one or more time ranges
// per picked day. On submit, the answer flows through the edge
// function `sync_availability_from_survey` and lands as rows in
// `caregiver_availability` — so the shift matcher can use it.
//
// Answer shape:
//   {
//     timezone: "America/Los_Angeles" | null,
//     slots: [
//       { day: 0..6, startTime: "HH:MM", endTime: "HH:MM" }
//     ]
//   }
// ═══════════════════════════════════════════════════════════════

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function normalizeAnswer(value) {
  if (!value || typeof value !== 'object') {
    return { timezone: detectTimezone(), slots: [] };
  }
  const slots = Array.isArray(value.slots) ? value.slots : [];
  return {
    timezone: value.timezone ?? detectTimezone(),
    slots,
  };
}

export function AvailabilityScheduleField({ value, onChange, error }) {
  const answer = useMemo(() => normalizeAnswer(value), [value]);

  const selectedDays = useMemo(() => {
    const set = new Set();
    for (const s of answer.slots) {
      if (Number.isInteger(s?.day)) set.add(s.day);
    }
    return set;
  }, [answer.slots]);

  const commit = (nextSlots) => {
    onChange({ ...answer, slots: nextSlots });
  };

  const toggleDay = (day) => {
    if (selectedDays.has(day)) {
      commit(answer.slots.filter((s) => s.day !== day));
    } else {
      // Default range: 9am-5pm on first add
      commit([...answer.slots, { day, startTime: '09:00', endTime: '17:00' }]);
    }
  };

  const addRangeForDay = (day) => {
    commit([...answer.slots, { day, startTime: '09:00', endTime: '17:00' }]);
  };

  const removeRange = (index) => {
    const next = answer.slots.filter((_, i) => i !== index);
    commit(next);
  };

  const updateRange = (index, patch) => {
    const next = answer.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
    commit(next);
  };

  // Group slots by day for rendering, preserving the per-day ordering
  const slotsByDay = useMemo(() => {
    const map = new Map();
    answer.slots.forEach((slot, globalIndex) => {
      if (!Number.isInteger(slot?.day)) return;
      if (!map.has(slot.day)) map.set(slot.day, []);
      map.get(slot.day).push({ slot, globalIndex });
    });
    return map;
  }, [answer.slots]);

  return (
    <div style={wrapStyle}>
      {/* Day pills */}
      <div style={pillsWrapStyle}>
        {DAY_LABELS.map((label, day) => {
          const active = selectedDays.has(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => toggleDay(day)}
              style={active ? pillActiveStyle : pillStyle}
              aria-pressed={active}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div style={hintStyle}>
        Tap a day to mark it available. Tap again to remove.
      </div>

      {/* Per-day time ranges */}
      {selectedDays.size > 0 && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[...selectedDays].sort((a, b) => a - b).map((day) => {
            const ranges = slotsByDay.get(day) || [];
            return (
              <div key={day} style={dayRowStyle}>
                <div style={dayLabelStyle}>{DAY_LABELS[day]}</div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ranges.map(({ slot, globalIndex }, rangeIdx) => (
                    <div key={rangeIdx} style={rangeRowStyle}>
                      <input
                        type="time"
                        value={slot.startTime || ''}
                        onChange={(e) => updateRange(globalIndex, { startTime: e.target.value })}
                        style={timeInputStyle}
                        aria-label={`${DAY_LABELS[day]} start time`}
                      />
                      <span style={dashStyle}>to</span>
                      <input
                        type="time"
                        value={slot.endTime || ''}
                        onChange={(e) => updateRange(globalIndex, { endTime: e.target.value })}
                        style={timeInputStyle}
                        aria-label={`${DAY_LABELS[day]} end time`}
                      />
                      {ranges.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeRange(globalIndex)}
                          style={removeBtnStyle}
                          aria-label={`Remove ${DAY_LABELS[day]} range`}
                          title="Remove this range"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addRangeForDay(day)}
                    style={addBtnStyle}
                  >
                    + Add another time on {DAY_LABELS[day]}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div style={{ color: '#DC2626', fontSize: 12, marginTop: 8 }}>{error}</div>
      )}
    </div>
  );
}

// ─── Styles ───

const wrapStyle = {
  marginTop: 8,
};

const pillsWrapStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

const pillBaseStyle = {
  padding: '8px 14px',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  border: '1.5px solid #E0E4EA',
  background: '#fff',
  color: '#4B5563',
  fontFamily: 'inherit',
  transition: 'all 0.15s ease',
  minWidth: 56,
};

const pillStyle = { ...pillBaseStyle };

const pillActiveStyle = {
  ...pillBaseStyle,
  borderColor: 'var(--tc-cyan, #0891B2)',
  background: 'var(--tc-cyan, #0891B2)',
  color: '#fff',
};

const hintStyle = {
  fontSize: 12,
  color: '#7A8BA0',
  marginTop: 8,
  fontStyle: 'italic',
};

const dayRowStyle = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  padding: '12px 14px',
  border: '1px solid #E0E4EA',
  borderRadius: 10,
  background: '#FAFBFC',
};

const dayLabelStyle = {
  fontSize: 13,
  fontWeight: 700,
  color: '#0F1724',
  minWidth: 40,
  paddingTop: 8,
};

const rangeRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const timeInputStyle = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #CBD5E0',
  fontSize: 13,
  fontFamily: 'inherit',
  background: '#fff',
  color: '#0F1724',
  minWidth: 110,
};

const dashStyle = {
  color: '#7A8BA0',
  fontSize: 12,
  fontWeight: 500,
};

const removeBtnStyle = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: '1px solid #FECACA',
  background: '#FEF2F2',
  color: '#DC2626',
  cursor: 'pointer',
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1,
  padding: 0,
  fontFamily: 'inherit',
};

const addBtnStyle = {
  background: 'none',
  border: 'none',
  color: '#2E4E8D',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '4px 0',
  textAlign: 'left',
  fontFamily: 'inherit',
};
