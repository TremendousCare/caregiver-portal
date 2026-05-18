import { describe, it, expect } from 'vitest';
import { shouldShowClientPlanPanels } from '../../features/clients/utils.js';

describe('shouldShowClientPlanPanels', () => {
  it('hides panels for new leads', () => {
    expect(shouldShowClientPlanPanels({ phase: 'new_lead' })).toBe(false);
  });

  it('hides panels through the consult/assessment funnel', () => {
    expect(shouldShowClientPlanPanels({ phase: 'initial_contact' })).toBe(false);
    expect(shouldShowClientPlanPanels({ phase: 'consultation' })).toBe(false);
    expect(shouldShowClientPlanPanels({ phase: 'assessment' })).toBe(false);
  });

  it('shows panels starting at proposal', () => {
    expect(shouldShowClientPlanPanels({ phase: 'proposal' })).toBe(true);
  });

  it('shows panels for won (active) clients', () => {
    expect(shouldShowClientPlanPanels({ phase: 'won' })).toBe(true);
  });

  it('hides panels for terminal lost/nurture phases', () => {
    expect(shouldShowClientPlanPanels({ phase: 'lost' })).toBe(false);
    expect(shouldShowClientPlanPanels({ phase: 'nurture' })).toBe(false);
  });

  it('treats a client with no explicit phase as new_lead', () => {
    expect(shouldShowClientPlanPanels({})).toBe(false);
  });
});
