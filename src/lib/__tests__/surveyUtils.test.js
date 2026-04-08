import { describe, it, expect } from 'vitest';
import {
  evaluateSurveyAnswers,
  validateRequiredAnswers,
  matchesNumberRule,
  getQualificationSummary,
  generateQuestionId,
  generateSurveyToken,
  createBlankQuestion,
  getDefaultOptions,
  hasOptions,
  buildSurveyUrl,
  QUESTION_TYPES,
  QUALIFICATION_ACTIONS,
} from '../surveyUtils';

// ═══════════════════════════════════════════════════════════════
// Survey Utilities & Qualification Engine Tests
// ═══════════════════════════════════════════════════════════════

describe('surveyUtils', () => {

  // ─── Constants ───

  describe('QUESTION_TYPES', () => {
    it('should include all supported types', () => {
      const values = QUESTION_TYPES.map((t) => t.value);
      expect(values).toContain('yes_no');
      expect(values).toContain('multiple_choice');
      expect(values).toContain('free_text');
      expect(values).toContain('number');
    });
  });

  describe('QUALIFICATION_ACTIONS', () => {
    it('should include pass, flag, and disqualify', () => {
      const values = QUALIFICATION_ACTIONS.map((a) => a.value);
      expect(values).toContain('pass');
      expect(values).toContain('flag');
      expect(values).toContain('disqualify');
    });
  });

  // ─── ID Generation ───

  describe('generateQuestionId', () => {
    it('should produce unique IDs with q_ prefix', () => {
      const id1 = generateQuestionId();
      const id2 = generateQuestionId();
      expect(id1).toMatch(/^q_[a-f0-9]{8}$/);
      expect(id2).toMatch(/^q_[a-f0-9]{8}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateSurveyToken', () => {
    it('should produce unique tokens with sv_ prefix', () => {
      const t1 = generateSurveyToken();
      const t2 = generateSurveyToken();
      expect(t1).toMatch(/^sv_[a-f0-9]+$/);
      expect(t2).toMatch(/^sv_[a-f0-9]+$/);
      expect(t1).not.toBe(t2);
    });
  });

  // ─── Question Helpers ───

  describe('createBlankQuestion', () => {
    it('should create a blank question with defaults', () => {
      const q = createBlankQuestion();
      expect(q.id).toMatch(/^q_/);
      expect(q.text).toBe('');
      expect(q.type).toBe('yes_no');
      expect(q.required).toBe(true);
      expect(q.options).toEqual(['Yes', 'No']);
      expect(q.qualification_rules).toEqual([]);
    });
  });

  describe('getDefaultOptions', () => {
    it('returns Yes/No for yes_no type', () => {
      expect(getDefaultOptions('yes_no')).toEqual(['Yes', 'No']);
    });

    it('returns two placeholder options for multiple_choice', () => {
      expect(getDefaultOptions('multiple_choice')).toEqual(['Option 1', 'Option 2']);
    });

    it('returns empty array for free_text and number', () => {
      expect(getDefaultOptions('free_text')).toEqual([]);
      expect(getDefaultOptions('number')).toEqual([]);
    });
  });

  describe('hasOptions', () => {
    it('returns true for yes_no and multiple_choice', () => {
      expect(hasOptions('yes_no')).toBe(true);
      expect(hasOptions('multiple_choice')).toBe(true);
    });

    it('returns false for free_text and number', () => {
      expect(hasOptions('free_text')).toBe(false);
      expect(hasOptions('number')).toBe(false);
    });
  });

  // ─── buildSurveyUrl ───

  describe('buildSurveyUrl', () => {
    it('should build a URL with the token', () => {
      const url = buildSurveyUrl('sv_abc123');
      expect(url).toContain('/survey/sv_abc123');
    });
  });

  // ─── matchesNumberRule ───

  describe('matchesNumberRule', () => {
    it('matches exact numbers', () => {
      expect(matchesNumberRule(5, '5')).toBe(true);
      expect(matchesNumberRule(5, '6')).toBe(false);
    });

    it('matches less than operator', () => {
      expect(matchesNumberRule(3, '< 5')).toBe(true);
      expect(matchesNumberRule(5, '< 5')).toBe(false);
      expect(matchesNumberRule(7, '< 5')).toBe(false);
    });

    it('matches less than or equal operator', () => {
      expect(matchesNumberRule(5, '<= 5')).toBe(true);
      expect(matchesNumberRule(3, '<= 5')).toBe(true);
      expect(matchesNumberRule(6, '<= 5')).toBe(false);
    });

    it('matches greater than operator', () => {
      expect(matchesNumberRule(7, '> 5')).toBe(true);
      expect(matchesNumberRule(5, '> 5')).toBe(false);
      expect(matchesNumberRule(3, '> 5')).toBe(false);
    });

    it('matches greater than or equal operator', () => {
      expect(matchesNumberRule(5, '>= 5')).toBe(true);
      expect(matchesNumberRule(7, '>= 5')).toBe(true);
      expect(matchesNumberRule(3, '>= 5')).toBe(false);
    });

    it('matches equal operator', () => {
      expect(matchesNumberRule(5, '= 5')).toBe(true);
      expect(matchesNumberRule(6, '= 5')).toBe(false);
    });

    it('matches not-equal operator', () => {
      expect(matchesNumberRule(6, '!= 5')).toBe(true);
      expect(matchesNumberRule(5, '!= 5')).toBe(false);
    });

    it('returns false for non-numeric answers', () => {
      expect(matchesNumberRule('abc', '5')).toBe(false);
      expect(matchesNumberRule('', '> 0')).toBe(false);
    });

    it('handles decimal numbers', () => {
      expect(matchesNumberRule(3.5, '> 3')).toBe(true);
      expect(matchesNumberRule(2.5, '>= 2.5')).toBe(true);
    });
  });

  // ─── validateRequiredAnswers ───

  describe('validateRequiredAnswers', () => {
    const questions = [
      { id: 'q1', required: true },
      { id: 'q2', required: false },
      { id: 'q3', required: true },
    ];

    it('returns empty array when all required questions answered', () => {
      expect(validateRequiredAnswers(questions, { q1: 'Yes', q3: 'No' })).toEqual([]);
    });

    it('returns missing required question IDs', () => {
      expect(validateRequiredAnswers(questions, { q1: 'Yes' })).toEqual(['q3']);
    });

    it('treats empty string as missing', () => {
      expect(validateRequiredAnswers(questions, { q1: 'Yes', q3: '' })).toEqual(['q3']);
    });

    it('treats null/undefined as missing', () => {
      expect(validateRequiredAnswers(questions, { q1: 'Yes', q3: null })).toEqual(['q3']);
    });

    it('does not flag optional questions', () => {
      expect(validateRequiredAnswers(questions, { q1: 'Yes', q3: 'No' })).toEqual([]);
      // q2 is optional, not in answers — that's fine
    });

    it('returns all missing when no answers provided', () => {
      expect(validateRequiredAnswers(questions, {})).toEqual(['q1', 'q3']);
    });
  });

  // ─── evaluateSurveyAnswers (Qualification Engine) ───

  describe('evaluateSurveyAnswers', () => {
    it('returns "qualified" when no rules match', () => {
      const questions = [
        { id: 'q1', text: 'Name?', type: 'free_text', qualification_rules: [] },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'John' });
      expect(result.status).toBe('qualified');
      expect(result.results).toEqual([]);
    });

    it('returns "qualified" when all matched rules are pass', () => {
      const questions = [
        {
          id: 'q1', text: 'Legal to work?', type: 'yes_no', options: ['Yes', 'No'],
          qualification_rules: [
            { answer: 'Yes', action: 'pass', reason: '' },
            { answer: 'No', action: 'disqualify', reason: 'Not authorized' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'Yes' });
      expect(result.status).toBe('qualified');
      // pass rules still appear in results
      expect(result.results).toHaveLength(1);
      expect(result.results[0].action).toBe('pass');
    });

    it('returns "disqualified" when any disqualify rule matches', () => {
      const questions = [
        {
          id: 'q1', text: 'Legal to work?', type: 'yes_no', options: ['Yes', 'No'],
          qualification_rules: [
            { answer: 'No', action: 'disqualify', reason: 'Not authorized to work in the US' },
          ],
        },
        {
          id: 'q2', text: 'Have DL?', type: 'yes_no', options: ['Yes', 'No'],
          qualification_rules: [
            { answer: 'No', action: 'flag', reason: 'No driver license' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'No', q2: 'No' });
      expect(result.status).toBe('disqualified');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].action).toBe('disqualify');
      expect(result.results[0].reason).toBe('Not authorized to work in the US');
      expect(result.results[1].action).toBe('flag');
    });

    it('returns "flagged" when flag rules match but no disqualify', () => {
      const questions = [
        {
          id: 'q1', text: 'Legal to work?', type: 'yes_no', options: ['Yes', 'No'],
          qualification_rules: [
            { answer: 'No', action: 'disqualify', reason: 'Not authorized' },
          ],
        },
        {
          id: 'q2', text: 'Have DL?', type: 'yes_no', options: ['Yes', 'No'],
          qualification_rules: [
            { answer: 'No', action: 'flag', reason: 'No driver license' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'Yes', q2: 'No' });
      expect(result.status).toBe('flagged');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].action).toBe('flag');
    });

    it('handles multiple choice questions', () => {
      const questions = [
        {
          id: 'q1', text: 'Experience?', type: 'multiple_choice',
          options: ['None', '1-3 years', '3-5 years', '5+ years'],
          qualification_rules: [
            { answer: 'None', action: 'flag', reason: 'No experience' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'None' });
      expect(result.status).toBe('flagged');

      const result2 = evaluateSurveyAnswers(questions, { q1: '3-5 years' });
      expect(result2.status).toBe('qualified');
    });

    it('handles number questions with comparison operators', () => {
      const questions = [
        {
          id: 'q1', text: 'Years of experience?', type: 'number',
          qualification_rules: [
            { answer: '< 1', action: 'flag', reason: 'Less than 1 year experience' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: '0' });
      expect(result.status).toBe('flagged');

      const result2 = evaluateSurveyAnswers(questions, { q1: '5' });
      expect(result2.status).toBe('qualified');
    });

    it('ignores unanswered questions', () => {
      const questions = [
        {
          id: 'q1', text: 'Legal?', type: 'yes_no',
          qualification_rules: [
            { answer: 'No', action: 'disqualify', reason: 'Not authorized' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, {});
      expect(result.status).toBe('qualified');
      expect(result.results).toEqual([]);
    });

    it('is case-insensitive for answer matching', () => {
      const questions = [
        {
          id: 'q1', text: 'Legal?', type: 'yes_no',
          qualification_rules: [
            { answer: 'no', action: 'disqualify', reason: 'Not authorized' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'No' });
      expect(result.status).toBe('disqualified');
    });

    it('handles empty qualification_rules gracefully', () => {
      const questions = [
        { id: 'q1', text: 'Name?', type: 'free_text' },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'John' });
      expect(result.status).toBe('qualified');
    });

    it('disqualify takes precedence over flag', () => {
      const questions = [
        {
          id: 'q1', text: 'Felony?', type: 'yes_no',
          qualification_rules: [
            { answer: 'Yes', action: 'disqualify', reason: 'Has felony' },
            { answer: 'Yes', action: 'flag', reason: 'Review needed' },
          ],
        },
      ];
      const result = evaluateSurveyAnswers(questions, { q1: 'Yes' });
      expect(result.status).toBe('disqualified');
    });
  });

  // ─── getQualificationSummary ───

  describe('getQualificationSummary', () => {
    it('returns pass message for empty results', () => {
      expect(getQualificationSummary([])).toBe('All answers passed qualification checks.');
    });

    it('summarizes disqualified results', () => {
      const results = [
        { action: 'disqualify', reason: 'Not authorized', question_text: 'Legal?' },
      ];
      expect(getQualificationSummary(results)).toContain('Disqualified: Not authorized');
    });

    it('summarizes flagged results', () => {
      const results = [
        { action: 'flag', reason: 'No DL', question_text: 'Driver license?' },
      ];
      expect(getQualificationSummary(results)).toContain('Flagged: No DL');
    });

    it('uses question_text as fallback when reason is empty', () => {
      const results = [
        { action: 'flag', reason: '', question_text: 'Driver license?' },
      ];
      expect(getQualificationSummary(results)).toContain('Driver license?');
    });

    it('combines disqualified and flagged', () => {
      const results = [
        { action: 'disqualify', reason: 'Not authorized' },
        { action: 'flag', reason: 'No DL' },
      ];
      const summary = getQualificationSummary(results);
      expect(summary).toContain('Disqualified: Not authorized');
      expect(summary).toContain('Flagged: No DL');
    });
  });
});
