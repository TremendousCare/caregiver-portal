import { describe, it, expect } from 'vitest';
import { describeDeleteError } from '../errors';

describe('describeDeleteError', () => {
  it('reports foreign key violations as related-records errors', () => {
    const msg = describeDeleteError({ code: '23503', message: 'violates fk' }, 'caregiver');
    expect(msg).toMatch(/related records exist/);
    expect(msg).toMatch(/caregiver/);
  });

  it('reports RLS / permission failures clearly', () => {
    const msg = describeDeleteError({ code: '42501' }, 'client');
    expect(msg).toMatch(/Permission denied/);
    expect(msg).toMatch(/client/);
  });

  it('reports PostgREST not-found codes as already-deleted', () => {
    const msg = describeDeleteError({ code: 'PGRST116' }, 'caregiver');
    expect(msg).toMatch(/not found/);
  });

  it('falls back to message when code is unknown', () => {
    const msg = describeDeleteError({ code: '99999', message: 'something odd' }, 'client');
    expect(msg).toMatch(/something odd/);
  });

  it('treats missing code as a network/connection failure', () => {
    const msg = describeDeleteError(new Error('Failed to fetch'), 'caregiver');
    expect(msg).toMatch(/check your connection/);
  });

  it('handles null/undefined error objects', () => {
    expect(describeDeleteError(null, 'caregiver')).toMatch(/check your connection/);
    expect(describeDeleteError(undefined, 'client')).toMatch(/check your connection/);
  });

  it('uses a default entity label when none is supplied', () => {
    const msg = describeDeleteError({ code: '23503' });
    expect(msg).toMatch(/record/);
  });
});
