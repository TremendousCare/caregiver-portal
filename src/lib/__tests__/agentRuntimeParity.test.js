/**
 * Agent Platform Phase 0.3 — Layer B parity harness.
 *
 * For each fixture in fixtures/agentRuntime/fixtures.js:
 *   1. Mocks the manifest load to return fixture.manifest verbatim.
 *   2. Mocks the Anthropic call to return fixture.cannedClaudeResponse.
 *   3. Runs runAgent(slug, fixture.request).
 *   4. Asserts:
 *      a. The body sent to Anthropic on call N matches fixture.expected.claudeRequestBodies[N]
 *         BYTE-EQUAL (deep equality on the structured body — same property order
 *         not enforced, but every key/value identical).
 *      b. The returned AgentResult matches fixture.expected.result.
 *
 * The point of this layer: prove `runAgent` produces the same outputs the
 * legacy edge functions would produce, so Phase 0.4's cutover is a no-op
 * from the model's perspective. The fixtures encode "legacy behaviour" once,
 * and never drift again until 0.4 wiring lands.
 */

import { describe, it, expect, vi } from 'vitest';

import { runAgent } from '../../../supabase/functions/_shared/operations/agentRuntime.ts';
import { fixtures, fixtureCounts } from './fixtures/agentRuntime/fixtures.js';

// ─── Mock supabase that returns a fixed manifest ───

function makeManifestSupabase(manifest) {
  const builder = {
    select: vi.fn(function () { return this; }),
    eq: vi.fn(function () { return this; }),
    maybeSingle: vi.fn(async () => ({ data: manifest, error: null })),
  };
  return { from: vi.fn(() => builder) };
}

// ─── Helper: build a multi-step canned Claude response stream ───
//
// Some chat fixtures need more than one Claude turn (tool_use → tool_result →
// final text). The fixtures use sentinel strings 'multi-step', etc. to
// indicate this; the runner expands them here so each fixture stays compact.

function expandCannedResponse(fixture, callIndex) {
  const c = fixture.cannedClaudeResponse;
  if (typeof c === 'object') return c;

  if (c === 'multi-step') {
    if (callIndex === 0) {
      return {
        ok: true,
        status: 200,
        attempts: 1,
        data: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_a',
              name: 'search_caregivers',
              input: { q: 'Sarah' },
            },
          ],
          usage: { input_tokens: 80, output_tokens: 12 },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      attempts: 1,
      data: {
        content: [{ type: 'text', text: 'Found Sarah.' }],
        usage: { input_tokens: 95, output_tokens: 5 },
      },
    };
  }

  if (c === 'multi-step-confirm') {
    if (callIndex === 0) {
      return {
        ok: true,
        status: 200,
        attempts: 1,
        data: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_b',
              name: 'send_sms',
              input: { message: 'Hi Sarah!' },
            },
          ],
          usage: { input_tokens: 70, output_tokens: 10 },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      attempts: 1,
      data: {
        content: [{ type: 'text', text: 'Drafted text — pending your confirm.' }],
        usage: { input_tokens: 80, output_tokens: 8 },
      },
    };
  }

  if (c === 'multi-step-shadow') {
    if (callIndex === 0) {
      return {
        ok: true,
        status: 200,
        attempts: 1,
        data: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_c',
              name: 'send_sms',
              input: { message: 'Hi Sarah!' },
            },
          ],
          usage: { input_tokens: 70, output_tokens: 10 },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      attempts: 1,
      data: {
        content: [{ type: 'text', text: 'Done (shadow).' }],
        usage: { input_tokens: 80, output_tokens: 8 },
      },
    };
  }

  throw new Error(`Unknown sentinel: ${c}`);
}

// ─── Per-fixture runner ───

async function runFixture(fixture) {
  const sb = makeManifestSupabase(fixture.manifest);
  const captured = [];
  let callIndex = 0;
  const callAnthropicImpl = vi.fn(async (opts) => {
    // Deep-clone to freeze the body's state at the moment of the call.
    // The runtime mutates `currentMessages` in-place across iterations to
    // match the legacy ai-chat behaviour; without cloning, captured[0]
    // would alias captured[1] after the second iteration runs. This
    // mirrors what JSON.stringify already does inside callAnthropic.
    captured.push(JSON.parse(JSON.stringify(opts.body)));
    const resp = expandCannedResponse(fixture, callIndex);
    callIndex++;
    return resp;
  });

  const result = await runAgent(sb, fixture.manifest.slug, fixture.request, {
    apiKey: 'test-key',
    callAnthropicImpl,
    now: () => 0, // pin duration_ms = 0 for deterministic equality on cost
  });

  return { result, captured };
}

// ─── Parity assertions ───
//
// Each fixture produces ONE it() per parity check. We split body-equality
// from result-equality so failures surface specifically.

describe('Agent Platform Phase 0.3 — Layer B parity harness', () => {
  it('fixture coverage hits the floor (≥ 3 per agent shape)', () => {
    expect(fixtureCounts.router).toBeGreaterThanOrEqual(3);
    expect(fixtureCounts.planner).toBeGreaterThanOrEqual(3);
    expect(fixtureCounts.chat).toBeGreaterThanOrEqual(3);
    expect(fixtureCounts.total).toBeGreaterThanOrEqual(9);
  });

  // ── Router fixtures ──
  describe('router parity', () => {
    for (const fixture of fixtures.router) {
      describe(fixture.name, () => {
        it('byte-equal request body sent to Anthropic', async () => {
          const { captured } = await runFixture(fixture);
          for (let i = 0; i < fixture.expected.claudeRequestBodies.length; i++) {
            expect(captured[i]).toEqual(fixture.expected.claudeRequestBodies[i]);
          }
        });

        it('returns the expected AgentResult shape', async () => {
          const { result } = await runFixture(fixture);
          expect(result).toMatchObject(fixture.expected.result);
        });
      });
    }
  });

  // ── Planner fixtures ──
  describe('planner parity', () => {
    for (const fixture of fixtures.planner) {
      describe(fixture.name, () => {
        it('byte-equal request body sent to Anthropic', async () => {
          const { captured } = await runFixture(fixture);
          for (let i = 0; i < fixture.expected.claudeRequestBodies.length; i++) {
            expect(captured[i]).toEqual(fixture.expected.claudeRequestBodies[i]);
          }
        });

        it('returns the expected AgentResult shape', async () => {
          const { result } = await runFixture(fixture);
          expect(result).toMatchObject(fixture.expected.result);
        });
      });
    }
  });

  // ── Chat fixtures ──
  describe('chat parity', () => {
    for (const fixture of fixtures.chat) {
      describe(fixture.name, () => {
        it('byte-equal first-call request body sent to Anthropic', async () => {
          const { captured } = await runFixture(fixture);
          // For multi-step chat fixtures, only the FIRST call is byte-locked;
          // subsequent iterations reflect Claude's content back into messages
          // and that's covered by Layer A unit tests.
          if (fixture.expected.claudeRequestBodies?.length) {
            expect(captured[0]).toEqual(fixture.expected.claudeRequestBodies[0]);
          }
        });

        it('returns the expected AgentResult shape', async () => {
          const { result } = await runFixture(fixture);
          expect(result).toMatchObject(fixture.expected.result);
        });
      });
    }
  });

  // ── Cross-cutting: shadow mode parity ──
  describe('shadow mode does not change the request body sent to Anthropic', () => {
    it('the recruiting fixture under shadow_mode=true sends the same body as shadow_mode=false', async () => {
      const liveFixture = fixtures.chat.find(
        (f) => f.name === 'chat: text-only Claude reply forwards verbatim',
      );
      const shadowFixture = {
        ...liveFixture,
        manifest: { ...liveFixture.manifest, shadow_mode: true },
      };
      const { captured: liveCaptured } = await runFixture(liveFixture);
      const { captured: shadowCaptured } = await runFixture(shadowFixture);
      expect(shadowCaptured[0]).toEqual(liveCaptured[0]);
    });
  });
});
