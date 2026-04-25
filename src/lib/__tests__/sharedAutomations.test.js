import { describe, it, expect } from 'vitest';
import {
  evaluateAutomationConditions,
  resolveAutomationMergeFields,
  normalizeActionType,
} from '../../../supabase/functions/_shared/helpers/automations.ts';

describe('Shared Automations (direct _shared import)', () => {

  describe('evaluateAutomationConditions', () => {
    it('returns true when no conditions', () => {
      expect(evaluateAutomationConditions({}, 'intake', {})).toBe(true);
    });

    it('matches phase condition', () => {
      expect(evaluateAutomationConditions({ phase: 'intake' }, 'intake', {})).toBe(true);
    });

    it('rejects wrong phase', () => {
      expect(evaluateAutomationConditions({ phase: 'verification' }, 'intake', {})).toBe(false);
    });

    it('matches to_phase condition', () => {
      expect(evaluateAutomationConditions({ to_phase: 'verification' }, 'intake', { to_phase: 'verification' })).toBe(true);
    });

    it('rejects wrong to_phase', () => {
      expect(evaluateAutomationConditions({ to_phase: 'training' }, 'intake', { to_phase: 'verification' })).toBe(false);
    });

    it('matches task_id condition', () => {
      expect(evaluateAutomationConditions({ task_id: 'bgCheck' }, 'intake', { task_id: 'bgCheck' })).toBe(true);
    });

    it('rejects wrong task_id', () => {
      expect(evaluateAutomationConditions({ task_id: 'bgCheck' }, 'intake', { task_id: 'references' })).toBe(false);
    });

    it('matches document_type condition', () => {
      expect(evaluateAutomationConditions({ document_type: 'ID' }, 'intake', { document_type: 'ID' })).toBe(true);
    });

    it('rejects wrong document_type', () => {
      expect(evaluateAutomationConditions({ document_type: 'ID' }, 'intake', { document_type: 'CPR' })).toBe(false);
    });

    it('matches template_name (case-insensitive partial)', () => {
      expect(evaluateAutomationConditions(
        { template_name: 'onboarding' },
        'intake',
        { template_names: ['Home Care Aide Onboarding Package'] }
      )).toBe(true);
    });

    it('rejects non-matching template_name', () => {
      expect(evaluateAutomationConditions(
        { template_name: 'employment' },
        'intake',
        { template_names: ['Home Care Aide Onboarding Package'] }
      )).toBe(false);
    });

    it('matches keyword in message text', () => {
      expect(evaluateAutomationConditions(
        { keyword: 'interested' },
        'intake',
        { message_text: 'Yes I am interested in the position' }
      )).toBe(true);
    });

    it('rejects non-matching keyword', () => {
      expect(evaluateAutomationConditions(
        { keyword: 'stop' },
        'intake',
        { message_text: 'Yes I am interested' }
      )).toBe(false);
    });

    it('combines phase + task_id (both must match)', () => {
      expect(evaluateAutomationConditions(
        { phase: 'verification', task_id: 'bgCheck' },
        'verification',
        { task_id: 'bgCheck' }
      )).toBe(true);
    });

    it('rejects when one combined condition fails', () => {
      expect(evaluateAutomationConditions(
        { phase: 'verification', task_id: 'bgCheck' },
        'intake',
        { task_id: 'bgCheck' }
      )).toBe(false);
    });
  });

  describe('resolveAutomationMergeFields', () => {
    it('replaces all merge fields', () => {
      const result = resolveAutomationMergeFields(
        'Hi {{first_name}} {{last_name}}, call {{phone}} or email {{email}}',
        { first_name: 'Jane', last_name: 'Doe', phone: '5551234567', email: 'jane@test.com' }
      );
      expect(result).toBe('Hi Jane Doe, call 5551234567 or email jane@test.com');
    });

    it('handles missing fields with empty string', () => {
      const result = resolveAutomationMergeFields('Hi {{first_name}}', {});
      expect(result).toBe('Hi ');
    });

    it('resolves survey_link from trigger context', () => {
      const result = resolveAutomationMergeFields(
        'Click {{survey_link}} to start',
        { first_name: 'Jane' },
        { survey_link: 'https://example.com/s/abc' },
      );
      expect(result).toBe('Click https://example.com/s/abc to start');
    });

    it('resolves shift-context fields from trigger context', () => {
      const result = resolveAutomationMergeFields(
        'Hi {{first_name}}, shift on {{shift_start_text}} for {{client_full_name}} at {{shift_address}}',
        { first_name: 'Marcus' },
        {
          shift_start_text: 'Mon, Apr 25, 2:00 PM ET',
          client_full_name: 'Eleanor Doe',
          shift_address: '123 Main St, Boston, MA',
        },
      );
      expect(result).toBe(
        'Hi Marcus, shift on Mon, Apr 25, 2:00 PM ET for Eleanor Doe at 123 Main St, Boston, MA',
      );
    });

    it('renders empty strings for missing shift-context fields', () => {
      const result = resolveAutomationMergeFields(
        '{{shift_start_text}}|{{shift_end_text}}|{{shift_address}}|{{client_full_name}}',
        {},
        {},
      );
      expect(result).toBe('|||');
    });

    it('resolves client_first_name and client_last_name independently', () => {
      const result = resolveAutomationMergeFields(
        'For {{client_first_name}} ({{client_last_name}})',
        {},
        { client_first_name: 'Eleanor', client_last_name: 'Doe' },
      );
      expect(result).toBe('For Eleanor (Doe)');
    });
  });

  describe('normalizeActionType', () => {
    it('maps sms to send_sms', () => { expect(normalizeActionType('sms')).toBe('send_sms'); });
    it('maps email to send_email', () => { expect(normalizeActionType('email')).toBe('send_email'); });
    it('maps task to create_task', () => { expect(normalizeActionType('task')).toBe('create_task'); });
    it('passes through canonical types', () => {
      expect(normalizeActionType('send_sms')).toBe('send_sms');
      expect(normalizeActionType('send_email')).toBe('send_email');
      expect(normalizeActionType('create_task')).toBe('create_task');
    });
    it('passes through unknown types', () => { expect(normalizeActionType('send_docusign_envelope')).toBe('send_docusign_envelope'); });
  });
});