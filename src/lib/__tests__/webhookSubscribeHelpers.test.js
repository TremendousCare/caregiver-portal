/**
 * Tests for supabase/functions/ringcentral-webhook/subscribe-helpers.ts
 *
 * The helpers module is pure TypeScript (no Deno-only imports) so Vitest
 * can load it directly via the vitest.config.js `.ts` resolver.
 */

import { describe, it, expect } from 'vitest';
import { summarizeRouteResults } from '../../../supabase/functions/ringcentral-webhook/subscribe-helpers.ts';

describe('summarizeRouteResults', () => {
  const FIXED_NOW = '2026-04-17T12:00:00.000Z';

  it('reports zero subscribed when there are no routes', () => {
    const summary = summarizeRouteResults([], FIXED_NOW);
    expect(summary).toEqual({
      subscription_id: null,
      total_routes: 0,
      subscribed_routes: 0,
      failed_routes: 0,
      last_run_at: FIXED_NOW,
      per_route: [],
    });
  });

  it('counts created and renewed actions as subscribed', () => {
    const summary = summarizeRouteResults(
      [
        { category: 'general', label: 'General', action: 'renewed', subscription_id: 'sub-1' },
        { category: 'onboarding', label: 'Onboarding (TAS)', action: 'created', subscription_id: 'sub-2' },
      ],
      FIXED_NOW,
    );
    expect(summary.total_routes).toBe(2);
    expect(summary.subscribed_routes).toBe(2);
    expect(summary.failed_routes).toBe(0);
  });

  it('counts failed actions separately', () => {
    const summary = summarizeRouteResults(
      [
        { category: 'general', label: 'General', action: 'renewed', subscription_id: 'sub-1' },
        { category: 'onboarding', label: 'Onboarding (TAS)', action: 'failed', error: 'bad jwt' },
        { category: 'scheduling', label: 'Scheduling (OC)', action: 'failed', error: 'no secret' },
      ],
      FIXED_NOW,
    );
    expect(summary.total_routes).toBe(3);
    expect(summary.subscribed_routes).toBe(1);
    expect(summary.failed_routes).toBe(2);
  });

  it('exposes the first successful subscription_id at the top level for legacy UI reads', () => {
    const summary = summarizeRouteResults(
      [
        { category: 'general', label: 'General', action: 'failed', error: 'boom' },
        { category: 'onboarding', label: 'Onboarding (TAS)', action: 'created', subscription_id: 'sub-tas' },
      ],
      FIXED_NOW,
    );
    // Legacy UI only reads `subscription_id`; we populate it with the first
    // succeeded route so the old status dot shows Active whenever any route works.
    expect(summary.subscription_id).toBe('sub-tas');
  });

  it('passes through the per_route array unchanged', () => {
    const input = [
      { category: 'general', label: 'General', action: 'renewed', subscription_id: 'sub-1', expires_at: '2026-04-24T12:00:00Z' },
      { category: 'onboarding', label: 'Onboarding (TAS)', action: 'failed', error: 'no jwt' },
    ];
    const summary = summarizeRouteResults(input, FIXED_NOW);
    expect(summary.per_route).toEqual(input);
  });

  it('uses the provided nowIso for last_run_at', () => {
    const summary = summarizeRouteResults([], '2030-01-01T00:00:00.000Z');
    expect(summary.last_run_at).toBe('2030-01-01T00:00:00.000Z');
  });
});
