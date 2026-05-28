import { describe, it, expect } from 'vitest';
import {
  resolveRecipients,
  shouldSendEmail,
  buildToastTitle,
  buildToastMessage,
  buildEmailSubject,
  buildEmailBody,
} from '../exec/execNotificationRecipients.js';

// ─── resolveRecipients ──────────────────────────────────────────

describe('resolveRecipients', () => {
  it('returns the single assignee when assignedTo is set', () => {
    expect(resolveRecipients({
      assignedTo: 'kevin@tc.com',
      ownerEmails: ['blerta@tc.com', 'kevin@tc.com'],
    })).toEqual(['kevin@tc.com']);
  });

  it('lowercases + trims the assignee email', () => {
    expect(resolveRecipients({
      assignedTo: '  KEVIN@TC.COM ',
      ownerEmails: [],
    })).toEqual(['kevin@tc.com']);
  });

  it('does NOT include owners when an assignee is set (no fan-out)', () => {
    expect(resolveRecipients({
      assignedTo: 'manager@tc.com',
      ownerEmails: ['kevin@tc.com', 'blerta@tc.com'],
    })).toEqual(['manager@tc.com']);
  });

  it('fans out to all owners when assignedTo is null', () => {
    expect(resolveRecipients({
      assignedTo: null,
      ownerEmails: ['blerta@tc.com', 'kevin@tc.com'],
    })).toEqual(['blerta@tc.com', 'kevin@tc.com']);
  });

  it('fans out when assignedTo is an empty string or whitespace', () => {
    expect(resolveRecipients({ assignedTo: '', ownerEmails: ['k@x'] })).toEqual(['k@x']);
    expect(resolveRecipients({ assignedTo: '   ', ownerEmails: ['k@x'] })).toEqual(['k@x']);
  });

  it('dedupes owner emails by lower-case normalization', () => {
    expect(resolveRecipients({
      assignedTo: null,
      ownerEmails: ['KEVIN@tc.com', 'kevin@tc.com', '  kevin@tc.com '],
    })).toEqual(['kevin@tc.com']);
  });

  it('skips null/empty/non-string owner entries', () => {
    expect(resolveRecipients({
      assignedTo: null,
      ownerEmails: [null, '', '   ', 'blerta@tc.com', 42],
    })).toEqual(['blerta@tc.com']);
  });

  it('returns empty array when assignedTo is null AND no owners', () => {
    expect(resolveRecipients({ assignedTo: null, ownerEmails: [] })).toEqual([]);
    expect(resolveRecipients({ assignedTo: null, ownerEmails: null })).toEqual([]);
    expect(resolveRecipients({ assignedTo: null })).toEqual([]);
  });

  it('preserves owner-list order (sorting is the SQL function\'s job)', () => {
    expect(resolveRecipients({
      assignedTo: null,
      ownerEmails: ['z@x', 'a@x', 'm@x'],
    })).toEqual(['z@x', 'a@x', 'm@x']);
  });
});

// ─── shouldSendEmail ────────────────────────────────────────────

describe('shouldSendEmail', () => {
  it('true when the parent template opts in', () => {
    expect(shouldSendEmail({
      exec_task_templates: { send_email_on_notify: true },
    })).toBe(true);
  });

  it('false when the parent template opts out', () => {
    expect(shouldSendEmail({
      exec_task_templates: { send_email_on_notify: false },
    })).toBe(false);
  });

  it('false when there is no template (ad-hoc task)', () => {
    expect(shouldSendEmail({ exec_task_templates: null })).toBe(false);
    expect(shouldSendEmail({})).toBe(false);
    expect(shouldSendEmail(null)).toBe(false);
  });
});

// ─── buildToastTitle ────────────────────────────────────────────

describe('buildToastTitle', () => {
  it('lifecycle: prepends the anchor staff email', () => {
    expect(buildToastTitle({
      title: '30-day check-in',
      category: 'lifecycle',
      anchor_staff_email: 'alex@tc.com',
    })).toBe('30-day check-in — alex@tc.com');
  });

  it('recurring: just the title', () => {
    expect(buildToastTitle({
      title: 'Monthly P&L review',
      category: 'recurring',
    })).toBe('Monthly P&L review');
  });

  it('ad-hoc: just the title', () => {
    expect(buildToastTitle({
      title: 'Audit vendor invoices',
      category: 'ad_hoc',
    })).toBe('Audit vendor invoices');
  });

  it('falls back to template name when title is missing', () => {
    expect(buildToastTitle({
      title: null,
      exec_task_templates: { name: 'Template name' },
    })).toBe('Template name');
  });

  it('lifecycle without anchor_staff_email behaves like a non-lifecycle title', () => {
    expect(buildToastTitle({
      title: '30-day check-in',
      category: 'lifecycle',
      anchor_staff_email: null,
    })).toBe('30-day check-in');
  });
});

// ─── buildToastMessage ──────────────────────────────────────────

describe('buildToastMessage', () => {
  it('shows urgency only when critical/info (not warning, which is default)', () => {
    expect(buildToastMessage({ urgency: 'warning', category: 'lifecycle' })).toBe('lifecycle · due now');
    expect(buildToastMessage({ urgency: 'critical', category: 'lifecycle' })).toBe('critical · lifecycle · due now');
    expect(buildToastMessage({ urgency: 'info', category: 'lifecycle' })).toBe('info · lifecycle · due now');
  });

  it('includes recurrence_period for recurring tasks', () => {
    expect(buildToastMessage({ urgency: 'warning', category: 'recurring', recurrence_period: '2026-Q2' }))
      .toBe('recurring · 2026-Q2 · due now');
  });

  it('formats ad_hoc with the underscore stripped', () => {
    expect(buildToastMessage({ category: 'ad_hoc' })).toBe('ad hoc · due now');
  });

  it('fallback when nothing is present', () => {
    expect(buildToastMessage({})).toBe('Due now');
  });
});

// ─── buildEmailSubject ──────────────────────────────────────────

describe('buildEmailSubject', () => {
  it('prefixes [URGENT] for critical tasks', () => {
    expect(buildEmailSubject({
      title: 'HIPAA risk assessment',
      urgency: 'critical',
      category: 'recurring',
    })).toBe('[URGENT] Executive task due: HIPAA risk assessment');
  });

  it('no prefix for warning/info', () => {
    expect(buildEmailSubject({
      title: 'Monthly P&L',
      urgency: 'warning',
      category: 'recurring',
    })).toBe('Executive task due: Monthly P&L');
  });

  it('lifecycle subject includes the anchor staff', () => {
    expect(buildEmailSubject({
      title: '90-day check-in',
      urgency: 'critical',
      category: 'lifecycle',
      anchor_staff_email: 'alex@tc.com',
    })).toBe('[URGENT] Executive task due: 90-day check-in — alex@tc.com');
  });
});

// ─── buildEmailBody ─────────────────────────────────────────────

describe('buildEmailBody', () => {
  const task = {
    title: 'Monthly P&L review',
    urgency: 'warning',
    category: 'recurring',
    due_at: '2026-06-01T09:00:00Z',
    description: 'Pull the P&L from QuickBooks.',
    exec_task_templates: { guidance: 'Look for variances.' },
  };

  it('contains task title, urgency, due, description, guidance, and a portal link', () => {
    const body = buildEmailBody(task, 'https://portal.example.com');
    expect(body).toMatch(/Task: Monthly P&L review/);
    expect(body).toMatch(/Urgency: warning/);
    expect(body).toMatch(/Due: 2026-06-01T09:00:00Z/);
    expect(body).toMatch(/Pull the P&L from QuickBooks\./);
    expect(body).toMatch(/Guidance:\nLook for variances\./);
    expect(body).toMatch(/https:\/\/portal\.example\.com\/exec\/tasks/);
  });

  it('strips trailing slash from portal URL to avoid // in link', () => {
    const body = buildEmailBody(task, 'https://portal.example.com/');
    expect(body).not.toMatch(/\.com\/\//);
    expect(body).toMatch(/portal\.example\.com\/exec\/tasks/);
  });

  it('uses default portal URL when none provided', () => {
    const body = buildEmailBody(task);
    expect(body).toMatch(/caregiver-portal\.vercel\.app\/exec\/tasks/);
  });

  it('omits guidance/description sections when those fields are absent', () => {
    const body = buildEmailBody({
      title: 'X',
      urgency: 'info',
      due_at: '2026-06-01T09:00:00Z',
    });
    expect(body).not.toMatch(/Guidance:/);
  });
});
