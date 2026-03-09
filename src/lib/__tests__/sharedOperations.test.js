/**
 * Tests for shared operation functions.
 * Tests pure functions (createNote, field allowlist validation) that can run in Node/Vitest.
 * DB-calling functions are verified via production testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNote } from '../../../supabase/functions/_shared/operations/notes.ts';
import {
  UPDATABLE_CAREGIVER_FIELDS,
  UPDATABLE_CLIENT_FIELDS,
} from '../../../supabase/functions/_shared/operations/constants.ts';
import { updateCaregiverField } from '../../../supabase/functions/_shared/operations/caregiver.ts';
import { updateClientField } from '../../../supabase/functions/_shared/operations/client.ts';

// ─── createNote() ────────────────────────────────────────────

describe('createNote', () => {
  it('creates a note with defaults', () => {
    const note = createNote({ text: 'Test note' }, 'User A');
    expect(note.text).toBe('Test note');
    expect(note.type).toBe('note');
    expect(note.direction).toBeNull();
    expect(note.outcome).toBeNull();
    expect(note.author).toBe('User A');
    expect(typeof note.timestamp).toBe('number');
    expect(note.timestamp).toBeGreaterThan(0);
  });

  it('creates a note with all fields', () => {
    const note = createNote(
      { text: 'SMS sent', type: 'text', direction: 'outbound', outcome: 'delivered' },
      'Bot',
    );
    expect(note.text).toBe('SMS sent');
    expect(note.type).toBe('text');
    expect(note.direction).toBe('outbound');
    expect(note.outcome).toBe('delivered');
    expect(note.author).toBe('Bot');
  });

  it('defaults author to AI Assistant when empty', () => {
    const note = createNote({ text: 'Auto note' }, '');
    expect(note.author).toBe('AI Assistant');
  });
});

// ─── UPDATABLE_CAREGIVER_FIELDS ──────────────────────────────

describe('UPDATABLE_CAREGIVER_FIELDS', () => {
  it('includes expected contact fields', () => {
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('phone');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('email');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('address');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('city');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('state');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('zip');
  });

  it('includes expected professional fields', () => {
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('has_hca');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('hca_expiration');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('availability');
    expect(UPDATABLE_CAREGIVER_FIELDS).toContain('certifications');
  });

  it('does not include protected fields', () => {
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('id');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('created_at');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('first_name');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('last_name');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('notes');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('tasks');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('phase_override');
    expect(UPDATABLE_CAREGIVER_FIELDS).not.toContain('board_status');
  });

  it('has exactly 18 fields', () => {
    expect(UPDATABLE_CAREGIVER_FIELDS).toHaveLength(18);
  });
});

// ─── UPDATABLE_CLIENT_FIELDS ─────────────────────────────────

describe('UPDATABLE_CLIENT_FIELDS', () => {
  it('includes expected contact fields', () => {
    expect(UPDATABLE_CLIENT_FIELDS).toContain('phone');
    expect(UPDATABLE_CLIENT_FIELDS).toContain('email');
    expect(UPDATABLE_CLIENT_FIELDS).toContain('address');
  });

  it('includes expected care fields', () => {
    expect(UPDATABLE_CLIENT_FIELDS).toContain('care_needs');
    expect(UPDATABLE_CLIENT_FIELDS).toContain('hours_needed');
    expect(UPDATABLE_CLIENT_FIELDS).toContain('budget_range');
    expect(UPDATABLE_CLIENT_FIELDS).toContain('care_recipient_name');
  });

  it('does not include protected fields', () => {
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('id');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('created_at');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('first_name');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('last_name');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('notes');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('tasks');
    expect(UPDATABLE_CLIENT_FIELDS).not.toContain('phase');
  });

  it('has exactly 21 fields', () => {
    expect(UPDATABLE_CLIENT_FIELDS).toHaveLength(21);
  });
});

// ─── updateCaregiverField allowlist validation ───────────────

describe('updateCaregiverField', () => {
  it('rejects disallowed fields without hitting DB', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateCaregiverField(mockSupabase, 'cg-1', 'id', 'new-value');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be updated');
    expect(result.error).toContain('Allowed');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('rejects protected fields like first_name', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateCaregiverField(mockSupabase, 'cg-1', 'first_name', 'New Name');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be updated');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('rejects notes field', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateCaregiverField(mockSupabase, 'cg-1', 'notes', '[]');
    expect(result.success).toBe(false);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

// ─── updateClientField allowlist validation ──────────────────

describe('updateClientField', () => {
  it('rejects disallowed fields without hitting DB', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateClientField(mockSupabase, 'cl-1', 'id', 'new-value');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be updated');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('rejects protected fields like phase', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateClientField(mockSupabase, 'cl-1', 'phase', 'won');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be updated');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('rejects tasks field', async () => {
    const mockSupabase = { from: vi.fn() };
    const result = await updateClientField(mockSupabase, 'cl-1', 'tasks', '{}');
    expect(result.success).toBe(false);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
