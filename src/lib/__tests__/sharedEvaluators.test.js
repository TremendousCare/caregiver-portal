import { describe, it, expect } from 'vitest';
import {
  evaluatePhaseTime, evaluateTaskIncomplete, evaluateTaskStale,
  evaluateDateExpiring, evaluateTimeSinceCreation, evaluateLastNoteStale,
  evaluateSprintDeadline, EVALUATORS, URGENCY_ORDER, resolveTemplate,
  resolveUrgency, evaluateRulesForEntity,
} from '../../../supabase/functions/_shared/helpers/evaluators.ts';

const testAdapter = {
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

function makeEntity(overrides = {}) {
  return { id: 'test-1', firstName: 'Jane', lastName: 'Doe',
    _phase: 'intake', _daysInPhase: 0, _daysSinceCreation: 0, _minutesSinceCreation: 0,
    _tasks: {}, _phaseTimestamps: {}, _lastNoteDate: null, ...overrides };
}

describe('EVALUATORS registry', () => {
  it('has all 7 types', () => {
    const keys = Object.keys(EVALUATORS);
    expect(keys).toContain('phase_time');
    expect(keys).toContain('task_incomplete');
    expect(keys).toContain('task_stale');
    expect(keys).toContain('date_expiring');
    expect(keys).toContain('time_since_creation');
    expect(keys).toContain('last_note_stale');
    expect(keys).toContain('sprint_deadline');
    expect(keys).toHaveLength(7);
  });
});

describe('URGENCY_ORDER', () => {
  it('ranks critical < warning < info', () => {
    expect(URGENCY_ORDER.critical).toBeLessThan(URGENCY_ORDER.warning);
    expect(URGENCY_ORDER.warning).toBeLessThan(URGENCY_ORDER.info);
  });
});

describe('resolveTemplate', () => {
  it('replaces placeholders', () => {
    expect(resolveTemplate('Hello {{name}}', { name: 'Jane' })).toBe('Hello Jane');
  });
  it('leaves unknown placeholders intact', () => {
    expect(resolveTemplate('Hello {{name}}', {})).toBe('Hello {{name}}');
  });
  it('returns empty for null/undefined', () => {
    expect(resolveTemplate(null, {})).toBe('');
    expect(resolveTemplate(undefined, {})).toBe('');
  });
  it('handles multiple placeholders', () => {
    const tpl = '{{name}} has {{days_in_phase}} days in {{phase_name}}';
    const ctx = { name: 'Jane', days_in_phase: 5, phase_name: 'verification' };
    expect(resolveTemplate(tpl, ctx)).toBe('Jane has 5 days in verification');
  });
});

describe('evaluatePhaseTime', () => {
  it('matches target phase + threshold', () => {
    const e = makeEntity({ _phase: 'verification', _daysInPhase: 5 });
    const r = evaluatePhaseTime(e, { phase: 'verification', min_days: 3 }, testAdapter);
    expect(r.matches).toBe(true);
    expect(r.context.days_in_phase).toBe(5);
  });
  it('rejects wrong phase', () => {
    const e = makeEntity({ _phase: 'intake', _daysInPhase: 10 });
    expect(evaluatePhaseTime(e, { phase: 'verification', min_days: 1 }, testAdapter).matches).toBe(false);
  });
  it('_any_active with exclude_phases', () => {
    const e = makeEntity({ _phase: 'active_roster', _daysInPhase: 10 });
    expect(evaluatePhaseTime(e, { phase: '_any_active', exclude_phases: ['active_roster'], min_days: 1 }, testAdapter).matches).toBe(false);
    const e2 = makeEntity({ _phase: 'verification', _daysInPhase: 10 });
    expect(evaluatePhaseTime(e2, { phase: '_any_active', exclude_phases: ['active_roster'], min_days: 1 }, testAdapter).matches).toBe(true);
  });
});

describe('evaluateTaskIncomplete', () => {
  it('matches when task not done', () => {
    const e = makeEntity({ _phase: 'intake', _daysSinceCreation: 3 });
    expect(evaluateTaskIncomplete(e, { task_id: 'bg_check', min_days: 2 }, testAdapter).matches).toBe(true);
  });
  it('rejects when task done', () => {
    const e = makeEntity({ _tasks: { bg_check: true } });
    expect(evaluateTaskIncomplete(e, { task_id: 'bg_check' }, testAdapter).matches).toBe(false);
  });
});

describe('evaluateTimeSinceCreation', () => {
  it('matches with min_minutes', () => {
    const e = makeEntity({ _minutesSinceCreation: 45 });
    const r = evaluateTimeSinceCreation(e, { min_minutes: 30 }, testAdapter);
    expect(r.matches).toBe(true);
    expect(r.context.minutes_since_created).toBe(45);
  });
  it('matches with min_days', () => {
    const e = makeEntity({ _daysSinceCreation: 5 });
    expect(evaluateTimeSinceCreation(e, { min_days: 3 }, testAdapter).matches).toBe(true);
  });
  it('rejects when task_not_done is done', () => {
    const e = makeEntity({ _minutesSinceCreation: 60, _tasks: { welcome_sms: true } });
    expect(evaluateTimeSinceCreation(e, { min_minutes: 30, task_not_done: 'welcome_sms' }, testAdapter).matches).toBe(false);
  });
});

describe('evaluateLastNoteStale', () => {
  it('matches when no notes and days exceed threshold', () => {
    const e = makeEntity({ _daysSinceCreation: 10 });
    expect(evaluateLastNoteStale(e, { min_days: 7 }, testAdapter).matches).toBe(true);
  });
  it('rejects when recent note', () => {
    const e = makeEntity({ _lastNoteDate: Date.now() - 86400000 });
    expect(evaluateLastNoteStale(e, { min_days: 7 }, testAdapter).matches).toBe(false);
  });
});

describe('resolveUrgency', () => {
  it('returns base urgency', () => {
    expect(resolveUrgency({ urgency: 'info' }, makeEntity(), testAdapter)).toBe('info');
  });
  it('escalates when threshold met', () => {
    const rule = { urgency: 'info', urgency_escalation: { min_days: 5, urgency: 'warning' } };
    expect(resolveUrgency(rule, makeEntity({ _daysInPhase: 7 }), testAdapter)).toBe('warning');
  });
});

describe('evaluateRulesForEntity', () => {
  it('returns items for matching rules', () => {
    const rules = [{ id: 'r1', entity_type: 'caregiver', condition_type: 'phase_time',
      condition_config: { phase: 'intake', min_days: 1 }, urgency: 'warning',
      title_template: '{{name}} stuck in {{phase_name}}', detail_template: '{{days_in_phase}} days',
      action_template: 'Follow up' }];
    const e = makeEntity({ _phase: 'intake', _daysInPhase: 3 });
    const items = evaluateRulesForEntity(e, rules, testAdapter);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Jane Doe stuck in intake');
    expect(items[0].urgency).toBe('warning');
  });
  it('skips wrong entity_type', () => {
    const rules = [{ id: 'r1', entity_type: 'client', condition_type: 'phase_time',
      condition_config: { phase: 'intake', min_days: 0 }, urgency: 'info', title_template: 'test' }];
    expect(evaluateRulesForEntity(makeEntity(), rules, testAdapter)).toHaveLength(0);
  });
  it('skips terminal entities', () => {
    const ta = { ...testAdapter, isTerminalPhase: () => true };
    const rules = [{ id: 'r1', entity_type: 'caregiver', condition_type: 'phase_time',
      condition_config: { phase: 'intake', min_days: 0 }, urgency: 'info', title_template: 'test' }];
    expect(evaluateRulesForEntity(makeEntity(), rules, ta)).toHaveLength(0);
  });
});
