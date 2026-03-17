import { describe, it, expect } from 'vitest';
import { DEFAULT_BOARD_LABELS, LABEL_COLORS } from '../constants';

describe('Board Labels constants', () => {
  it('DEFAULT_BOARD_LABELS has required shape', () => {
    expect(DEFAULT_BOARD_LABELS.length).toBeGreaterThanOrEqual(1);
    DEFAULT_BOARD_LABELS.forEach((label) => {
      expect(label).toHaveProperty('id');
      expect(label).toHaveProperty('name');
      expect(label).toHaveProperty('color');
      expect(typeof label.id).toBe('string');
      expect(typeof label.name).toBe('string');
      expect(label.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  it('all label IDs are unique', () => {
    const ids = DEFAULT_BOARD_LABELS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('LABEL_COLORS are valid hex colors', () => {
    expect(LABEL_COLORS.length).toBeGreaterThanOrEqual(6);
    LABEL_COLORS.forEach((color) => {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });
});

describe('Board Labels field mapping', () => {
  it('dbToCaregiver maps board_labels to boardLabels', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-1',
      first_name: 'Jane',
      last_name: 'Doe',
      board_labels: ['urgent', 'bilingual'],
      tasks: {},
      notes: [],
      phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardLabels).toEqual(['urgent', 'bilingual']);
  });

  it('dbToCaregiver defaults boardLabels to empty array when null', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-2',
      first_name: 'John',
      last_name: 'Smith',
      board_labels: null,
      tasks: {},
      notes: [],
      phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardLabels).toEqual([]);
  });

  it('dbToCaregiver defaults boardLabels to empty array when undefined', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-3',
      first_name: 'Bob',
      last_name: 'Jones',
      tasks: {},
      notes: [],
      phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardLabels).toEqual([]);
  });
});
