/**
 * Agent Platform Phase 0.3 — Layer C live Anthropic API smoke test.
 *
 * These tests are GATED behind ANTHROPIC_API_KEY. They make 3 real calls
 * (~$0.10 total) per CI run to verify:
 *   1. The runtime's request body shape is accepted by real Claude.
 *   2. The runtime's response parsing handles real Claude output.
 *   3. Cost telemetry populates with real-world token counts.
 *
 * Layer A and B use mocked Anthropic responses; this layer is the fallback
 * that catches "the mock said yes but real Claude said no" mismatches.
 *
 * Soft-fail policy:
 *   * 429/503/529 (transient overload) → ONE retry inside callAnthropic; if
 *     the retry also returns transient, the test logs a warning and PASSES
 *     so PR merges aren't blocked by Anthropic outages.
 *   * Any non-transient failure (4xx config error, parse error, missing
 *     content blocks) → test FAILS as a real regression.
 *
 * Skipped automatically when ANTHROPIC_API_KEY is not set, which is the
 * default for local dev runs. CI configures the secret.
 */

import { describe, it, expect } from 'vitest';

import { runAgent } from '../../../supabase/functions/_shared/operations/agentRuntime.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
const liveTestsEnabled = Boolean(apiKey);
const itLive = liveTestsEnabled ? it : it.skip;

// ─── Manifests mirroring production seed (Phase 0.1) ───
//
// These do NOT load from Supabase — they're inlined so the live test never
// reaches the production database. The shapes match the seed in
// `supabase/migrations/20260502000000_agent_platform_phase_0_1_agents_table.sql`.

function liveRecruitingManifest() {
  return {
    id: 'live-recruiting',
    org_id: 'tc-live',
    slug: 'recruiting',
    name: 'Recruiting Agent (live test)',
    version: 1,
    system_prompt:
      'You are a friendly assistant. Reply with exactly the single word "ok" and nothing else.',
    tool_allowlist: [],
    autonomy_profile: {},
    context_recipe: { layers: ['identity', 'guidelines'] },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: {},
  };
}

function livePlannerManifest() {
  return {
    id: 'live-planner',
    org_id: 'tc-live',
    slug: 'proactive_planner',
    name: 'Proactive Planner (live test)',
    version: 1,
    system_prompt:
      'You are a JSON generator. Always respond with valid JSON and nothing else.',
    tool_allowlist: [],
    autonomy_profile: {},
    context_recipe: { layers: ['identity'] },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: {},
  };
}

function liveRouterManifest() {
  return {
    id: 'live-router',
    org_id: 'tc-live',
    slug: 'inbound_router',
    name: 'Inbound Router (live test)',
    version: 1,
    system_prompt:
      'You are a JSON generator. Always respond with valid JSON in the exact shape requested and nothing else.',
    tool_allowlist: [],
    autonomy_profile: {},
    context_recipe: { layers: ['identity'] },
    model: 'claude-haiku-4-5-20251001',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: {},
  };
}

// ─── Manifest stub (returns the inline manifest for any slug) ───

function makeInlineManifestSupabase(manifest) {
  const builder = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: manifest, error: null }; },
  };
  return { from() { return builder; } };
}

// ─── Soft-fail wrapper for transient errors ───

function isTransient(result) {
  if (result.status !== 'error') return false;
  const msg = result.error?.message || '';
  return /HTTP (429|503|529)/.test(msg);
}

// ─── Tests ───

describe('Agent Platform Phase 0.3 — Layer C live API smoke', () => {
  itLive('runAgent (chat) round-trips against real Claude Sonnet', async () => {
    const manifest = liveRecruitingManifest();
    const sb = makeInlineManifestSupabase(manifest);
    const result = await runAgent(
      sb,
      'recruiting',
      {
        shape: 'chat',
        chat: {
          messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
          currentUser: 'CI',
          toolDefinitions: [],
          autoExecuteTools: new Set(),
          confirmTools: new Set(),
          executeTool: async () => ({}),
        },
      },
      { apiKey, orgId: 'tc-live' },
    );

    if (isTransient(result)) {
      console.warn(`[live-test] Skipping due to transient Anthropic error: ${result.error?.message}`);
      return;
    }

    expect(result.status).toBe('ok');
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.cost.input_tokens).toBeGreaterThan(0);
    expect(result.cost.output_tokens).toBeGreaterThan(0);
    expect(result.cost.iterations).toBe(1);
    expect(result.agent.slug).toBe('recruiting');
  }, 30_000);

  itLive('runAgent (planner) returns parseable text from real Sonnet', async () => {
    const manifest = livePlannerManifest();
    const sb = makeInlineManifestSupabase(manifest);
    const result = await runAgent(
      sb,
      'proactive_planner',
      {
        shape: 'planner',
        planner: {
          mode: 'full_pipeline_daily',
          systemPrompt: manifest.system_prompt,
          userPrompt:
            'Return the JSON: {"ok": true}. No prose, no markdown, just the JSON.',
        },
      },
      { apiKey, orgId: 'tc-live' },
    );

    if (isTransient(result)) {
      console.warn(`[live-test] Skipping due to transient Anthropic error: ${result.error?.message}`);
      return;
    }

    expect(result.status).toBe('ok');
    expect(typeof result.reply).toBe('string');
    expect(result.cost.iterations).toBe(1);
    // The reply should at least contain "ok": true after a JSON parse
    const jsonMatch = result.reply.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    const parsed = JSON.parse(jsonMatch[0]);
    expect(parsed).toHaveProperty('ok');
  }, 30_000);

  itLive('runAgent (router) classifies a real STOP message via real Haiku', async () => {
    const manifest = liveRouterManifest();
    const sb = makeInlineManifestSupabase(manifest);
    const result = await runAgent(
      sb,
      'inbound_router',
      {
        shape: 'router',
        router: {
          systemPrompt:
            manifest.system_prompt +
            ' Given an inbound SMS, classify intent. Respond with ONLY this JSON shape: {"intent":"opt_out|question|unknown","confidence":0.0-1.0,"suggested_action":"none|send_sms","suggested_params":{},"drafted_response":"","reasoning":"short"}',
          userPrompt:
            'Inbound SMS from a caregiver: "STOP". Classify the intent.',
        },
      },
      { apiKey, orgId: 'tc-live' },
    );

    if (isTransient(result)) {
      console.warn(`[live-test] Skipping due to transient Anthropic error: ${result.error?.message}`);
      return;
    }

    expect(result.status).toBe('ok');
    expect(result.classification).toBeTruthy();
    // Real Haiku should classify "STOP" as opt_out with high confidence.
    // We do NOT assert on suggested_action here — the legacy production
    // router prompt explicitly tells the model "if opt_out, set action to
    // none", but this minimal live test prompt doesn't include that rule.
    // Real Haiku may freelance an opt-out acknowledgement (e.g. send_sms)
    // and that's not a runtime bug; it's a prompt-engineering choice that
    // Layer B fixtures already pin against the legacy production prompt.
    expect(result.classification.intent).toBe('opt_out');
    expect(result.classification.confidence).toBeGreaterThanOrEqual(0.5);
    expect(typeof result.classification.suggested_action).toBe('string');
  }, 30_000);
});
