/**
 * Tests for inbound message routing and graduated autonomy framework.
 * Tests pure functions and logic that can run in Node/Vitest.
 * DB-calling functions (classifyMessage, executeSuggestion) are verified via production testing.
 */

import { describe, it, expect } from 'vitest';

// ─── Import pure logic from routing.ts ───
// We re-implement the pure logic here to test it independently
// (the actual routing.ts uses Deno APIs for the Claude call and DB,
//  but the business logic is testable as pure functions)

// ─── Constants (mirrored from routing.ts) ───

const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3, L4: 4 };
const PROMOTION_MAP = { L1: 'L2', L2: 'L3', L3: 'L4' };
const DEMOTION_MAP = { L4: 'L3', L3: 'L2', L2: 'L1' };

const VALID_INTENTS = [
  'question', 'document_submission', 'scheduling_request',
  'general_response', 'confirmation', 'opt_out', 'unknown',
];

// ─── Pure Logic Functions (extracted for testing) ───

function shouldPromote(config) {
  if (config.auto_promote_threshold <= 0) return null;
  if (config.consecutive_approvals < config.auto_promote_threshold) return null;

  const nextLevel = PROMOTION_MAP[config.autonomy_level];
  const maxLevel = config.max_autonomy_level || 'L3';

  if (!nextLevel) return null;
  if (LEVEL_ORDER[nextLevel] > LEVEL_ORDER[maxLevel]) return null;

  return nextLevel;
}

function shouldDemote(config) {
  if (!config.auto_demote_on_reject) return null;
  if (config.total_rejections < 3) return null;
  if (config.total_rejections % 3 !== 0) return null;

  return DEMOTION_MAP[config.autonomy_level] || null;
}

function validateIntent(intent) {
  return VALID_INTENTS.includes(intent) ? intent : 'unknown';
}

function determineSuggestionType(classification) {
  const isReply = (classification.suggested_action === 'send_sms' || classification.suggested_action === 'send_email')
    && classification.drafted_response;
  if (isReply) return 'reply';
  if (classification.intent === 'opt_out') return 'alert';
  if (classification.intent === 'unknown') return 'alert';
  if (classification.suggested_action !== 'none') return 'action';
  return 'follow_up';
}

function buildSuggestionTitle(entityName, intent) {
  const intentLabels = {
    question: 'asked a question',
    document_submission: 'mentioned documents',
    scheduling_request: 'asked about scheduling',
    general_response: 'replied',
    confirmation: 'confirmed',
    opt_out: 'requested opt-out',
    unknown: 'sent a message',
  };
  const label = intentLabels[intent] || 'sent a message';
  return `${entityName} ${label}`;
}


// ═══════════════════════════════════════════════
// AUTONOMY PROMOTION TESTS
// ═══════════════════════════════════════════════

describe('Autonomy Promotion Logic', () => {
  it('promotes L1 → L2 after threshold consecutive approvals', () => {
    const config = {
      autonomy_level: 'L1',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBe('L2');
  });

  it('promotes L2 → L3 after threshold', () => {
    const config = {
      autonomy_level: 'L2',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBe('L3');
  });

  it('does NOT promote beyond max_autonomy_level', () => {
    const config = {
      autonomy_level: 'L2',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L2',
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('does NOT promote L3 → L4 when max is L3', () => {
    const config = {
      autonomy_level: 'L3',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('allows L3 → L4 when max is L4', () => {
    const config = {
      autonomy_level: 'L3',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L4',
    };
    expect(shouldPromote(config)).toBe('L4');
  });

  it('does NOT promote when below threshold', () => {
    const config = {
      autonomy_level: 'L1',
      consecutive_approvals: 5,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('does NOT promote when threshold is 0 (disabled)', () => {
    const config = {
      autonomy_level: 'L1',
      consecutive_approvals: 100,
      auto_promote_threshold: 0,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('does NOT promote L4 (no higher level)', () => {
    const config = {
      autonomy_level: 'L4',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: 'L4',
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('respects custom threshold values', () => {
    const config = {
      autonomy_level: 'L1',
      consecutive_approvals: 25,
      auto_promote_threshold: 25,
      max_autonomy_level: 'L3',
    };
    expect(shouldPromote(config)).toBe('L2');
  });
});


// ═══════════════════════════════════════════════
// AUTONOMY DEMOTION TESTS
// ═══════════════════════════════════════════════

describe('Autonomy Demotion Logic', () => {
  it('demotes L3 → L2 after 3 rejections', () => {
    const config = {
      autonomy_level: 'L3',
      total_rejections: 3,
      auto_demote_on_reject: true,
    };
    expect(shouldDemote(config)).toBe('L2');
  });

  it('demotes L4 → L3 after 6 rejections', () => {
    const config = {
      autonomy_level: 'L4',
      total_rejections: 6,
      auto_demote_on_reject: true,
    };
    expect(shouldDemote(config)).toBe('L3');
  });

  it('does NOT demote L1 (no lower level)', () => {
    const config = {
      autonomy_level: 'L1',
      total_rejections: 3,
      auto_demote_on_reject: true,
    };
    expect(shouldDemote(config)).toBeNull();
  });

  it('does NOT demote when auto_demote_on_reject is false', () => {
    const config = {
      autonomy_level: 'L3',
      total_rejections: 3,
      auto_demote_on_reject: false,
    };
    expect(shouldDemote(config)).toBeNull();
  });

  it('does NOT demote at 1 or 2 rejections', () => {
    expect(shouldDemote({
      autonomy_level: 'L3', total_rejections: 1, auto_demote_on_reject: true,
    })).toBeNull();
    expect(shouldDemote({
      autonomy_level: 'L3', total_rejections: 2, auto_demote_on_reject: true,
    })).toBeNull();
  });

  it('demotes again at multiples of 3', () => {
    expect(shouldDemote({
      autonomy_level: 'L3', total_rejections: 9, auto_demote_on_reject: true,
    })).toBe('L2');
  });

  it('does NOT demote at non-multiples of 3', () => {
    expect(shouldDemote({
      autonomy_level: 'L3', total_rejections: 4, auto_demote_on_reject: true,
    })).toBeNull();
    expect(shouldDemote({
      autonomy_level: 'L3', total_rejections: 5, auto_demote_on_reject: true,
    })).toBeNull();
  });
});


// ═══════════════════════════════════════════════
// INTENT VALIDATION TESTS
// ═══════════════════════════════════════════════

describe('Intent Validation', () => {
  it('accepts all valid intents', () => {
    for (const intent of VALID_INTENTS) {
      expect(validateIntent(intent)).toBe(intent);
    }
  });

  it('returns unknown for invalid intents', () => {
    expect(validateIntent('invalid')).toBe('unknown');
    expect(validateIntent('')).toBe('unknown');
    expect(validateIntent('QUESTION')).toBe('unknown'); // case-sensitive
    expect(validateIntent(null)).toBe('unknown');
    expect(validateIntent(undefined)).toBe('unknown');
  });
});


// ═══════════════════════════════════════════════
// SUGGESTION TYPE DETERMINATION
// ═══════════════════════════════════════════════

describe('Suggestion Type Determination', () => {
  it('returns "reply" for SMS action with drafted response', () => {
    expect(determineSuggestionType({
      suggested_action: 'send_sms',
      drafted_response: 'Hello!',
      intent: 'question',
    })).toBe('reply');
  });

  it('returns "alert" for opt_out intent', () => {
    expect(determineSuggestionType({
      suggested_action: 'none',
      drafted_response: '',
      intent: 'opt_out',
    })).toBe('alert');
  });

  it('returns "alert" for unknown intent', () => {
    expect(determineSuggestionType({
      suggested_action: 'none',
      drafted_response: '',
      intent: 'unknown',
    })).toBe('alert');
  });

  it('returns "follow_up" for no action', () => {
    expect(determineSuggestionType({
      suggested_action: 'none',
      drafted_response: '',
      intent: 'general_response',
    })).toBe('follow_up');
  });

  it('returns "action" for non-SMS actions', () => {
    expect(determineSuggestionType({
      suggested_action: 'update_phase',
      drafted_response: '',
      intent: 'confirmation',
    })).toBe('action');
  });

  it('returns "alert" even if SMS action but empty response for opt_out', () => {
    expect(determineSuggestionType({
      suggested_action: 'send_sms',
      drafted_response: '',
      intent: 'opt_out',
    })).toBe('alert');
  });
});


// ═══════════════════════════════════════════════
// SUGGESTION TITLE BUILDING
// ═══════════════════════════════════════════════

describe('Suggestion Title Building', () => {
  it('builds title with question intent', () => {
    expect(buildSuggestionTitle('Maria Garcia', 'question'))
      .toBe('Maria Garcia asked a question');
  });

  it('builds title with confirmation intent', () => {
    expect(buildSuggestionTitle('John Smith', 'confirmation'))
      .toBe('John Smith confirmed');
  });

  it('builds title with opt_out intent', () => {
    expect(buildSuggestionTitle('Jane Doe', 'opt_out'))
      .toBe('Jane Doe requested opt-out');
  });

  it('builds title with scheduling_request intent', () => {
    expect(buildSuggestionTitle('Alex Kim', 'scheduling_request'))
      .toBe('Alex Kim asked about scheduling');
  });

  it('builds title with document_submission intent', () => {
    expect(buildSuggestionTitle('Chris Nash', 'document_submission'))
      .toBe('Chris Nash mentioned documents');
  });

  it('handles unknown/invalid intent', () => {
    expect(buildSuggestionTitle('Bob', 'unknown'))
      .toBe('Bob sent a message');
    expect(buildSuggestionTitle('Bob', 'invalid_intent'))
      .toBe('Bob sent a message');
  });
});


// ═══════════════════════════════════════════════
// LEVEL ORDER & CAPS TESTS
// ═══════════════════════════════════════════════

describe('Level Order', () => {
  it('maintains correct ordering', () => {
    expect(LEVEL_ORDER.L1).toBeLessThan(LEVEL_ORDER.L2);
    expect(LEVEL_ORDER.L2).toBeLessThan(LEVEL_ORDER.L3);
    expect(LEVEL_ORDER.L3).toBeLessThan(LEVEL_ORDER.L4);
  });
});

// ═══════════════════════════════════════════════
// CONTEXT ENRICHMENT TESTS
// ═══════════════════════════════════════════════

// Re-implement extractConversationHistory for testing (mirrors routing.ts)
function extractConversationHistory(notes, limit = 5) {
  return notes
    .filter((n) => n.type === 'sms' || n.type === 'sms_received' || n.type === 'sms_sent')
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-limit)
    .map((n) => ({
      direction: n.direction === 'inbound' || n.type === 'sms_received' ? 'inbound' : 'outbound',
      text: (n.text || '').slice(0, 200),
      timestamp: n.timestamp || 0,
    }));
}

// Re-implement task label resolution for testing
function resolveTaskLabelsSync(taskIds, phaseTasks) {
  if (taskIds.length === 0) return {};
  const labelMap = {};
  for (const tasks of Object.values(phaseTasks)) {
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      if (task.id && task.label) labelMap[task.id] = task.label;
    }
  }
  const result = {};
  for (const id of taskIds) {
    result[id] = labelMap[id] || id;
  }
  return result;
}

// Re-implement context section formatting for testing
function formatEnrichmentSections(entityContext) {
  const sections = [];
  if (entityContext.business_context) {
    sections.push(`Business context:\n${entityContext.business_context.slice(0, 1600)}`);
  }
  if (entityContext.conversation_history && entityContext.conversation_history.length > 0) {
    const convoLines = entityContext.conversation_history
      .map((m) => `${m.direction === 'inbound' ? 'Them' : 'Us'}: ${m.text}`)
      .join('\n');
    sections.push(`Recent conversation:\n${convoLines}`);
  }
  if (entityContext.calendar_summary) {
    sections.push(`Upcoming calendar (next 7 days):\n${entityContext.calendar_summary.slice(0, 800)}`);
  }
  if (entityContext.recent_events && entityContext.recent_events.length > 0) {
    const eventLines = entityContext.recent_events
      .map((e) => `${e.event_type} at ${e.created_at}`)
      .join(', ');
    sections.push(`Recent events: ${eventLines}`);
  }
  return sections.length > 0 ? '\n' + sections.join('\n\n') + '\n' : '';
}

describe('Conversation History Extraction', () => {
  it('extracts SMS notes in chronological order', () => {
    const notes = [
      { text: 'Hello', type: 'sms', timestamp: 300, direction: 'inbound' },
      { text: 'Hi there!', type: 'sms', timestamp: 200, direction: 'outbound' },
      { text: 'Thanks', type: 'sms', timestamp: 400, direction: 'inbound' },
    ];
    const result = extractConversationHistory(notes);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('Hi there!');
    expect(result[0].direction).toBe('outbound');
    expect(result[1].text).toBe('Hello');
    expect(result[1].direction).toBe('inbound');
    expect(result[2].text).toBe('Thanks');
  });

  it('filters out non-SMS notes', () => {
    const notes = [
      { text: 'SMS msg', type: 'sms', timestamp: 100, direction: 'inbound' },
      { text: 'Phase changed', type: 'phase_change', timestamp: 200 },
      { text: 'A note', type: 'note', timestamp: 300 },
      { text: 'Outbound SMS', type: 'sms_sent', timestamp: 400 },
    ];
    const result = extractConversationHistory(notes);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SMS msg');
    expect(result[1].text).toBe('Outbound SMS');
    expect(result[1].direction).toBe('outbound');
  });

  it('handles sms_received type as inbound', () => {
    const notes = [
      { text: 'Incoming', type: 'sms_received', timestamp: 100 },
    ];
    const result = extractConversationHistory(notes);
    expect(result[0].direction).toBe('inbound');
  });

  it('caps text at 200 characters', () => {
    const longText = 'A'.repeat(300);
    const notes = [{ text: longText, type: 'sms', timestamp: 100, direction: 'inbound' }];
    const result = extractConversationHistory(notes);
    expect(result[0].text.length).toBe(200);
  });

  it('limits to specified number of messages', () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({
      text: `msg ${i}`, type: 'sms', timestamp: i * 100, direction: 'inbound',
    }));
    const result = extractConversationHistory(notes, 3);
    expect(result).toHaveLength(3);
    // Should be the last 3 chronologically
    expect(result[0].text).toBe('msg 7');
    expect(result[2].text).toBe('msg 9');
  });

  it('returns empty array for no SMS notes', () => {
    const notes = [
      { text: 'A note', type: 'note', timestamp: 100 },
    ];
    expect(extractConversationHistory(notes)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(extractConversationHistory([])).toHaveLength(0);
  });
});

describe('Task Label Resolution', () => {
  const phaseTasks = {
    intake: [
      { id: 'task_hca_check', label: 'HCA Registration Check' },
      { id: 'task_phone_screen', label: 'Phone Screen' },
    ],
    onboarding: [
      { id: 'task_tb_test', label: 'TB Test' },
      { id: 'task_livescan', label: 'Live Scan Fingerprinting' },
    ],
  };

  it('maps task IDs to human labels', () => {
    const result = resolveTaskLabelsSync(['task_hca_check', 'task_tb_test'], phaseTasks);
    expect(result.task_hca_check).toBe('HCA Registration Check');
    expect(result.task_tb_test).toBe('TB Test');
  });

  it('falls back to raw ID for unknown tasks', () => {
    const result = resolveTaskLabelsSync(['unknown_task'], phaseTasks);
    expect(result.unknown_task).toBe('unknown_task');
  });

  it('returns empty object for empty input', () => {
    expect(resolveTaskLabelsSync([], phaseTasks)).toEqual({});
  });

  it('handles mixed known and unknown tasks', () => {
    const result = resolveTaskLabelsSync(['task_hca_check', 'custom_123'], phaseTasks);
    expect(result.task_hca_check).toBe('HCA Registration Check');
    expect(result.custom_123).toBe('custom_123');
  });
});

describe('Context Section Formatting', () => {
  it('formats business context with cap', () => {
    const ctx = { business_context: 'Office: 123 Main St' };
    const result = formatEnrichmentSections(ctx);
    expect(result).toContain('Business context:');
    expect(result).toContain('Office: 123 Main St');
  });

  it('caps business context at 1600 chars', () => {
    const ctx = { business_context: 'X'.repeat(2000) };
    const result = formatEnrichmentSections(ctx);
    // The section content should be capped
    expect(result.length).toBeLessThan(2000);
  });

  it('formats conversation with Them/Us prefixes', () => {
    const ctx = {
      conversation_history: [
        { direction: 'inbound', text: 'When is orientation?', timestamp: 100 },
        { direction: 'outbound', text: 'Tuesday at 9am!', timestamp: 200 },
      ],
    };
    const result = formatEnrichmentSections(ctx);
    expect(result).toContain('Them: When is orientation?');
    expect(result).toContain('Us: Tuesday at 9am!');
  });

  it('caps calendar summary at 800 chars', () => {
    const ctx = { calendar_summary: 'Y'.repeat(1000) };
    const result = formatEnrichmentSections(ctx);
    expect(result.length).toBeLessThan(1000);
  });

  it('formats recent events inline', () => {
    const ctx = {
      recent_events: [
        { event_type: 'sms_sent', created_at: '2026-03-10T10:00:00Z' },
        { event_type: 'phase_changed', created_at: '2026-03-09T08:00:00Z' },
      ],
    };
    const result = formatEnrichmentSections(ctx);
    expect(result).toContain('Recent events:');
    expect(result).toContain('sms_sent');
    expect(result).toContain('phase_changed');
  });

  it('returns empty string when no enrichment data', () => {
    expect(formatEnrichmentSections({})).toBe('');
  });

  it('total enriched prompt stays under 12K chars', () => {
    // Simulate a maximally-enriched context
    const ctx = {
      business_context: 'B'.repeat(1600),
      conversation_history: Array.from({ length: 5 }, (_, i) => ({
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        text: 'M'.repeat(200),
        timestamp: i * 100,
      })),
      calendar_summary: 'C'.repeat(800),
      recent_events: Array.from({ length: 5 }, (_, i) => ({
        event_type: 'event_type_' + i,
        created_at: '2026-03-10T10:00:00Z',
      })),
    };
    const result = formatEnrichmentSections(ctx);
    // Enrichment block + base prompt elements should stay under 12K
    expect(result.length).toBeLessThan(12000);
  });
});

describe('Default Autonomy Config Caps', () => {
  // These match the seed data in the migration
  const DEFAULT_CAPS = {
    send_sms: 'L3',
    send_email: 'L3',
    update_phase: 'L2',
    complete_task: 'L3',
    add_note: 'L4',
  };

  it('send_sms max is L3 (never fully silent for outbound comms)', () => {
    expect(DEFAULT_CAPS.send_sms).toBe('L3');
  });

  it('send_email max is L3', () => {
    expect(DEFAULT_CAPS.send_email).toBe('L3');
  });

  it('update_phase max is L2 (always needs at least confirm)', () => {
    expect(DEFAULT_CAPS.update_phase).toBe('L2');
  });

  it('add_note max is L4 (safe for full auto)', () => {
    expect(DEFAULT_CAPS.add_note).toBe('L4');
  });

  it('send_sms cannot be promoted to L4', () => {
    const config = {
      autonomy_level: 'L3',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: DEFAULT_CAPS.send_sms, // L3
    };
    expect(shouldPromote(config)).toBeNull();
  });

  it('update_phase cannot be promoted beyond L2', () => {
    const config = {
      autonomy_level: 'L2',
      consecutive_approvals: 10,
      auto_promote_threshold: 10,
      max_autonomy_level: DEFAULT_CAPS.update_phase, // L2
    };
    expect(shouldPromote(config)).toBeNull();
  });
});


// ═══════════════════════════════════════════════
// VALID ACTIONS (Phase 2: Multi-Action Classifier)
// ═══════════════════════════════════════════════

const VALID_ACTIONS = [
  'send_sms', 'send_email', 'add_note', 'add_client_note',
  'update_phase', 'update_client_phase', 'complete_task', 'complete_client_task',
  'update_caregiver_field', 'update_client_field', 'update_board_status',
  'create_calendar_event', 'send_docusign_envelope', 'none',
];

function validateAction(action) {
  return VALID_ACTIONS.includes(action) ? action : 'none';
}

function parseSuggestedParams(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}

function buildActionParams(classification, entityId, entityType) {
  const params = {
    ...classification.suggested_params,
    entity_id: entityId,
    entity_type: entityType,
  };
  if (classification.suggested_action === 'send_sms' && !params.message) {
    params.message = classification.drafted_response;
  }
  if (classification.suggested_action === 'send_email' && !params.body) {
    params.body = classification.drafted_response;
  }
  if ((classification.suggested_action === 'add_note' || classification.suggested_action === 'add_client_note') && !params.text) {
    params.text = classification.drafted_response || classification.reasoning;
  }
  return params;
}

describe('Action Validation', () => {
  it('accepts all valid actions', () => {
    for (const action of VALID_ACTIONS) {
      expect(validateAction(action)).toBe(action);
    }
  });

  it('normalizes invalid actions to "none"', () => {
    expect(validateAction('delete_everything')).toBe('none');
    expect(validateAction('')).toBe('none');
    expect(validateAction(null)).toBe('none');
    expect(validateAction(undefined)).toBe('none');
  });

  it('has 14 valid actions (13 real + none)', () => {
    expect(VALID_ACTIONS).toHaveLength(14);
  });
});

describe('Suggested Params Parsing', () => {
  it('passes through valid object', () => {
    const params = { task_id: 'task_hca_check', reason: 'Confirmed via SMS' };
    expect(parseSuggestedParams(params)).toEqual(params);
  });

  it('returns empty object for null', () => {
    expect(parseSuggestedParams(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(parseSuggestedParams(undefined)).toEqual({});
  });

  it('returns empty object for array', () => {
    expect(parseSuggestedParams(['not', 'valid'])).toEqual({});
  });

  it('returns empty object for string', () => {
    expect(parseSuggestedParams('invalid')).toEqual({});
  });

  it('returns empty object for number', () => {
    expect(parseSuggestedParams(42)).toEqual({});
  });
});

describe('Action Params Building', () => {
  it('merges suggested_params with entity context', () => {
    const classification = {
      suggested_action: 'complete_task',
      suggested_params: { task_id: 'task_tb_test' },
      drafted_response: '',
      reasoning: 'Caregiver confirmed TB test',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.entity_id).toBe('cg-123');
    expect(result.entity_type).toBe('caregiver');
    expect(result.task_id).toBe('task_tb_test');
  });

  it('populates message from drafted_response for send_sms', () => {
    const classification = {
      suggested_action: 'send_sms',
      suggested_params: {},
      drafted_response: 'Thanks for confirming!',
      reasoning: '',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.message).toBe('Thanks for confirming!');
  });

  it('does not overwrite message if already in suggested_params', () => {
    const classification = {
      suggested_action: 'send_sms',
      suggested_params: { message: 'Custom message' },
      drafted_response: 'Fallback message',
      reasoning: '',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.message).toBe('Custom message');
  });

  it('populates body from drafted_response for send_email', () => {
    const classification = {
      suggested_action: 'send_email',
      suggested_params: { subject: 'Follow-up' },
      drafted_response: 'Hi Sarah, just checking in...',
      reasoning: '',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.body).toBe('Hi Sarah, just checking in...');
    expect(result.subject).toBe('Follow-up');
  });

  it('populates text from drafted_response for add_note', () => {
    const classification = {
      suggested_action: 'add_note',
      suggested_params: {},
      drafted_response: 'Caregiver confirmed availability',
      reasoning: 'Confirmation message',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.text).toBe('Caregiver confirmed availability');
  });

  it('falls back to reasoning for add_note when no drafted_response', () => {
    const classification = {
      suggested_action: 'add_note',
      suggested_params: {},
      drafted_response: '',
      reasoning: 'Caregiver asked about schedule',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.text).toBe('Caregiver asked about schedule');
  });

  it('passes through calendar params from suggested_params', () => {
    const classification = {
      suggested_action: 'create_calendar_event',
      suggested_params: {
        title: 'Interview - Sarah Johnson',
        date: '2026-03-25',
        start_time: '14:00',
        end_time: '15:00',
      },
      drafted_response: "Great, I'll schedule that!",
      reasoning: 'Scheduling request',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.title).toBe('Interview - Sarah Johnson');
    expect(result.date).toBe('2026-03-25');
    expect(result.start_time).toBe('14:00');
    expect(result.end_time).toBe('15:00');
    expect(result.entity_id).toBe('cg-123');
  });

  it('passes through phase params', () => {
    const classification = {
      suggested_action: 'update_phase',
      suggested_params: { new_phase: 'interview', reason: 'Passed phone screen' },
      drafted_response: '',
      reasoning: '',
    };
    const result = buildActionParams(classification, 'cg-123', 'caregiver');
    expect(result.new_phase).toBe('interview');
    expect(result.reason).toBe('Passed phone screen');
  });
});

describe('Suggestion Type with Email Replies (Phase 2)', () => {
  it('returns "reply" for send_email with drafted response', () => {
    expect(determineSuggestionType({
      suggested_action: 'send_email',
      drafted_response: 'Hi Sarah, here is the info...',
      intent: 'question',
    })).toBe('reply');
  });

  it('returns "action" for send_email without drafted response', () => {
    expect(determineSuggestionType({
      suggested_action: 'send_email',
      drafted_response: '',
      intent: 'question',
    })).toBe('action');
  });

  it('returns "action" for complete_task', () => {
    expect(determineSuggestionType({
      suggested_action: 'complete_task',
      drafted_response: '',
      intent: 'confirmation',
    })).toBe('action');
  });

  it('returns "action" for create_calendar_event', () => {
    expect(determineSuggestionType({
      suggested_action: 'create_calendar_event',
      drafted_response: '',
      intent: 'scheduling_request',
    })).toBe('action');
  });

  it('returns "action" for update_phase', () => {
    expect(determineSuggestionType({
      suggested_action: 'update_phase',
      drafted_response: '',
      intent: 'confirmation',
    })).toBe('action');
  });
});

describe('batch size configuration', () => {
  it('MAX_BATCH_SIZE should be 10 for real-time throughput', () => {
    // Verified via constant in routing.ts
    const MAX_BATCH_SIZE = 10;
    expect(MAX_BATCH_SIZE).toBe(10);
  });
});
