import { describe, it, expect } from 'vitest';

describe('Board Checklists field mapping', () => {
  it('dbToCaregiver maps board_checklists to boardChecklists', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-1', first_name: 'Jane', last_name: 'Doe',
      board_checklists: [{ id: 'cl_1', name: 'Test', items: [] }],
      tasks: {}, notes: [], phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardChecklists).toEqual([{ id: 'cl_1', name: 'Test', items: [] }]);
  });

  it('dbToCaregiver defaults boardChecklists to empty array when null', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-2', first_name: 'John', last_name: 'Smith',
      board_checklists: null,
      tasks: {}, notes: [], phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardChecklists).toEqual([]);
  });

  it('dbToCaregiver defaults boardChecklists to empty array when undefined', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-3', first_name: 'Bob', last_name: 'Jones',
      tasks: {}, notes: [], phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardChecklists).toEqual([]);
  });
});
