import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_PHASE_TASKS } from '../constants';

// Mock storage (needed by utils.js)
vi.mock('../storage', () => ({
  getPhaseTasks: () => DEFAULT_PHASE_TASKS,
}));

// Mock supabase
vi.mock('../supabase', () => ({
  supabase: {},
  isSupabaseConfigured: () => false,
}));

// Mock client storage
vi.mock('../../features/clients/storage', () => ({
  getClientPhaseTasks: () => ({}),
}));

import {
  evaluatePhaseTime,
  evaluateTaskIncomplete,
  evaluateTaskStale,
  evaluateDateExpiring,
  evaluateTimeSinceCreation,
  evaluateLastNoteStale,
  evaluateSprintDeadline,
  resolveTemplate,
  evaluateRulesForEntity,
} from '../actionItemEngine';

// ─── Test Adapters (simplified for unit tests) ───────────────

const caregiverAdapter = {
  entityType: 'caregiver',
  getId: (e) => e.id,
  getName: (e) => `${e.firstName || ''} ${e.lastName || ''}`.trim(),
  getPhase: (e) => e._phase || 'intake',
  getDaysInPhase: (e) => e._daysInPhase || 0,
  getDaysSinceCreation: (e) => e._daysSinceCreation || 0,
  getMinutesSinceCreation: (e) => e._minutesSinceCreation || 0,
  isTaskDone: (e, taskId) => !!e._tasks?.[taskId],
  getDateField: (e, field) => e[field] || null,
  getPhaseTimestamp: (e, phase) => e._phaseTimestamps?.[phase] || null,
  getLastNoteDate: (e) => e._lastNoteDate || null,
  isTerminalPhase: () => false,
};

const clientAdapter = {
  ...caregiverAdapter,
  entityType: 'client',
  isTerminalPhase: (e) => e._phase === 'won' || e._phase === 'lost',
};

// ─── Helper ──────────────────────────────────────────────────

function makeEntity(overrides = {}) {
  return {
    id: 'test-1',
    firstName: 'Jane',
    lastName: 'Doe',
    _phase: 'intake',
    _daysInPhase: 0,
    _daysSinceCreation: 0,
    _minutesSinceCreation: 0,
    _tasks: {},
    _phaseTimestamps: {},
    _lastNoteDate: null,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════
// evaluatePhaseTime
// ═════════════════════════════════════════════════════════════

describe('evaluatePhaseTime', () => {
  it('matches when entity is in the target phase and meets threshold', () => {
    const entity = makeEntity({ _phase: 'verification', _daysInPhase: 5 });
    const result = evaluatePhaseTime(entity, { phase: 'verification', min_days: 3 }, caregiverAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.days_in_phase).toBe(5);
  });

  it('rejects when entity is in wrong phase', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 10 });
    const result = evaluatePhaseTime(entity, { phase: 'verification', min_days: 3 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when days below threshold', () => {
    const entity = makeEntity({ _phase: 'verification', _daysInPhase: 2 });
    const result = evaluatePhaseTime(entity, { phase: 'verification', min_days: 3 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('handles _any_active phase with exclusions', () => {
    const entity = makeEntity({ _phase: 'proposal', _daysInPhase: 15 });
    const config = { phase: '_any_active', min_days: 14, exclude_phases: ['won', 'lost', 'nurture'] };
    const result = evaluatePhaseTime(entity, config, clientAdapter);
    expect(result.matches).toBe(true);
  });

  it('rejects _any_active when in excluded phase', () => {
    const entity = makeEntity({ _phase: 'won', _daysInPhase: 15 });
    const config = { phase: '_any_active', min_days: 14, exclude_phases: ['won', 'lost', 'nurture'] };
    const result = evaluatePhaseTime(entity, config, clientAdapter);
    expect(result.matches).toBe(false);
  });

  it('matches at exact threshold', () => {
    const entity = makeEntity({ _phase: 'verification', _daysInPhase: 3 });
    const result = evaluatePhaseTime(entity, { phase: 'verification', min_days: 3 }, caregiverAdapter);
    expect(result.matches).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateTaskIncomplete
// ═════════════════════════════════════════════════════════════

describe('evaluateTaskIncomplete', () => {
  it('matches when task is not done and meets time threshold', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 5 });
    const result = evaluateTaskIncomplete(entity, { task_id: 'phone_screen', phase: 'intake', min_days: 4 }, caregiverAdapter);
    expect(result.matches).toBe(true);
  });

  it('rejects when task is done', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 5, _tasks: { phone_screen: true } });
    const result = evaluateTaskIncomplete(entity, { task_id: 'phone_screen', phase: 'intake', min_days: 4 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when wrong phase', () => {
    const entity = makeEntity({ _phase: 'onboarding', _daysInPhase: 5 });
    const result = evaluateTaskIncomplete(entity, { task_id: 'phone_screen', phase: 'intake', min_days: 4 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when below time threshold', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 2 });
    const result = evaluateTaskIncomplete(entity, { task_id: 'phone_screen', phase: 'intake', min_days: 4 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('matches with zero min_days', () => {
    const entity = makeEntity({ _phase: 'orientation', _daysInPhase: 0 });
    const result = evaluateTaskIncomplete(entity, { task_id: 'invite_sent', phase: 'orientation' }, caregiverAdapter);
    expect(result.matches).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateTaskStale
// ═════════════════════════════════════════════════════════════

describe('evaluateTaskStale', () => {
  it('matches when done task is complete but pending task is not and time elapsed', () => {
    const now = Date.now();
    const entity = makeEntity({
      _phase: 'interview',
      _tasks: { offer_letter_sent: true },
      _phaseTimestamps: { interview: now - 3 * 86400000 },
    });
    const config = { done_task_id: 'offer_letter_sent', pending_task_id: 'offer_hold', phase: 'interview', min_days: 2 };
    const result = evaluateTaskStale(entity, config, caregiverAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.days_in_phase).toBe(3);
  });

  it('rejects when done task is not complete', () => {
    const entity = makeEntity({ _phase: 'interview' });
    const config = { done_task_id: 'offer_letter_sent', pending_task_id: 'offer_hold', phase: 'interview', min_days: 2 };
    const result = evaluateTaskStale(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when pending task is already done', () => {
    const now = Date.now();
    const entity = makeEntity({
      _phase: 'interview',
      _tasks: { offer_letter_sent: true, offer_hold: true },
      _phaseTimestamps: { interview: now - 3 * 86400000 },
    });
    const config = { done_task_id: 'offer_letter_sent', pending_task_id: 'offer_hold', phase: 'interview', min_days: 2 };
    const result = evaluateTaskStale(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when time threshold not met', () => {
    const now = Date.now();
    const entity = makeEntity({
      _phase: 'interview',
      _tasks: { offer_letter_sent: true },
      _phaseTimestamps: { interview: now - 1 * 86400000 },
    });
    const config = { done_task_id: 'offer_letter_sent', pending_task_id: 'offer_hold', phase: 'interview', min_days: 2 };
    const result = evaluateTaskStale(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when no phase timestamp', () => {
    const entity = makeEntity({
      _phase: 'interview',
      _tasks: { offer_letter_sent: true },
    });
    const config = { done_task_id: 'offer_letter_sent', pending_task_id: 'offer_hold', phase: 'interview', min_days: 2 };
    const result = evaluateTaskStale(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateDateExpiring
// ═════════════════════════════════════════════════════════════

describe('evaluateDateExpiring', () => {
  it('matches expired date (days_until < 0)', () => {
    const pastDate = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];
    const entity = makeEntity({ hcaExpiration: pastDate });
    const result = evaluateDateExpiring(entity, { field: 'hcaExpiration', days_until: -1 }, caregiverAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.days_until_expiry).toBeGreaterThanOrEqual(9);
  });

  it('rejects non-expired date for expired-check rule', () => {
    const futureDate = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
    const entity = makeEntity({ hcaExpiration: futureDate });
    const result = evaluateDateExpiring(entity, { field: 'hcaExpiration', days_until: -1 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('matches date expiring within warning window', () => {
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
    const entity = makeEntity({ hcaExpiration: futureDate });
    const result = evaluateDateExpiring(entity, { field: 'hcaExpiration', days_warning: 30 }, caregiverAdapter);
    expect(result.matches).toBe(true);
  });

  it('rejects date outside warning window', () => {
    const futureDate = new Date(Date.now() + 120 * 86400000).toISOString().split('T')[0];
    const entity = makeEntity({ hcaExpiration: futureDate });
    const result = evaluateDateExpiring(entity, { field: 'hcaExpiration', days_warning: 90 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('excludes dates under exclusion threshold (e.g., 90-day rule excludes under 30)', () => {
    // 60 days out → should match the 90-day window but NOT be excluded (60 > 30)
    const futureDate60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    const entity60 = makeEntity({ hcaExpiration: futureDate60 });
    const result60 = evaluateDateExpiring(entity60, { field: 'hcaExpiration', days_warning: 90, days_exclude_under: 30 }, caregiverAdapter);
    expect(result60.matches).toBe(true);

    // 15 days out → should be excluded because 15 <= 30
    const futureDate15 = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
    const entity15 = makeEntity({ hcaExpiration: futureDate15 });
    const result15 = evaluateDateExpiring(entity15, { field: 'hcaExpiration', days_warning: 90, days_exclude_under: 30 }, caregiverAdapter);
    expect(result15.matches).toBe(false);
  });

  it('rejects when no date value', () => {
    const entity = makeEntity({});
    const result = evaluateDateExpiring(entity, { field: 'hcaExpiration', days_warning: 30 }, caregiverAdapter);
    expect(result.matches).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateTimeSinceCreation
// ═════════════════════════════════════════════════════════════

describe('evaluateTimeSinceCreation', () => {
  it('matches when minutes since creation exceeds threshold', () => {
    const entity = makeEntity({ _phase: 'new_lead', _minutesSinceCreation: 45 });
    const result = evaluateTimeSinceCreation(entity, { min_minutes: 30, phase: 'new_lead' }, clientAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.minutes_since_created).toBe(45);
  });

  it('rejects when minutes below threshold', () => {
    const entity = makeEntity({ _phase: 'new_lead', _minutesSinceCreation: 15 });
    const result = evaluateTimeSinceCreation(entity, { min_minutes: 30, phase: 'new_lead' }, clientAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when task_not_done is actually done', () => {
    const entity = makeEntity({
      _phase: 'new_lead',
      _minutesSinceCreation: 45,
      _tasks: { initial_call_attempted: true },
    });
    const config = { min_minutes: 30, phase: 'new_lead', task_not_done: 'initial_call_attempted' };
    const result = evaluateTimeSinceCreation(entity, config, clientAdapter);
    expect(result.matches).toBe(false);
  });

  it('matches with min_days instead of min_minutes', () => {
    const entity = makeEntity({ _daysSinceCreation: 5 });
    const result = evaluateTimeSinceCreation(entity, { min_days: 3 }, caregiverAdapter);
    expect(result.matches).toBe(true);
  });

  it('rejects when wrong phase', () => {
    const entity = makeEntity({ _phase: 'assessment', _minutesSinceCreation: 100 });
    const result = evaluateTimeSinceCreation(entity, { min_minutes: 30, phase: 'new_lead' }, clientAdapter);
    expect(result.matches).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateLastNoteStale
// ═════════════════════════════════════════════════════════════

describe('evaluateLastNoteStale', () => {
  it('matches when no notes and days since creation exceeds threshold', () => {
    const entity = makeEntity({ _phase: 'nurture', _daysSinceCreation: 35 });
    const result = evaluateLastNoteStale(entity, { min_days: 30, phase: 'nurture' }, clientAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.days_since_last_note).toBe(35);
  });

  it('matches when last note is old enough', () => {
    const entity = makeEntity({
      _phase: 'nurture',
      _lastNoteDate: Date.now() - 40 * 86400000,
    });
    const result = evaluateLastNoteStale(entity, { min_days: 30, phase: 'nurture' }, clientAdapter);
    expect(result.matches).toBe(true);
  });

  it('rejects when last note is recent', () => {
    const entity = makeEntity({
      _phase: 'nurture',
      _lastNoteDate: Date.now() - 5 * 86400000,
    });
    const result = evaluateLastNoteStale(entity, { min_days: 30, phase: 'nurture' }, clientAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when wrong phase', () => {
    const entity = makeEntity({ _phase: 'proposal', _daysSinceCreation: 35 });
    const result = evaluateLastNoteStale(entity, { min_days: 30, phase: 'nurture' }, clientAdapter);
    expect(result.matches).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateSprintDeadline
// ═════════════════════════════════════════════════════════════

describe('evaluateSprintDeadline', () => {
  it('matches when sprint day exceeds warning day', () => {
    const entity = makeEntity({
      _phase: 'onboarding',
      _phaseTimestamps: { onboarding: Date.now() - 4 * 86400000 },
    });
    const config = { phase: 'onboarding', warning_day: 3, critical_day: 5, expired_day: 7 };
    const result = evaluateSprintDeadline(entity, config, caregiverAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.sprint_day).toBe(4);
    expect(result.context.sprint_remaining).toBe(3);
  });

  it('rejects when sprint day below warning', () => {
    const entity = makeEntity({
      _phase: 'onboarding',
      _phaseTimestamps: { onboarding: Date.now() - 1 * 86400000 },
    });
    const config = { phase: 'onboarding', warning_day: 3, critical_day: 5, expired_day: 7 };
    const result = evaluateSprintDeadline(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('rejects when no phase timestamp', () => {
    const entity = makeEntity({ _phase: 'onboarding' });
    const config = { phase: 'onboarding', warning_day: 3, critical_day: 5, expired_day: 7 };
    const result = evaluateSprintDeadline(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });

  it('sprint_remaining bottoms out at 0', () => {
    const entity = makeEntity({
      _phase: 'onboarding',
      _phaseTimestamps: { onboarding: Date.now() - 10 * 86400000 },
    });
    const config = { phase: 'onboarding', warning_day: 7, critical_day: 7, expired_day: 7 };
    const result = evaluateSprintDeadline(entity, config, caregiverAdapter);
    expect(result.matches).toBe(true);
    expect(result.context.sprint_remaining).toBe(0);
  });

  it('rejects when wrong phase', () => {
    const entity = makeEntity({
      _phase: 'intake',
      _phaseTimestamps: { onboarding: Date.now() - 5 * 86400000 },
    });
    const config = { phase: 'onboarding', warning_day: 3 };
    const result = evaluateSprintDeadline(entity, config, caregiverAdapter);
    expect(result.matches).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// resolveTemplate
// ═════════════════════════════════════════════════════════════

describe('resolveTemplate', () => {
  it('replaces single merge field', () => {
    expect(resolveTemplate('Hello {{name}}', { name: 'Jane' })).toBe('Hello Jane');
  });

  it('replaces multiple merge fields', () => {
    const result = resolveTemplate('Day {{days_in_phase}} in {{phase_name}}', { days_in_phase: 5, phase_name: 'verification' });
    expect(result).toBe('Day 5 in verification');
  });

  it('leaves unknown fields as-is', () => {
    expect(resolveTemplate('Hello {{unknown_field}}', {})).toBe('Hello {{unknown_field}}');
  });

  it('handles empty template', () => {
    expect(resolveTemplate('', { name: 'Jane' })).toBe('');
  });

  it('handles null template', () => {
    expect(resolveTemplate(null, { name: 'Jane' })).toBe('');
  });

  it('converts numbers to strings', () => {
    expect(resolveTemplate('Day {{count}}', { count: 42 })).toBe('Day 42');
  });

  it('handles zero value', () => {
    expect(resolveTemplate('{{remaining}} days left', { remaining: 0 })).toBe('0 days left');
  });
});

// ═════════════════════════════════════════════════════════════
// evaluateRulesForEntity (integration)
// ═════════════════════════════════════════════════════════════

describe('evaluateRulesForEntity', () => {
  it('returns empty array when no rules match', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 0 });
    const rules = [{
      id: 'test', entity_type: 'caregiver', condition_type: 'phase_time',
      condition_config: { phase: 'verification', min_days: 3 },
      urgency: 'warning', icon: '✅',
      title_template: 'Test', detail_template: '', action_template: '',
    }];
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toEqual([]);
  });

  it('produces action item with resolved templates', () => {
    const entity = makeEntity({ _phase: 'verification', _daysInPhase: 5, firstName: 'Jane', lastName: 'Doe' });
    const rules = [{
      id: 'test_rule', entity_type: 'caregiver', condition_type: 'phase_time',
      condition_config: { phase: 'verification', min_days: 3 },
      urgency: 'warning', icon: '✅',
      title_template: 'Verification pending — Day {{days_in_phase}}',
      detail_template: 'Check items for {{name}}',
      action_template: 'Complete verification',
    }];
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Verification pending — Day 5');
    expect(result[0].detail).toBe('Check items for Jane Doe');
    expect(result[0].urgency).toBe('warning');
    expect(result[0].cgId).toBe('test-1');
  });

  it('applies urgency escalation', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 3, _daysSinceCreation: 3, firstName: 'Test', lastName: 'User' });
    const rules = [{
      id: 'test_esc', entity_type: 'caregiver', condition_type: 'task_incomplete',
      condition_config: { task_id: 'calendar_invite', phase: 'intake', min_days: 1 },
      urgency: 'warning',
      urgency_escalation: { min_days: 2, urgency: 'critical' },
      icon: '🕐', title_template: 'Interview not scheduled',
      detail_template: '', action_template: '',
    }];
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toHaveLength(1);
    expect(result[0].urgency).toBe('critical');
  });

  it('skips rules for wrong entity type', () => {
    const entity = makeEntity({ _phase: 'intake', _daysInPhase: 5 });
    const rules = [{
      id: 'client_rule', entity_type: 'client', condition_type: 'phase_time',
      condition_config: { phase: 'intake', min_days: 3 },
      urgency: 'warning', icon: '📋',
      title_template: 'Test', detail_template: '', action_template: '',
    }];
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toEqual([]);
  });

  it('skips terminal phases for clients', () => {
    const entity = makeEntity({ _phase: 'won', _daysInPhase: 30 });
    const rules = [{
      id: 'any_rule', entity_type: 'client', condition_type: 'phase_time',
      condition_config: { phase: '_any_active', min_days: 14, exclude_phases: [] },
      urgency: 'warning', icon: '📋',
      title_template: 'Stale', detail_template: '', action_template: '',
    }];
    const result = evaluateRulesForEntity(entity, rules, clientAdapter);
    expect(result).toEqual([]);
  });

  it('gracefully handles bad rule config without crashing', () => {
    const entity = makeEntity({ _phase: 'intake' });
    const rules = [{
      id: 'bad_rule', entity_type: 'caregiver', condition_type: 'unknown_type',
      condition_config: {}, urgency: 'warning', icon: '📋',
      title_template: 'Bad', detail_template: '', action_template: '',
    }];
    // Should not throw
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toEqual([]);
  });

  it('includes client compatibility fields', () => {
    const entity = makeEntity({ _phase: 'initial_contact', _daysInPhase: 5, firstName: 'Test', lastName: 'Client' });
    const rules = [{
      id: 'cl_no_contact', entity_type: 'client', condition_type: 'phase_time',
      condition_config: { phase: 'initial_contact', min_days: 2 },
      urgency: 'warning', icon: '📞',
      title_template: 'No contact', detail_template: 'Day {{days_in_phase}}',
      action_template: '',
    }];
    const result = evaluateRulesForEntity(entity, rules, clientAdapter);
    expect(result).toHaveLength(1);
    expect(result[0].clientId).toBe('test-1');
    expect(result[0].clientName).toBe('Test Client');
    expect(result[0].severity).toBe('warning');
    expect(result[0].phase).toBe('initial_contact');
    expect(result[0].type).toBe('cl_no_contact');
  });

  it('processes multiple rules for same entity', () => {
    const entity = makeEntity({
      _phase: 'intake', _daysInPhase: 5, _daysSinceCreation: 5,
      firstName: 'Multi', lastName: 'Rule',
    });
    const rules = [
      {
        id: 'rule_a', entity_type: 'caregiver', condition_type: 'task_incomplete',
        condition_config: { task_id: 'phone_screen', phase: 'intake', min_days: 4 },
        urgency: 'warning', icon: '📞',
        title_template: 'No phone screen', detail_template: '', action_template: '',
      },
      {
        id: 'rule_b', entity_type: 'caregiver', condition_type: 'task_incomplete',
        condition_config: { task_id: 'calendar_invite', phase: 'intake', min_days: 1 },
        urgency: 'warning', icon: '🕐',
        title_template: 'No interview', detail_template: '', action_template: '',
      },
    ];
    const result = evaluateRulesForEntity(entity, rules, caregiverAdapter);
    expect(result).toHaveLength(2);
  });
});
