import { describe, it, expect } from 'vitest';
import {
  formatValueForDisplay,
  sameValue,
  buildProposalRows,
  defaultSelectedIds,
  groupProposalRows,
  makeTaskKey,
  defaultSelectedTaskKeys,
  formatTaskSchedule,
  groupTaskProposals,
} from '../../features/care-plans/voice/voiceExtractDiff';


describe('formatValueForDisplay', () => {
  it('renders empty / null as em-dash', () => {
    expect(formatValueForDisplay(null)).toBe('—');
    expect(formatValueForDisplay(undefined)).toBe('—');
    expect(formatValueForDisplay('')).toBe('—');
    expect(formatValueForDisplay([])).toBe('—');
  });

  it('passes through plain strings and numbers', () => {
    expect(formatValueForDisplay('hello')).toBe('hello');
    expect(formatValueForDisplay(42)).toBe('42');
  });

  it('renders booleans as Yes/No', () => {
    expect(formatValueForDisplay(true)).toBe('Yes');
    expect(formatValueForDisplay(false)).toBe('No');
  });

  it('joins string arrays (multiselect) with commas', () => {
    expect(formatValueForDisplay(['English', 'Spanish'])).toBe('English, Spanish');
  });

  it('summarizes list rows (object arrays) inline', () => {
    const meds = [
      { name: 'Metformin', dose: '500mg' },
      { name: 'Lisinopril', dose: '10mg' },
    ];
    const out = formatValueForDisplay(meds);
    expect(out).toContain('name: Metformin');
    expect(out).toContain('Lisinopril');
  });

  it('renders YN shape with note', () => {
    expect(formatValueForDisplay({ answer: 'Yes', note: 'while seated' }))
      .toBe('Yes — while seated');
    expect(formatValueForDisplay({ answer: 'No' })).toBe('No');
  });

  it('renders PRN shape with flag label and optional option', () => {
    expect(formatValueForDisplay({ flag: 'R' })).toBe('Required');
    expect(formatValueForDisplay({ flag: 'P', option: 'Female' }))
      .toBe('Preferred (Female)');
    expect(formatValueForDisplay({ flag: 'N' })).toBe('Not needed');
  });
});


describe('sameValue', () => {
  it('handles primitives', () => {
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, 'a')).toBe(false);
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(true, true)).toBe(true);
  });

  it('handles arrays element-wise', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameValue([], [])).toBe(true);
  });

  it('handles nested objects', () => {
    expect(sameValue({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});


describe('buildProposalRows', () => {
  const claims = [
    {
      id: 'fullName', fieldLabel: 'Full legal name', fieldType: 'text',
      value: 'Mary Johnson', confidence: 'high',
      quote: 'her name is Mary Johnson', quoteVerified: true,
    },
    {
      id: 'gender', fieldLabel: 'Gender', fieldType: 'select',
      value: 'Female', confidence: 'high',
      quote: 'she is female', quoteVerified: true,
    },
  ];

  it('joins claims with current values and flags unchanged rows', () => {
    const rows = buildProposalRows(claims, { gender: 'Female' });
    expect(rows).toHaveLength(2);

    const name = rows.find((r) => r.id === 'fullName');
    expect(name.currentValue).toBeUndefined();
    expect(name.proposedValue).toBe('Mary Johnson');
    expect(name.isUnchanged).toBe(false);

    const gender = rows.find((r) => r.id === 'gender');
    expect(gender.currentValue).toBe('Female');
    expect(gender.proposedValue).toBe('Female');
    expect(gender.isUnchanged).toBe(true);
  });

  it('tolerates empty claims and empty current values', () => {
    expect(buildProposalRows([], {})).toEqual([]);
    expect(buildProposalRows(null, null)).toEqual([]);
  });

  it('carries through confidence + quote + verification flag', () => {
    const rows = buildProposalRows(claims, {});
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].quote).toBe('her name is Mary Johnson');
    expect(rows[0].quoteVerified).toBe(true);
  });
});


describe('buildProposalRows with group context', () => {
  it('carries groupId/groupLabel through to the proposal row', () => {
    const claims = [
      {
        id: 'ambulation_mobilityLevel', fieldLabel: 'Mobility level',
        fieldType: 'levelPick', value: 'Independent', confidence: 'high',
        quote: 'walks on her own', quoteVerified: true,
        groupId: 'ambulation', groupLabel: 'Ambulation & Transfers',
      },
    ];
    const [row] = buildProposalRows(claims, {});
    expect(row.groupId).toBe('ambulation');
    expect(row.groupLabel).toBe('Ambulation & Transfers');
  });

  it('leaves groupId undefined when the claim has none (flat sections)', () => {
    const claims = [
      {
        id: 'fullName', fieldLabel: 'Full name', fieldType: 'text',
        value: 'Mary', confidence: 'high', quote: 'Mary', quoteVerified: true,
      },
    ];
    const [row] = buildProposalRows(claims, {});
    expect(row.groupId).toBeUndefined();
    expect(row.groupLabel).toBeUndefined();
  });
});


describe('groupProposalRows', () => {
  const schemaGroups = [
    { id: 'ambulation', label: 'Ambulation & Transfers' },
    { id: 'bathing',    label: 'Bathing & Grooming' },
    { id: 'dressing',   label: 'Dressing' },
  ];

  it('buckets rows by groupId preserving schema declaration order', () => {
    const rows = [
      { id: 'bathing_method',          groupId: 'bathing' },
      { id: 'ambulation_mobility',     groupId: 'ambulation' },
      { id: 'dressing_assistLevel',    groupId: 'dressing' },
      { id: 'ambulation_aids',         groupId: 'ambulation' },
    ];
    const out = groupProposalRows(rows, schemaGroups);
    expect(out.map((b) => b.groupId)).toEqual(['ambulation', 'bathing', 'dressing']);
    expect(out[0].rows.map((r) => r.id))
      .toEqual(['ambulation_mobility', 'ambulation_aids']);
    expect(out[1].rows.map((r) => r.id)).toEqual(['bathing_method']);
    expect(out[2].rows.map((r) => r.id)).toEqual(['dressing_assistLevel']);
  });

  it('omits groups that have no rows', () => {
    const rows = [
      { id: 'ambulation_mobility', groupId: 'ambulation' },
    ];
    const out = groupProposalRows(rows, schemaGroups);
    expect(out.map((b) => b.groupId)).toEqual(['ambulation']);
  });

  it('puts rows without a groupId into a separate ungrouped bucket', () => {
    const rows = [
      { id: 'a', groupId: 'ambulation' },
      { id: 'orphan' /* no groupId */ },
    ];
    const out = groupProposalRows(rows, schemaGroups);
    expect(out.map((b) => b.groupId)).toEqual(['ambulation', null]);
    expect(out[1].rows.map((r) => r.id)).toEqual(['orphan']);
  });

  it('handles flat sections (no schemaGroups) by lumping everything ungrouped', () => {
    const rows = [
      { id: 'fullName' },
      { id: 'gender' },
    ];
    const out = groupProposalRows(rows, undefined);
    expect(out).toHaveLength(1);
    expect(out[0].groupId).toBeNull();
    expect(out[0].rows.map((r) => r.id)).toEqual(['fullName', 'gender']);
  });

  it('returns empty array when there are no rows', () => {
    expect(groupProposalRows([], schemaGroups)).toEqual([]);
    expect(groupProposalRows(null, schemaGroups)).toEqual([]);
  });

  it('routes rows whose groupId is unknown into the ungrouped bucket', () => {
    const rows = [
      { id: 'a', groupId: 'ambulation' },
      { id: 'b', groupId: 'phantomGroup' /* not in schemaGroups */ },
    ];
    const out = groupProposalRows(rows, schemaGroups);
    // Phantom rows shouldn't silently vanish — they go to ungrouped
    // so the user still sees them.
    const ungrouped = out.find((b) => b.groupId === null);
    expect(ungrouped).toBeDefined();
    expect(ungrouped.rows.map((r) => r.id)).toEqual(['b']);
  });
});


describe('defaultSelectedIds', () => {
  it('pre-selects high-confidence, verified, changed rows', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: true,  confidence: 'high' },
      { id: 'b', isUnchanged: false, quoteVerified: true,  confidence: 'medium' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(true);
    expect(sel.has('b')).toBe(true);
  });

  it('skips unchanged rows', () => {
    const rows = [
      { id: 'a', isUnchanged: true,  quoteVerified: true, confidence: 'high' },
      { id: 'b', isUnchanged: false, quoteVerified: true, confidence: 'high' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
    expect(sel.has('b')).toBe(true);
  });

  it('skips unverified-quote rows (likely hallucinations)', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: false, confidence: 'high' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
  });

  it('skips low-confidence rows (force opt-in)', () => {
    const rows = [
      { id: 'a', isUnchanged: false, quoteVerified: true, confidence: 'low' },
    ];
    const sel = defaultSelectedIds(rows);
    expect(sel.has('a')).toBe(false);
  });
});


// ─── Task helpers (Phase 3) ────────────────────────────────────

describe('makeTaskKey', () => {
  it('uses category + task_name + index for uniqueness', () => {
    const k1 = makeTaskKey({ category: 'adl.bathing', task_name: 'Shower help' }, 0);
    const k2 = makeTaskKey({ category: 'adl.bathing', task_name: 'Shower help' }, 1);
    expect(k1).not.toBe(k2);
    expect(k1).toContain('adl.bathing');
    expect(k1).toContain('Shower help');
  });

  it('tolerates missing task_name', () => {
    const k = makeTaskKey({ category: 'adl.bathing' }, 0);
    expect(k).toBe('adl.bathing::0');
  });
});


describe('defaultSelectedTaskKeys', () => {
  const baseTasks = [
    { category: 'adl.bathing', task_name: 'Shower help', confidence: 'high', quoteVerified: true },
    { category: 'adl.feeding', task_name: 'Prepare breakfast', confidence: 'medium', quoteVerified: true },
    { category: 'adl.dressing', task_name: 'Help with pants', confidence: 'low', quoteVerified: true },
    { category: 'adl.toileting', task_name: 'Bathroom assist', confidence: 'high', quoteVerified: false },
  ];

  it('pre-selects high/medium confidence with verified quotes', () => {
    const sel = defaultSelectedTaskKeys(baseTasks);
    expect(sel.has(makeTaskKey(baseTasks[0], 0))).toBe(true);
    expect(sel.has(makeTaskKey(baseTasks[1], 1))).toBe(true);
  });

  it('skips low-confidence tasks (force opt-in)', () => {
    const sel = defaultSelectedTaskKeys(baseTasks);
    expect(sel.has(makeTaskKey(baseTasks[2], 2))).toBe(false);
  });

  it('skips unverified-quote tasks (likely hallucinations)', () => {
    const sel = defaultSelectedTaskKeys(baseTasks);
    expect(sel.has(makeTaskKey(baseTasks[3], 3))).toBe(false);
  });

  it('handles empty / null input', () => {
    expect(defaultSelectedTaskKeys([])).toEqual(new Set());
    expect(defaultSelectedTaskKeys(null)).toEqual(new Set());
  });
});


describe('formatTaskSchedule', () => {
  it('renders "All shifts" when shifts is [all]', () => {
    expect(formatTaskSchedule({ shifts: ['all'], days_of_week: [], priority: 'standard' }))
      .toBe('All shifts · daily');
  });

  it('renders specific shifts capitalized', () => {
    expect(formatTaskSchedule({ shifts: ['morning'], days_of_week: [], priority: 'standard' }))
      .toBe('Morning · daily');
  });

  it('lists specific days', () => {
    expect(formatTaskSchedule({
      shifts: ['morning'],
      days_of_week: ['Mon', 'Wed', 'Fri'],
      priority: 'standard',
    })).toBe('Morning · Mon/Wed/Fri');
  });

  it('shows "every day" for full week', () => {
    expect(formatTaskSchedule({
      shifts: ['all'],
      days_of_week: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      priority: 'standard',
    })).toBe('All shifts · every day');
  });

  it('appends non-standard priorities', () => {
    expect(formatTaskSchedule({
      shifts: ['all'], days_of_week: [], priority: 'critical',
    })).toBe('All shifts · daily · critical');
    expect(formatTaskSchedule({
      shifts: ['all'], days_of_week: [], priority: 'optional',
    })).toBe('All shifts · daily · optional');
  });
});


describe('groupTaskProposals', () => {
  const schemaGroups = [
    { id: 'ambulation', label: 'Ambulation & Transfers' },
    { id: 'bathing',    label: 'Bathing & Grooming' },
  ];

  const tasks = [
    { category: 'adl.bathing', task_name: 'Shower help', groupId: 'bathing' },
    { category: 'adl.ambulation', task_name: 'Walk to mailbox', groupId: 'ambulation' },
    { category: 'adl.bathing', task_name: 'Dry hair', groupId: 'bathing' },
  ];

  it('buckets by groupId preserving schema order', () => {
    const out = groupTaskProposals(tasks, schemaGroups);
    expect(out.map((b) => b.groupId)).toEqual(['ambulation', 'bathing']);
    expect(out[0].tasks.map((x) => x.task.task_name)).toEqual(['Walk to mailbox']);
    expect(out[1].tasks.map((x) => x.task.task_name)).toEqual(['Shower help', 'Dry hair']);
  });

  it('attaches a stable key to each task entry', () => {
    const out = groupTaskProposals(tasks, schemaGroups);
    const keys = out.flatMap((b) => b.tasks.map((x) => x.key));
    // All keys are unique
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('routes tasks with unknown groupId to ungrouped bucket', () => {
    const out = groupTaskProposals([
      { category: 'adl.bathing', task_name: 'X', groupId: 'phantom' },
    ], schemaGroups);
    expect(out).toHaveLength(1);
    expect(out[0].groupId).toBeNull();
    expect(out[0].tasks).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(groupTaskProposals([], schemaGroups)).toEqual([]);
    expect(groupTaskProposals(null, schemaGroups)).toEqual([]);
  });
});
