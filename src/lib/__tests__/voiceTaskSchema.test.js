import { describe, it, expect } from 'vitest';
import {
  buildVoiceTaskSchema,
  sectionSupportsTaskCapture,
  TASK_SHIFTS,
  TASK_DAYS_OF_WEEK,
  TASK_PRIORITIES,
} from '../../features/care-plans/voice/voiceTaskSchema';
import { getSectionById } from '../../features/care-plans/sections';


describe('TASK_SHIFTS / TASK_DAYS_OF_WEEK / TASK_PRIORITIES', () => {
  it('matches the canonical vocabulary used by TaskEditor', () => {
    // These are the strings stored in care_plan_tasks. If they ever
    // drift from TaskEditor's options, voice extraction will produce
    // tasks the editor's chip groups can't render.
    expect(TASK_SHIFTS).toEqual(['all', 'morning', 'afternoon', 'evening', 'overnight']);
    expect(TASK_DAYS_OF_WEEK).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(TASK_PRIORITIES).toEqual(['standard', 'critical', 'optional']);
  });
});


describe('sectionSupportsTaskCapture', () => {
  it('returns false for null/undefined', () => {
    expect(sectionSupportsTaskCapture(null)).toBe(false);
    expect(sectionSupportsTaskCapture(undefined)).toBe(false);
  });

  it('returns true for sections with usesTasksTable=true', () => {
    expect(sectionSupportsTaskCapture(getSectionById('dailyLiving'))).toBe(true);
    expect(sectionSupportsTaskCapture(getSectionById('homeAndLife'))).toBe(true);
  });

  it('returns false for sections without a tasks side table', () => {
    expect(sectionSupportsTaskCapture(getSectionById('whoTheyAre'))).toBe(false);
    expect(sectionSupportsTaskCapture(getSectionById('healthProfile'))).toBe(false);
    expect(sectionSupportsTaskCapture(getSectionById('snapshot'))).toBe(false);
  });
});


describe('buildVoiceTaskSchema', () => {
  it('returns null for null/undefined section', () => {
    expect(buildVoiceTaskSchema(null)).toBeNull();
    expect(buildVoiceTaskSchema(undefined)).toBeNull();
  });

  it('returns null for sections without a tasks side table', () => {
    expect(buildVoiceTaskSchema(getSectionById('whoTheyAre'))).toBeNull();
    expect(buildVoiceTaskSchema(getSectionById('cognitionBehavior'))).toBeNull();
  });

  it('returns a schema for Daily Living (ADLs)', () => {
    const schema = buildVoiceTaskSchema(getSectionById('dailyLiving'));
    expect(schema).toBeDefined();
    expect(schema.categories.length).toBeGreaterThan(0);
    // Every category belongs to the ADL section (adl.*).
    expect(schema.categories.every((c) => c.key.startsWith('adl.'))).toBe(true);
  });

  it('returns a schema for Home & Life (IADLs)', () => {
    const schema = buildVoiceTaskSchema(getSectionById('homeAndLife'));
    expect(schema).toBeDefined();
    expect(schema.categories.every((c) => c.key.startsWith('iadl.'))).toBe(true);
  });

  it('includes specific ADL categories with their human labels', () => {
    const schema = buildVoiceTaskSchema(getSectionById('dailyLiving'));
    const bathing = schema.categories.find((c) => c.key === 'adl.bathing');
    expect(bathing).toBeDefined();
    expect(bathing.label).toBe('Bathing');
  });

  it('tags each category with the accordion group that owns it (groupHint)', () => {
    const schema = buildVoiceTaskSchema(getSectionById('dailyLiving'));
    const bathing = schema.categories.find((c) => c.key === 'adl.bathing');
    expect(bathing.groupHint).toBe('bathing');
    const ambulation = schema.categories.find((c) => c.key === 'adl.ambulation');
    expect(ambulation.groupHint).toBe('ambulation');
  });

  it('exposes the canonical shifts/days/priorities vocabulary', () => {
    const schema = buildVoiceTaskSchema(getSectionById('dailyLiving'));
    expect(schema.shifts).toEqual(TASK_SHIFTS);
    expect(schema.daysOfWeek).toEqual(TASK_DAYS_OF_WEEK);
    expect(schema.priorities).toEqual(TASK_PRIORITIES);
  });
});
