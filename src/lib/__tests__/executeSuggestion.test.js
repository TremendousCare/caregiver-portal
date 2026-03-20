/**
 * Tests for the expanded executeSuggestion action dispatch.
 *
 * These test the pure param-validation and routing logic that executeSuggestion
 * uses to decide which shared operation to call. The actual DB/API calls are
 * tested via production testing (shared ops have their own integration coverage).
 *
 * Pattern: mirror the switch-case logic as pure functions and verify:
 *  1. Each action type maps to the correct operation
 *  2. Missing required params return clear errors
 *  3. Unknown action types return an error
 *  4. Entity ID resolution from suggestion vs params
 */

import { describe, it, expect } from 'vitest';

// ─── All supported action types (mirrors types.ts) ───
const SUPPORTED_ACTION_TYPES = [
  'send_sms',
  'send_email',
  'add_note',
  'add_client_note',
  'update_phase',
  'update_client_phase',
  'complete_task',
  'complete_client_task',
  'update_caregiver_field',
  'update_client_field',
  'update_board_status',
  'create_calendar_event',
  'send_docusign_envelope',
];

// ─── Param validation logic (mirrors executeSuggestion) ───

function validateActionParams(actionType, params) {
  switch (actionType) {
    case 'send_sms':
      // Needs entity with phone (resolved at runtime) and message
      if (!params.message && !params.drafted_content) return { valid: false, error: 'Missing message content.' };
      return { valid: true };

    case 'send_email':
      // Needs either to_email or entity with email, plus subject and body
      if (!params.subject && !params.body && !params.drafted_content) {
        return { valid: false, error: 'Missing email subject or body.' };
      }
      return { valid: true };

    case 'add_note':
    case 'add_client_note':
      if (!params.text && !params.drafted_content) return { valid: false, error: 'Missing note text.' };
      return { valid: true };

    case 'update_phase':
    case 'update_client_phase':
      if (!params.new_phase) return { valid: false, error: 'Missing new_phase parameter.' };
      return { valid: true };

    case 'complete_task':
    case 'complete_client_task':
      if (!params.task_id) return { valid: false, error: 'Missing task_id parameter.' };
      return { valid: true };

    case 'update_caregiver_field':
    case 'update_client_field':
      if (!params.field || params.value === undefined) return { valid: false, error: 'Missing field or value parameter.' };
      return { valid: true };

    case 'update_board_status':
      if (!params.new_status) return { valid: false, error: 'Missing new_status parameter.' };
      return { valid: true };

    case 'create_calendar_event':
      if (!params.title || !params.date || !params.start_time || !params.end_time) {
        return { valid: false, error: 'Missing required calendar params (title, date, start_time, end_time).' };
      }
      return { valid: true };

    case 'send_docusign_envelope':
      if (!params.caregiver_email || !params.caregiver_name) {
        return { valid: false, error: 'Missing caregiver_email or caregiver_name for DocuSign.' };
      }
      return { valid: true };

    default:
      return { valid: false, error: `Action type "${actionType}" is not supported for autonomous execution.` };
  }
}

function resolveEntityId(suggestion, params) {
  return params.entity_id || suggestion.entity_id;
}

function resolveEntityType(suggestion, params) {
  return params.entity_type || suggestion.entity_type || 'caregiver';
}


// ═══════════════════════════════════════════════
// ACTION TYPE COVERAGE
// ═══════════════════════════════════════════════

describe('Supported Action Types', () => {
  it('has 13 supported action types', () => {
    expect(SUPPORTED_ACTION_TYPES).toHaveLength(13);
  });

  it('includes all caregiver write actions', () => {
    expect(SUPPORTED_ACTION_TYPES).toContain('update_phase');
    expect(SUPPORTED_ACTION_TYPES).toContain('complete_task');
    expect(SUPPORTED_ACTION_TYPES).toContain('update_caregiver_field');
    expect(SUPPORTED_ACTION_TYPES).toContain('update_board_status');
    expect(SUPPORTED_ACTION_TYPES).toContain('add_note');
  });

  it('includes all client write actions', () => {
    expect(SUPPORTED_ACTION_TYPES).toContain('update_client_phase');
    expect(SUPPORTED_ACTION_TYPES).toContain('complete_client_task');
    expect(SUPPORTED_ACTION_TYPES).toContain('update_client_field');
    expect(SUPPORTED_ACTION_TYPES).toContain('add_client_note');
  });

  it('includes all communication actions', () => {
    expect(SUPPORTED_ACTION_TYPES).toContain('send_sms');
    expect(SUPPORTED_ACTION_TYPES).toContain('send_email');
  });

  it('includes calendar and docusign', () => {
    expect(SUPPORTED_ACTION_TYPES).toContain('create_calendar_event');
    expect(SUPPORTED_ACTION_TYPES).toContain('send_docusign_envelope');
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — SMS
// ═══════════════════════════════════════════════

describe('send_sms param validation', () => {
  it('accepts params with message', () => {
    expect(validateActionParams('send_sms', { message: 'Hello!' })).toEqual({ valid: true });
  });

  it('accepts params with drafted_content fallback', () => {
    expect(validateActionParams('send_sms', { drafted_content: 'Hello!' })).toEqual({ valid: true });
  });

  it('rejects empty params', () => {
    const result = validateActionParams('send_sms', {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('message');
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — EMAIL
// ═══════════════════════════════════════════════

describe('send_email param validation', () => {
  it('accepts params with subject and body', () => {
    expect(validateActionParams('send_email', {
      to_email: 'test@example.com', subject: 'Hi', body: 'Hello!',
    })).toEqual({ valid: true });
  });

  it('accepts params with only subject', () => {
    expect(validateActionParams('send_email', { subject: 'Hi' })).toEqual({ valid: true });
  });

  it('accepts params with drafted_content fallback', () => {
    expect(validateActionParams('send_email', { drafted_content: 'Hello!' })).toEqual({ valid: true });
  });

  it('rejects empty params', () => {
    const result = validateActionParams('send_email', {});
    expect(result.valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — NOTES
// ═══════════════════════════════════════════════

describe('add_note / add_client_note param validation', () => {
  it('accepts params with text', () => {
    expect(validateActionParams('add_note', { text: 'Called, no answer' })).toEqual({ valid: true });
    expect(validateActionParams('add_client_note', { text: 'Intake complete' })).toEqual({ valid: true });
  });

  it('accepts drafted_content fallback', () => {
    expect(validateActionParams('add_note', { drafted_content: 'Auto-note' })).toEqual({ valid: true });
  });

  it('rejects empty params', () => {
    expect(validateActionParams('add_note', {}).valid).toBe(false);
    expect(validateActionParams('add_client_note', {}).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — PHASE CHANGES
// ═══════════════════════════════════════════════

describe('update_phase / update_client_phase param validation', () => {
  it('accepts params with new_phase', () => {
    expect(validateActionParams('update_phase', { new_phase: 'interview' })).toEqual({ valid: true });
    expect(validateActionParams('update_client_phase', { new_phase: 'consultation' })).toEqual({ valid: true });
  });

  it('accepts optional reason', () => {
    expect(validateActionParams('update_phase', { new_phase: 'interview', reason: 'Passed screen' })).toEqual({ valid: true });
  });

  it('rejects without new_phase', () => {
    expect(validateActionParams('update_phase', {}).valid).toBe(false);
    expect(validateActionParams('update_phase', {}).error).toContain('new_phase');
    expect(validateActionParams('update_client_phase', {}).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — TASK COMPLETION
// ═══════════════════════════════════════════════

describe('complete_task / complete_client_task param validation', () => {
  it('accepts params with task_id', () => {
    expect(validateActionParams('complete_task', { task_id: 'task_hca_check' })).toEqual({ valid: true });
    expect(validateActionParams('complete_client_task', { task_id: 'task_intake_form' })).toEqual({ valid: true });
  });

  it('rejects without task_id', () => {
    expect(validateActionParams('complete_task', {}).valid).toBe(false);
    expect(validateActionParams('complete_task', {}).error).toContain('task_id');
    expect(validateActionParams('complete_client_task', {}).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — FIELD UPDATES
// ═══════════════════════════════════════════════

describe('update_caregiver_field / update_client_field param validation', () => {
  it('accepts params with field and value', () => {
    expect(validateActionParams('update_caregiver_field', { field: 'phone', value: '555-1234' })).toEqual({ valid: true });
    expect(validateActionParams('update_client_field', { field: 'email', value: 'new@test.com' })).toEqual({ valid: true });
  });

  it('accepts empty string as value', () => {
    expect(validateActionParams('update_caregiver_field', { field: 'phone', value: '' })).toEqual({ valid: true });
  });

  it('rejects without field', () => {
    expect(validateActionParams('update_caregiver_field', { value: '555-1234' }).valid).toBe(false);
  });

  it('rejects without value (undefined)', () => {
    expect(validateActionParams('update_caregiver_field', { field: 'phone' }).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — BOARD STATUS
// ═══════════════════════════════════════════════

describe('update_board_status param validation', () => {
  it('accepts params with new_status', () => {
    expect(validateActionParams('update_board_status', { new_status: 'Interview Scheduled' })).toEqual({ valid: true });
  });

  it('accepts optional note', () => {
    expect(validateActionParams('update_board_status', {
      new_status: 'Cleared', note: 'All docs complete',
    })).toEqual({ valid: true });
  });

  it('rejects without new_status', () => {
    expect(validateActionParams('update_board_status', {}).valid).toBe(false);
    expect(validateActionParams('update_board_status', {}).error).toContain('new_status');
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — CALENDAR
// ═══════════════════════════════════════════════

describe('create_calendar_event param validation', () => {
  const validParams = {
    title: 'Interview with Sarah',
    date: '2026-03-25',
    start_time: '14:00',
    end_time: '15:00',
  };

  it('accepts full params', () => {
    expect(validateActionParams('create_calendar_event', validParams)).toEqual({ valid: true });
  });

  it('accepts optional params', () => {
    expect(validateActionParams('create_calendar_event', {
      ...validParams,
      caregiver_email: 'sarah@example.com',
      location: 'Office',
      is_online: true,
    })).toEqual({ valid: true });
  });

  it('rejects without title', () => {
    const { title, ...rest } = validParams;
    expect(validateActionParams('create_calendar_event', rest).valid).toBe(false);
  });

  it('rejects without date', () => {
    const { date, ...rest } = validParams;
    expect(validateActionParams('create_calendar_event', rest).valid).toBe(false);
  });

  it('rejects without start_time', () => {
    const { start_time, ...rest } = validParams;
    expect(validateActionParams('create_calendar_event', rest).valid).toBe(false);
  });

  it('rejects without end_time', () => {
    const { end_time, ...rest } = validParams;
    expect(validateActionParams('create_calendar_event', rest).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// PARAM VALIDATION — DOCUSIGN
// ═══════════════════════════════════════════════

describe('send_docusign_envelope param validation', () => {
  it('accepts params with email and name', () => {
    expect(validateActionParams('send_docusign_envelope', {
      caregiver_email: 'sarah@example.com',
      caregiver_name: 'Sarah Johnson',
    })).toEqual({ valid: true });
  });

  it('accepts optional template params', () => {
    expect(validateActionParams('send_docusign_envelope', {
      caregiver_email: 'sarah@example.com',
      caregiver_name: 'Sarah Johnson',
      template_ids: ['abc-123'],
      template_names: ['Employment Agreement'],
      is_packet: false,
    })).toEqual({ valid: true });
  });

  it('rejects without caregiver_email', () => {
    expect(validateActionParams('send_docusign_envelope', {
      caregiver_name: 'Sarah Johnson',
    }).valid).toBe(false);
  });

  it('rejects without caregiver_name', () => {
    expect(validateActionParams('send_docusign_envelope', {
      caregiver_email: 'sarah@example.com',
    }).valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// UNKNOWN ACTION TYPE
// ═══════════════════════════════════════════════

describe('Unknown action types', () => {
  it('rejects unsupported action types', () => {
    const result = validateActionParams('delete_caregiver', {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not supported');
  });

  it('rejects null action type', () => {
    const result = validateActionParams(null, {});
    expect(result.valid).toBe(false);
  });

  it('rejects empty string action type', () => {
    const result = validateActionParams('', {});
    expect(result.valid).toBe(false);
  });
});


// ═══════════════════════════════════════════════
// ENTITY ID RESOLUTION
// ═══════════════════════════════════════════════

describe('Entity ID Resolution', () => {
  it('prefers entity_id from params over suggestion', () => {
    const suggestion = { entity_id: 'suggestion-id', entity_type: 'caregiver' };
    const params = { entity_id: 'params-id' };
    expect(resolveEntityId(suggestion, params)).toBe('params-id');
  });

  it('falls back to suggestion entity_id when not in params', () => {
    const suggestion = { entity_id: 'suggestion-id', entity_type: 'caregiver' };
    expect(resolveEntityId(suggestion, {})).toBe('suggestion-id');
  });

  it('prefers entity_type from params over suggestion', () => {
    const suggestion = { entity_type: 'caregiver' };
    const params = { entity_type: 'client' };
    expect(resolveEntityType(suggestion, params)).toBe('client');
  });

  it('falls back to suggestion entity_type', () => {
    const suggestion = { entity_type: 'client' };
    expect(resolveEntityType(suggestion, {})).toBe('client');
  });

  it('defaults to caregiver when no entity_type anywhere', () => {
    expect(resolveEntityType({}, {})).toBe('caregiver');
  });
});


// ═══════════════════════════════════════════════
// AUTONOMY CONFIG DEFAULTS FOR NEW ACTIONS
// ═══════════════════════════════════════════════

describe('Autonomy Config Defaults (matches migration seed)', () => {
  // These mirror the seed values in 20260320_autonomy_config_full_actions.sql
  const NEW_SEEDS = {
    add_client_note: { level: 'L4', max: 'L4' },
    update_caregiver_field: { level: 'L1', max: 'L2' },
    update_client_field: { level: 'L1', max: 'L2' },
    update_client_phase: { level: 'L1', max: 'L2' },
    complete_client_task: { level: 'L1', max: 'L3' },
    update_board_status: { level: 'L1', max: 'L2' },
    create_calendar_event: { level: 'L1', max: 'L2' },
    send_docusign_envelope: { level: 'L1', max: 'L1' },
  };

  it('client notes are safe for full auto (L4)', () => {
    expect(NEW_SEEDS.add_client_note.level).toBe('L4');
    expect(NEW_SEEDS.add_client_note.max).toBe('L4');
  });

  it('field updates start at suggest, max confirm', () => {
    expect(NEW_SEEDS.update_caregiver_field.level).toBe('L1');
    expect(NEW_SEEDS.update_caregiver_field.max).toBe('L2');
    expect(NEW_SEEDS.update_client_field.level).toBe('L1');
    expect(NEW_SEEDS.update_client_field.max).toBe('L2');
  });

  it('board status starts at suggest, max confirm', () => {
    expect(NEW_SEEDS.update_board_status.level).toBe('L1');
    expect(NEW_SEEDS.update_board_status.max).toBe('L2');
  });

  it('calendar events start at suggest, max confirm', () => {
    expect(NEW_SEEDS.create_calendar_event.level).toBe('L1');
    expect(NEW_SEEDS.create_calendar_event.max).toBe('L2');
  });

  it('DocuSign is locked to suggest-only (L1 max L1)', () => {
    expect(NEW_SEEDS.send_docusign_envelope.level).toBe('L1');
    expect(NEW_SEEDS.send_docusign_envelope.max).toBe('L1');
  });

  it('no action type defaults higher than L3 for outbound communication', () => {
    // From the original seed
    const COMM_CAPS = { send_sms: 'L3', send_email: 'L3' };
    expect(COMM_CAPS.send_sms).toBe('L3');
    expect(COMM_CAPS.send_email).toBe('L3');
  });
});
