import { describe, it, expect } from 'vitest';
import { dayNamesToIndices } from '../voice/voiceTaskSchema';

// Regression guard for the care-plan-draft / voice-task crash:
// care_plan_tasks.days_of_week is int[] (0=Sun..6=Sat), but the AI
// extractor returns day NAMES. Inserting a name threw
// "invalid input syntax for type integer: 'Mon'". This converter is the
// single place both the voice apply path and the assessment-draft path
// normalize names → integer indices before writing tasks.
describe('dayNamesToIndices', () => {
  it('maps day names to 0=Sun..6=Sat integer indices', () => {
    expect(dayNamesToIndices(['Mon', 'Wed', 'Fri'])).toEqual([1, 3, 5]);
    expect(dayNamesToIndices(['Sun', 'Sat'])).toEqual([0, 6]);
    expect(dayNamesToIndices(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']))
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('drops unrecognized names', () => {
    expect(dayNamesToIndices(['Mon', 'Funday', 'Fri'])).toEqual([1, 5]);
    expect(dayNamesToIndices(['nope'])).toEqual([]);
  });
  it('returns [] for empty / non-array input', () => {
    expect(dayNamesToIndices([])).toEqual([]);
    expect(dayNamesToIndices(null)).toEqual([]);
    expect(dayNamesToIndices(undefined)).toEqual([]);
  });
});
