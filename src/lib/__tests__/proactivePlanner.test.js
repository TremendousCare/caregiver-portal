import { describe, it, expect } from 'vitest';
import {
  inferPhase,
  calculateDaysInPhase,
  getLastContact,
  getTaskProgress,
  evaluateAlerts,
  getRecentOutcomes,
  parsePlannerResponse,
  formatPipelineSummaryForPrompt,
  formatSingleEntityPrompt,
} from '../plannerHelpers';

const NOW = new Date('2026-03-21T12:00:00Z').getTime();

describe('Proactive Planner', () => {
  describe('inferPhase', () => {
    it('returns the most advanced phase from timestamps', () => {
      expect(inferPhase({ intake: '2026-01-01', interview: '2026-01-05' })).toBe('Interview');
    });

    it('returns null for null/undefined timestamps', () => {
      expect(inferPhase(null)).toBeNull();
      expect(inferPhase(undefined)).toBeNull();
    });

    it('handles active_roster key correctly', () => {
      expect(inferPhase({ intake: '2026-01-01', active_roster: '2026-03-01' })).toBe('Active Roster');
    });

    it('returns Intake for single phase', () => {
      expect(inferPhase({ intake: '2026-03-01' })).toBe('Intake');
    });
  });

  describe('calculateDaysInPhase', () => {
    it('calculates days correctly', () => {
      const ts = { interview: '2026-03-18T12:00:00Z' };
      expect(calculateDaysInPhase(ts, 'Interview', NOW)).toBe(3);
    });

    it('returns 0 for missing phase key', () => {
      expect(calculateDaysInPhase({ intake: '2026-03-01' }, 'Onboarding', NOW)).toBe(0);
    });

    it('returns 0 for null timestamps', () => {
      expect(calculateDaysInPhase(null, 'Intake', NOW)).toBe(0);
    });
  });

  describe('getLastContact', () => {
    it('uses most recent note timestamp', () => {
      const notes = [
        { text: 'old', timestamp: '2026-03-10T12:00:00Z', type: 'sms' },
        { text: 'recent', timestamp: '2026-03-19T12:00:00Z', type: 'email' },
      ];
      const result = getLastContact(notes, '2026-01-01', NOW);
      expect(result.daysSince).toBe(2);
      expect(result.channel).toBe('email');
    });

    it('falls back to created_at if no notes', () => {
      const result = getLastContact([], '2026-03-14T12:00:00Z', NOW);
      expect(result.daysSince).toBe(7);
      expect(result.channel).toBeNull();
    });

    it('skips string notes', () => {
      const result = getLastContact(['old string note'], '2026-03-20T12:00:00Z', NOW);
      expect(result.daysSince).toBe(1);
    });
  });

  describe('getTaskProgress', () => {
    it('counts completed and incomplete tasks', () => {
      const tasks = {
        task_phone_screen: { completed: true, completedAt: '2026-03-01' },
        task_tb_test: { completed: false },
        task_i9: { completed: false },
      };
      const result = getTaskProgress(tasks);
      expect(result.total).toBe(3);
      expect(result.completed).toBe(1);
      expect(result.incomplete).toEqual(['tb test', 'i9']);
    });

    it('returns zeros for null tasks', () => {
      const result = getTaskProgress(null);
      expect(result.total).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.incomplete).toEqual([]);
    });
  });

  describe('evaluateAlerts', () => {
    const rules = [
      { name: 'HCA Missing', entity_type: 'caregiver', condition_type: 'task_missing', condition_config: { task_id: 'task_hca' }, enabled: true },
      { name: 'Verification Pending', entity_type: 'caregiver', condition_type: 'phase_time', condition_config: { days: 5 }, enabled: true },
      { name: 'Disabled Rule', entity_type: 'caregiver', condition_type: 'task_missing', condition_config: { task_id: 'task_i9' }, enabled: false },
      { name: 'Client Rule', entity_type: 'client', condition_type: 'task_missing', condition_config: { task_id: 'task_intake' }, enabled: true },
    ];

    it('triggers task_missing alert when task incomplete', () => {
      const entity = { tasks: { task_hca: { completed: false } }, phase_override: 'Verification', phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).toContain('HCA Missing');
    });

    it('does not trigger task_missing when task is complete', () => {
      const entity = { tasks: { task_hca: { completed: true } }, phase_override: 'Verification', phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('HCA Missing');
    });

    it('skips disabled rules', () => {
      const entity = { tasks: { task_i9: { completed: false } }, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('Disabled Rule');
    });

    it('only evaluates rules for matching entity type', () => {
      const entity = { tasks: { task_intake: { completed: false } }, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).not.toContain('Client Rule');
    });

    it('triggers phase_time alert when over threshold', () => {
      const entity = {
        tasks: {},
        phase_override: 'Verification',
        phase_timestamps: { verification: '2026-03-10T12:00:00Z' },
      };
      const alerts = evaluateAlerts(entity, rules, 'caregiver', NOW);
      expect(alerts).toContain('Verification Pending');
    });

    it('evaluates date_expiry rule', () => {
      const dateRules = [
        { name: 'HCA Expiring', entity_type: 'caregiver', condition_type: 'date_expiry', condition_config: { date_field: 'hca_expiration', warn_days: 30 }, enabled: true },
      ];
      const entity = { hca_expiration: '2026-04-10T00:00:00Z', tasks: {}, phase_timestamps: {} };
      const alerts = evaluateAlerts(entity, dateRules, 'caregiver', NOW);
      expect(alerts).toContain('HCA Expiring');
    });
  });

  describe('getRecentOutcomes', () => {
    it('returns formatted outcomes for entity', () => {
      const outcomes = [
        { entity_id: 'cg1', action_type: 'sms_sent', outcome_type: 'response_received' },
        { entity_id: 'cg1', action_type: 'email_sent', outcome_type: 'no_response' },
        { entity_id: 'cg2', action_type: 'sms_sent', outcome_type: 'pending' },
      ];
      const result = getRecentOutcomes('cg1', outcomes);
      expect(result).toEqual(['sms sent: response_received', 'email sent: no_response']);
    });

    it('returns empty array for unknown entity', () => {
      expect(getRecentOutcomes('unknown', [])).toEqual([]);
    });

    it('caps at 3 outcomes', () => {
      const outcomes = Array.from({ length: 5 }, (_, i) => ({
        entity_id: 'cg1', action_type: 'sms_sent', outcome_type: `outcome_${i}`,
      }));
      expect(getRecentOutcomes('cg1', outcomes).length).toBe(3);
    });
  });

  describe('parsePlannerResponse', () => {
    it('parses valid JSON array', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', entity_type: 'caregiver', entity_name: 'John Doe',
        action_type: 'send_sms', priority: 'high', title: 'Follow up with John',
        detail: 'No response in 4 days', drafted_content: 'Hi John, checking in!',
        action_params: { message: 'Hi John, checking in!' },
      }]);
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
      expect(result[0].entity_id).toBe('cg1');
      expect(result[0].action_type).toBe('send_sms');
      expect(result[0].priority).toBe('high');
    });

    it('handles markdown-wrapped JSON', () => {
      const response = '```json\n[{"entity_id":"cg1","action_type":"send_sms","title":"Test"}]\n```';
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
    });

    it('filters invalid action types', () => {
      const response = JSON.stringify([
        { entity_id: 'cg1', action_type: 'delete_everything', title: 'Bad' },
        { entity_id: 'cg2', action_type: 'send_sms', title: 'Good' },
      ]);
      const result = parsePlannerResponse(response);
      expect(result.length).toBe(1);
      expect(result[0].action_type).toBe('send_sms');
    });

    it('filters items missing required fields', () => {
      const response = JSON.stringify([
        { entity_id: 'cg1', action_type: 'send_sms' }, // missing title
        { action_type: 'send_sms', title: 'Test' }, // missing entity_id
      ]);
      expect(parsePlannerResponse(response).length).toBe(0);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parsePlannerResponse('not json')).toEqual([]);
      expect(parsePlannerResponse('')).toEqual([]);
    });

    it('defaults priority to medium if invalid', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', action_type: 'send_sms', title: 'Test', priority: 'urgent',
      }]);
      expect(parsePlannerResponse(response)[0].priority).toBe('medium');
    });

    it('truncates long titles and details', () => {
      const response = JSON.stringify([{
        entity_id: 'cg1', action_type: 'send_sms',
        title: 'A'.repeat(300), detail: 'B'.repeat(600),
      }]);
      const result = parsePlannerResponse(response);
      expect(result[0].title.length).toBe(200);
      expect(result[0].detail.length).toBe(500);
    });
  });

  describe('formatPipelineSummaryForPrompt', () => {
    it('formats entities into compact lines', () => {
      const entities = [{
        id: 'cg1', name: 'John Doe', entity_type: 'caregiver', phase: 'Interview',
        days_in_phase: 5, days_since_contact: 3, last_contact_channel: 'sms',
        incomplete_tasks: ['tb test', 'i9'], total_tasks: 5, completed_tasks: 3,
        has_phone: true, has_email: true, active_alerts: ['24-Hour Interview Standard'],
        recent_outcomes: ['sms sent: response_received'], board_status: null,
      }];
      const result = formatPipelineSummaryForPrompt(entities);
      expect(result).toContain('[cg1]');
      expect(result).toContain('John Doe');
      expect(result).toContain('5d in phase');
      expect(result).toContain('3d ago via sms');
      expect(result).toContain('ALERTS: 24-Hour Interview Standard');
    });

    it('flags entities with no phone', () => {
      const entities = [{
        id: 'cg2', name: 'Jane', entity_type: 'caregiver', phase: 'Intake',
        days_in_phase: 1, days_since_contact: 0, last_contact_channel: null,
        incomplete_tasks: [], total_tasks: 0, completed_tasks: 0,
        has_phone: false, has_email: true, active_alerts: [], recent_outcomes: [],
        board_status: null,
      }];
      expect(formatPipelineSummaryForPrompt(entities)).toContain('NO PHONE');
    });

    it('returns message for empty pipeline', () => {
      expect(formatPipelineSummaryForPrompt([])).toBe('No active entities in pipeline.');
    });
  });

  describe('formatSingleEntityPrompt', () => {
    const baseContext = {
      id: 'cg_123',
      first_name: 'Maria',
      last_name: 'Garcia',
      phone: '555-1234',
      email: 'maria@example.com',
      entity_type: 'caregiver',
      phase: 'Onboarding',
      recent_notes: [
        { text: 'Sent welcome SMS', type: 'sms_sent', timestamp: NOW - 86400000, author: 'system' },
      ],
      incomplete_tasks: ['task_tb_test', 'task_i9_form'],
      task_labels: { task_tb_test: 'TB Test', task_i9_form: 'I-9 Form' },
    };

    const baseEntityData = {
      phase_timestamps: { intake: '2026-03-10', onboarding: '2026-03-18' },
      tasks: { task_tb_test: { completed: false }, task_i9_form: { completed: false } },
    };

    it('includes trigger reason prominently', () => {
      const result = formatSingleEntityPrompt(baseContext, 'DocuSign completed', [], [], baseEntityData);
      expect(result).toContain('## Trigger Event');
      expect(result).toContain('DocuSign completed');
    });

    it('includes entity name, phase, and contact info', () => {
      const result = formatSingleEntityPrompt(baseContext, 'test', [], [], baseEntityData);
      expect(result).toContain('Maria Garcia');
      expect(result).toContain('Onboarding');
      expect(result).toContain('555-1234');
      expect(result).toContain('maria@example.com');
    });

    it('includes days in phase calculated from phase_timestamps', () => {
      const result = formatSingleEntityPrompt(baseContext, 'test', [], [], baseEntityData);
      expect(result).toContain('d in phase');
    });

    it('shows task labels when available', () => {
      const result = formatSingleEntityPrompt(baseContext, 'test', [], [], baseEntityData);
      expect(result).toContain('TB Test');
      expect(result).toContain('I-9 Form');
    });

    it('falls back to task ID formatting when no labels', () => {
      const noLabels = { ...baseContext, task_labels: undefined };
      const result = formatSingleEntityPrompt(noLabels, 'test', [], [], baseEntityData);
      expect(result).toContain('tb test');
      expect(result).toContain('i9 form');
    });

    it('includes conversation history when present', () => {
      const withConvo = {
        ...baseContext,
        conversation_history: [
          { direction: 'inbound', text: 'Hi I sent my documents', timestamp: NOW - 3600000 },
          { direction: 'outbound', text: 'Thanks we received them!', timestamp: NOW - 7200000 },
        ],
      };
      const result = formatSingleEntityPrompt(withConvo, 'test', [], [], baseEntityData);
      expect(result).toContain('THEM');
      expect(result).toContain('US');
      expect(result).toContain('Conversation History');
    });

    it('includes recent outcomes', () => {
      const outcomes = [
        { entity_id: 'cg_123', action_type: 'sms_sent', outcome_type: 'response_received' },
      ];
      const result = formatSingleEntityPrompt(baseContext, 'test', outcomes, [], baseEntityData);
      expect(result).toContain('sms sent: response_received');
    });

    it('includes alerts from evaluateAlerts', () => {
      const rules = [{
        name: 'Missing TB Test', entity_type: 'caregiver', enabled: true,
        condition_type: 'task_missing', condition_config: { task_id: 'task_tb_test' },
      }];
      const result = formatSingleEntityPrompt(baseContext, 'test', [], rules, baseEntityData);
      expect(result).toContain('Active Alerts');
      expect(result).toContain('Missing TB Test');
    });

    it('handles missing enrichment fields gracefully', () => {
      const minimal = {
        id: 'cg_456', first_name: 'John', last_name: 'Doe',
        phone: null, email: null, entity_type: 'caregiver', phase: 'Intake',
        recent_notes: [], incomplete_tasks: [],
      };
      const result = formatSingleEntityPrompt(minimal, 'New application', [], [], {});
      expect(result).toContain('NONE'); // phone/email
      expect(result).toContain('New application');
      expect(result).not.toContain('Conversation History');
      expect(result).not.toContain('Upcoming Calendar');
    });

    it('includes calendar summary when present', () => {
      const withCalendar = { ...baseContext, calendar_summary: 'Interview scheduled for tomorrow at 2pm' };
      const result = formatSingleEntityPrompt(withCalendar, 'test', [], [], baseEntityData);
      expect(result).toContain('Upcoming Calendar');
      expect(result).toContain('Interview scheduled');
    });
  });
});
