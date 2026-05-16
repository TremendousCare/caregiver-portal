/**
 * Phase 1.6.2 — runExtractorHandler.
 *
 * One-shot agent invocation: read context → call Anthropic → parse a
 * single submit_call_analysis tool_use response → return structured
 * analysis. These tests cover:
 *
 *   * Invalid inputs (missing callSessionId / orgId / tool not in
 *     allowlist) return error without calling Anthropic.
 *   * Anthropic HTTP failure surfaces as status='error'.
 *   * Missing tool_use block surfaces as code='no_tool_use'.
 *   * Invalid call_type slug fails with code='invalid_call_type'.
 *   * Unknown red_flag slugs are silently dropped (not fatal).
 *   * Happy path returns the parsed analysis + cost metrics.
 *   * Action items, memory candidates, suggested_phase_change all
 *     get the right shape.
 */

import { describe, it, expect, vi } from 'vitest';

import { runExtractorHandler, __testables } from '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts';

// ─── Manifest fixture ───

const MANIFEST = {
  id:               'agent-call-analyst-uuid',
  org_id:           'org-1',
  slug:             'call_analyst',
  name:             'Call Analyst',
  version:          1,
  system_prompt:    'You are the call analyst.',
  tool_allowlist:   ['submit_call_analysis', 'get_call_transcription'],
  autonomy_profile: { submit_call_analysis: { current_level: 'L1' } },
  context_recipe:   {},
  model:            'claude-haiku-4-5-20251001',
  max_iterations:   1,
  kill_switch:      false,
  shadow_mode:      true,
  read_only_mode:   false,
  outcome_definition: {},
  triggers:         {},
};

const VALID_INPUT = {
  callSessionId:    'cs-1',
  contextBlock:     '## Transcript\nHello.\n',
  callTypeSlugs:    ['recruiting', 'payroll', 'other'],
  redFlagSlugs:     ['safety_issue', 'compliance_concern'],
  matchedEntityType: 'caregiver',
  matchedEntityId:   'cg-1',
  orgId:             'org-1',
};

function makeCallImpl(toolInput, opts = {}) {
  return vi.fn(async () => ({
    ok: opts.httpError ? false : true,
    status: opts.httpError ? 500 : 200,
    data: opts.httpError ? null : {
      usage: { input_tokens: 1200, output_tokens: 300 },
      content: opts.contentOverride !== undefined ? opts.contentOverride : [
        { type: 'tool_use', name: 'submit_call_analysis', input: toolInput },
      ],
    },
    attempts: 1,
  }));
}

const HAPPY_TOOL_INPUT = {
  call_type: 'recruiting',
  summary:   'Maria confirmed her shift.',
  sentiment: 'positive',
  red_flags: ['compliance_concern'],
  action_items: [
    { title: 'Send packet', detail: 'By Tuesday.', priority: 'high' },
  ],
  memory_candidates: [
    { content: 'Prefers mornings.', confidence: 0.85, tags: ['preference'] },
  ],
  suggested_phase_change: { to_phase: 'onboarding', rationale: 'Ready.' },
};

// ═══════════════════════════════════════════════════════════════
// Input validation
// ═══════════════════════════════════════════════════════════════

describe('runExtractorHandler — input validation', () => {
  it('rejects missing callSessionId', async () => {
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k' }, { ...VALID_INPUT, callSessionId: '' });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('invalid_request');
  });

  it('rejects missing orgId', async () => {
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k' }, { ...VALID_INPUT, orgId: '' });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('invalid_request');
  });

  it("rejects when submit_call_analysis isn't in the manifest allowlist", async () => {
    const m = { ...MANIFEST, tool_allowlist: ['get_call_transcription'] };
    const out = await runExtractorHandler(m, { apiKey: 'k' }, VALID_INPUT);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('tool_not_allowed');
  });
});

// ═══════════════════════════════════════════════════════════════
// Anthropic transport
// ═══════════════════════════════════════════════════════════════

describe('runExtractorHandler — Anthropic transport', () => {
  it('surfaces HTTP failures as code=anthropic_error', async () => {
    const callImpl = makeCallImpl(null, { httpError: true });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('anthropic_error');
  });

  it('returns no_tool_use when Anthropic emits only text content', async () => {
    const callImpl = makeCallImpl(null, {
      contentOverride: [{ type: 'text', text: 'I refuse to call the tool.' }],
    });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('no_tool_use');
  });

  it('returns no_tool_use when the wrong tool is called', async () => {
    const callImpl = makeCallImpl(null, {
      contentOverride: [{ type: 'tool_use', name: 'some_other_tool', input: { foo: 'bar' } }],
    });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('no_tool_use');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool input validation
// ═══════════════════════════════════════════════════════════════

describe('runExtractorHandler — tool input validation', () => {
  it('rejects an invalid call_type slug', async () => {
    const callImpl = makeCallImpl({ ...HAPPY_TOOL_INPUT, call_type: 'made_up_slug' });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('invalid_call_type');
  });

  it('silently drops unknown red_flag slugs and keeps the rest of the analysis', async () => {
    const callImpl = makeCallImpl({
      ...HAPPY_TOOL_INPUT,
      red_flags: ['compliance_concern', 'totally_made_up'],
    });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('ok');
    expect(out.analysis?.red_flags).toEqual(['compliance_concern']);
  });

  it('defaults missing sentiment to neutral', async () => {
    const callImpl = makeCallImpl({ ...HAPPY_TOOL_INPUT, sentiment: 'maybe' });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.analysis?.sentiment).toBe('neutral');
  });

  it('truncates action_item title to 80 chars and detail to 500 chars', async () => {
    const callImpl = makeCallImpl({
      ...HAPPY_TOOL_INPUT,
      action_items: [{ title: 'A'.repeat(200), detail: 'B'.repeat(800), priority: 'high' }],
    });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.analysis?.action_items[0].title.length).toBe(80);
    expect(out.analysis?.action_items[0].detail.length).toBe(500);
  });

  it('clamps memory_candidate confidence to [0, 1]', async () => {
    const callImpl = makeCallImpl({
      ...HAPPY_TOOL_INPUT,
      memory_candidates: [
        { content: 'high', confidence: 1.5, tags: [] },
        { content: 'neg',  confidence: -0.2, tags: [] },
      ],
    });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.analysis?.memory_candidates[0].confidence).toBe(1);
    expect(out.analysis?.memory_candidates[1].confidence).toBe(0);
  });

  it('coerces a malformed suggested_phase_change to null', async () => {
    const callImpl = makeCallImpl({ ...HAPPY_TOOL_INPUT, suggested_phase_change: { rationale: 'no to_phase' } });
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.analysis?.suggested_phase_change).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════

describe('runExtractorHandler — happy path', () => {
  it('returns status=ok with the full analysis on a valid tool_use', async () => {
    const callImpl = makeCallImpl(HAPPY_TOOL_INPUT);
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    expect(out.status).toBe('ok');
    expect(out.analysis).toMatchObject({
      call_type: 'recruiting',
      summary:   'Maria confirmed her shift.',
      sentiment: 'positive',
      red_flags: ['compliance_concern'],
    });
    expect(out.analysis?.action_items).toHaveLength(1);
    expect(out.analysis?.memory_candidates).toHaveLength(1);
    expect(out.analysis?.suggested_phase_change?.to_phase).toBe('onboarding');
  });

  it('passes manifest.model + system_prompt + the bespoke tool to Anthropic', async () => {
    const callImpl = makeCallImpl(HAPPY_TOOL_INPUT);
    await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl }, VALID_INPUT);
    const body = callImpl.mock.calls[0][0].body;
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toContain('You are the call analyst.');
    expect(body.system).toContain('## Transcript');
    expect(body.tools[0].name).toBe('submit_call_analysis');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_call_analysis' });
  });

  it('records iteration=1 + token usage + duration in cost', async () => {
    const callImpl = makeCallImpl(HAPPY_TOOL_INPUT);
    const out = await runExtractorHandler(MANIFEST, { apiKey: 'k', callAnthropicImpl: callImpl, now: () => 1000 }, VALID_INPUT);
    expect(out.cost.iterations).toBe(1);
    expect(out.cost.input_tokens).toBe(1200);
    expect(out.cost.output_tokens).toBe(300);
    expect(typeof out.cost.duration_ms).toBe('number');
  });
});

describe('runExtractorHandler — __testables', () => {
  it('exposes the submit_call_analysis tool schema and default max_tokens', () => {
    expect(__testables.SUBMIT_CALL_ANALYSIS_TOOL.name).toBe('submit_call_analysis');
    expect(__testables.SUBMIT_CALL_ANALYSIS_TOOL.input_schema.required).toContain('call_type');
    expect(__testables.SUBMIT_CALL_ANALYSIS_TOOL.input_schema.required).toContain('action_items');
    expect(__testables.EXTRACTOR_DEFAULT_MAX_TOKENS).toBe(2048);
  });
});
