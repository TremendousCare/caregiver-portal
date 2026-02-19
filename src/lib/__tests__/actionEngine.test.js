import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_PHASE_TASKS } from '../constants';

// Mock storage module
vi.mock('../storage', () => ({
  getPhaseTasks: () => DEFAULT_PHASE_TASKS,
}));

import { generateActionItems } from '../actionEngine';

// Helper: create a caregiver with sensible defaults
function makeCg(overrides = {}) {
  return {
    id: overrides.id || 'test-1',
    firstName: overrides.firstName || 'Test',
    lastName: overrides.lastName || 'Caregiver',
    tasks: overrides.tasks || {},
    phaseOverride: overrides.phaseOverride || undefined,
    phaseTimestamps: overrides.phaseTimestamps || {},
    applicationDate: overrides.applicationDate || undefined,
    hcaExpiration: overrides.hcaExpiration || undefined,
    ...overrides,
  };
}

// ─── generateActionItems ────────────────────────────────────────

describe('generateActionItems', () => {
  it('returns empty array for empty caregiver list', () => {
    expect(generateActionItems([])).toEqual([]);
  });

  it('returns empty array for caregiver with no actionable state', () => {
    // Fresh caregiver, day 0, no timestamps — no actions should fire
    const cg = makeCg({ applicationDate: new Date().toISOString().split('T')[0] });
    const items = generateActionItems([cg]);
    expect(items).toEqual([]);
  });

  // ── 24-Hour Interview Standard ──

  it('flags interview not scheduled after 1 day (warning)', () => {
    const cg = makeCg({
      applicationDate: new Date(Date.now() - 1.5 * 86400000).toISOString().split('T')[0],
      phaseTimestamps: { intake: Date.now() - 1.5 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title === 'Interview not yet scheduled');
    expect(match).toBeDefined();
    expect(match.urgency).toBe('warning');
  });

  it('escalates to critical after 2 days', () => {
    const cg = makeCg({
      applicationDate: new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0],
      phaseTimestamps: { intake: Date.now() - 3 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title === 'Interview not yet scheduled');
    expect(match).toBeDefined();
    expect(match.urgency).toBe('critical');
  });

  it('does NOT flag if calendar_invite is done', () => {
    const cg = makeCg({
      applicationDate: new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0],
      tasks: { calendar_invite: true },
      phaseTimestamps: { intake: Date.now() - 3 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title === 'Interview not yet scheduled');
    expect(match).toBeUndefined();
  });

  // ── Verification stall ──

  it('flags verification stall after 3 days (warning)', () => {
    const cg = makeCg({
      phaseOverride: 'verification',
      phaseTimestamps: { verification: Date.now() - 3 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.startsWith('Verification pending'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('warning');
  });

  it('escalates verification to critical after 5 days', () => {
    const cg = makeCg({
      phaseOverride: 'verification',
      phaseTimestamps: { verification: Date.now() - 6 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.startsWith('Verification pending'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('critical');
  });

  // ── HCA Expiration ──

  it('flags expired HCA as critical', () => {
    const pastDate = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];
    const cg = makeCg({ hcaExpiration: pastDate });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title === 'HCA registration EXPIRED');
    expect(match).toBeDefined();
    expect(match.urgency).toBe('critical');
  });

  it('flags HCA expiring within 30 days as warning', () => {
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
    const cg = makeCg({ hcaExpiration: futureDate });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.startsWith('HCA expiring'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('warning');
  });

  it('flags HCA expiring within 90 days as info', () => {
    const futureDate = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    const cg = makeCg({ hcaExpiration: futureDate });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.startsWith('HCA expiring'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('info');
  });

  it('does NOT flag HCA expiring beyond 90 days', () => {
    const futureDate = new Date(Date.now() + 120 * 86400000).toISOString().split('T')[0];
    const cg = makeCg({ hcaExpiration: futureDate });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.startsWith('HCA expiring'));
    expect(match).toBeUndefined();
  });

  // ── 7-Day Onboarding Sprint ──

  it('flags onboarding sprint at day 3 (warning)', () => {
    const cg = makeCg({
      phaseOverride: 'onboarding',
      phaseTimestamps: { onboarding: Date.now() - 3.5 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.includes('Onboarding docs incomplete'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('warning');
  });

  it('flags onboarding sprint at day 5 (critical deadline)', () => {
    const cg = makeCg({
      phaseOverride: 'onboarding',
      phaseTimestamps: { onboarding: Date.now() - 5.5 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.includes('Onboarding deadline'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('critical');
  });

  it('flags onboarding sprint EXPIRED at day 7+', () => {
    const cg = makeCg({
      phaseOverride: 'onboarding',
      phaseTimestamps: { onboarding: Date.now() - 8 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title === '7-Day Sprint EXPIRED');
    expect(match).toBeDefined();
    expect(match.urgency).toBe('critical');
  });

  // ── Phone screen stall ──

  it('flags no phone screen after 4 days in intake', () => {
    const cg = makeCg({
      phaseTimestamps: { intake: Date.now() - 5 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.includes('No phone screen'));
    expect(match).toBeDefined();
    expect(match.urgency).toBe('warning');
  });

  it('does NOT flag phone screen if already done', () => {
    const cg = makeCg({
      tasks: { phone_screen: true },
      phaseTimestamps: { intake: Date.now() - 5 * 86400000 },
    });
    const items = generateActionItems([cg]);
    const match = items.find((i) => i.title.includes('No phone screen'));
    expect(match).toBeUndefined();
  });

  // ── Sorting ──

  it('sorts by urgency: critical first, then warning, then info', () => {
    const caregivers = [
      // HCA expiring in 60 days = info
      makeCg({
        id: 'info-cg',
        hcaExpiration: new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0],
      }),
      // Verification stall 6 days = critical
      makeCg({
        id: 'critical-cg',
        phaseOverride: 'verification',
        phaseTimestamps: { verification: Date.now() - 6 * 86400000 },
      }),
      // HCA expiring in 15 days = warning
      makeCg({
        id: 'warning-cg',
        hcaExpiration: new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0],
      }),
    ];

    const items = generateActionItems(caregivers);
    expect(items.length).toBeGreaterThanOrEqual(3);

    // Find positions
    const criticalIdx = items.findIndex((i) => i.cgId === 'critical-cg');
    const warningIdx = items.findIndex((i) => i.cgId === 'warning-cg');
    const infoIdx = items.findIndex((i) => i.cgId === 'info-cg');

    expect(criticalIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(infoIdx);
  });

  // ── Multiple caregivers ──

  it('handles multiple caregivers and aggregates all items', () => {
    const caregivers = [
      makeCg({
        id: 'cg-1',
        hcaExpiration: new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0],
      }),
      makeCg({
        id: 'cg-2',
        hcaExpiration: new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0],
      }),
    ];
    const items = generateActionItems(caregivers);
    const cg1Items = items.filter((i) => i.cgId === 'cg-1');
    const cg2Items = items.filter((i) => i.cgId === 'cg-2');
    expect(cg1Items.length).toBeGreaterThan(0);
    expect(cg2Items.length).toBeGreaterThan(0);
  });
});
