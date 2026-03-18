import { describe, it, expect } from 'vitest';

describe('Board Due Date field mapping', () => {
  it('dbToCaregiver maps board_due_date to boardDueDate', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-1', first_name: 'Jane', last_name: 'Doe',
      board_due_date: '2026-04-01',
      tasks: {}, notes: [], phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardDueDate).toBe('2026-04-01');
  });

  it('dbToCaregiver defaults boardDueDate to null when missing', async () => {
    const { dbToCaregiver } = await import('../storage');
    const row = {
      id: 'test-2', first_name: 'John', last_name: 'Smith',
      tasks: {}, notes: [], phase_timestamps: {},
    };
    const cg = dbToCaregiver(row);
    expect(cg.boardDueDate).toBeNull();
  });
});
