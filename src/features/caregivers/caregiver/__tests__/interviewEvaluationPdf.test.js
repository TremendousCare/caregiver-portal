import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildInterviewEvaluationPdf,
  buildEvaluationFilename,
} from '../interviewEvaluationPdf';

describe('interviewEvaluationPdf', () => {
  describe('buildEvaluationFilename', () => {
    it('combines first and last name with the submission date', () => {
      const name = buildEvaluationFilename({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        submittedAt: '2026-05-14T19:30:00Z',
      });
      expect(name).toBe('Interview_Evaluation_Ana_Garcia_2026-05-14.pdf');
    });

    it('strips unsafe characters from names', () => {
      const name = buildEvaluationFilename({
        caregiver: { firstName: 'Mary/Jane', lastName: "O'Neill" },
        submittedAt: '2026-05-14T19:30:00Z',
      });
      expect(name).toBe('Interview_Evaluation_Mary_Jane_O_Neill_2026-05-14.pdf');
    });

    it('falls back to a generic name when none provided', () => {
      const name = buildEvaluationFilename({
        caregiver: {},
        submittedAt: '2026-05-14T19:30:00Z',
      });
      expect(name).toBe('Interview_Evaluation_Caregiver_2026-05-14.pdf');
    });

    it('omits the date segment when submittedAt is invalid', () => {
      const name = buildEvaluationFilename({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        submittedAt: 'not-a-date',
      });
      expect(name).toMatch(/^Interview_Evaluation_Ana_Garcia\.pdf$/);
    });
  });

  describe('buildInterviewEvaluationPdf', () => {
    const baseTemplate = {
      name: 'Interview Evaluation',
      questions: [
        { id: 'q1', section: 'Background', type: 'yes_no', text: 'Do you have a current HCA?', options: ['Yes', 'No'] },
        { id: 'q2', section: 'Background', type: 'number', text: 'Years of experience?' },
        { id: 'q3', section: 'Skills', type: 'multi_select', text: 'Languages spoken', options: ['English', 'Spanish'] },
        { id: 'q4', section: 'Skills', type: 'free_text', text: 'Anything else we should know?' },
        { id: 'q5', section: 'Schedule', type: 'availability_schedule', text: 'When can you work?' },
      ],
    };

    const baseAnswers = {
      q1: 'Yes',
      q2: 5,
      q3: ['English', 'Spanish'],
      q4: 'Reliable transportation; flexible weekends.',
      q5: { slots: [{ day: 1, startTime: '09:00', endTime: '17:00' }] },
    };

    it('returns a parseable PDF byte array', async () => {
      const bytes = await buildInterviewEvaluationPdf({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        template: baseTemplate,
        answers: baseAnswers,
        submittedAt: '2026-05-14T19:30:00Z',
        evaluator: 'Jessica',
      });
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(500);

      const parsed = await PDFDocument.load(bytes);
      expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    });

    it('handles missing answers without throwing', async () => {
      const bytes = await buildInterviewEvaluationPdf({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        template: baseTemplate,
        answers: {},
        submittedAt: null,
        evaluator: null,
      });
      const parsed = await PDFDocument.load(bytes);
      expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    });

    it('paginates when content exceeds one page', async () => {
      const longQuestions = [];
      for (let i = 0; i < 80; i++) {
        longQuestions.push({
          id: `q_${i}`,
          section: i < 40 ? 'Section A' : 'Section B',
          type: 'free_text',
          text: `Question ${i + 1} prompt that is intentionally long enough to take up some horizontal space.`,
        });
      }
      const longAnswers = {};
      for (let i = 0; i < 80; i++) {
        longAnswers[`q_${i}`] = 'Sample answer text. '.repeat(8);
      }
      const bytes = await buildInterviewEvaluationPdf({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        template: { name: 'Long Eval', questions: longQuestions },
        answers: longAnswers,
        submittedAt: '2026-05-14T19:30:00Z',
      });
      const parsed = await PDFDocument.load(bytes);
      expect(parsed.getPageCount()).toBeGreaterThan(1);
    });

    it('survives non-WinAnsi characters in answers (em-dash, smart quotes, emoji)', async () => {
      const template = {
        name: 'Eval',
        questions: [{ id: 'q1', type: 'free_text', text: 'Notes' }],
      };
      const answers = { q1: 'Great fit — "very reliable" 👍 and motivated…' };
      const bytes = await buildInterviewEvaluationPdf({
        caregiver: { firstName: 'Ana', lastName: 'Garcia' },
        template,
        answers,
      });
      const parsed = await PDFDocument.load(bytes);
      expect(parsed.getPageCount()).toBe(1);
    });
  });
});
