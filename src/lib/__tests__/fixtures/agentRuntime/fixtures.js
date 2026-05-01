/**
 * Agent Platform Phase 0.3 — Layer B parity fixtures.
 *
 * Each fixture pins the EXACT bytes the legacy edge function produces for a
 * given input. `runAgent` is asserted byte-equal against `expected.claudeRequestBody`
 * and against `expected.result`. The legacy code paths
 * (`ai-chat/index.ts`, `ai-planner/index.ts`, `_shared/operations/routing.ts`)
 * are read carefully when authoring a fixture; once authored, the fixture is
 * frozen until Phase 0.4 cutover. Any drift between fixture and runtime trips
 * the parity test.
 *
 * Fixture shape:
 * {
 *   name:                description for it() title
 *   manifest:            full AgentManifest the runtime loads
 *   request:             AgentRequest passed to runAgent
 *   cannedClaudeResponse:the AnthropicCallResult-shaped object the test mock
 *                        returns for every call
 *   expected: {
 *     claudeRequestBodies: array of bodies, one per Anthropic call (in order)
 *     result:               AgentResult fields to assert (subset OK; the test
 *                           uses toMatchObject style on these)
 *   }
 * }
 *
 * Fixture authoring rules:
 *   * model + max_tokens must match the legacy edge function's exact values.
 *   * system prompt is the manifest's `system_prompt` for chat (no assembler
 *     in fixtures — that's exercised by Layer A and by the live tests).
 *   * messages array slicing matches `messages.slice(-20)` from ai-chat.
 *   * Tools array equals manifest.tool_allowlist intersected with toolDefinitions.
 *   * Final reply text byte-equal to what the legacy text-block join produces.
 */

// ─── Helpers shared across fixtures ───

function recruitingManifest() {
  return {
    id: 'agent-recruiting-uuid',
    org_id: 'tc-org',
    slug: 'recruiting',
    name: 'Recruiting Agent',
    version: 1,
    system_prompt: 'You are the Tremendous Care AI Assistant — recruiter copilot.',
    tool_allowlist: ['search_caregivers', 'add_note', 'send_sms', 'create_calendar_event'],
    autonomy_profile: {
      search_caregivers: { current_level: 'L4' },
      add_note: { current_level: 'L4' },
      send_sms: { current_level: 'L2' },
      create_calendar_event: { current_level: 'L2' },
    },
    context_recipe: {
      layers: ['identity', 'situational', 'memories', 'threads', 'viewing', 'guidelines'],
      pipeline_scope: 'caregivers_and_clients',
    },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 5,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['chat', 'briefing', 'confirmed_action'] },
  };
}

function plannerManifest() {
  return {
    id: 'agent-planner-uuid',
    org_id: 'tc-org',
    slug: 'proactive_planner',
    name: 'Proactive Planner',
    version: 1,
    system_prompt: 'You are the daily planner for Tremendous Care.',
    tool_allowlist: ['send_sms', 'send_email', 'add_note', 'add_client_note', 'complete_task', 'update_phase', 'create_calendar_event'],
    autonomy_profile: {
      send_sms: { current_level: 'L1' },
      add_note: { current_level: 'L4' },
    },
    context_recipe: {
      layers: ['identity', 'situational', 'memories'],
      pipeline_scope: 'caregivers_and_clients',
    },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['cron_daily', 'event_triggered'] },
  };
}

function routerManifest() {
  return {
    id: 'agent-router-uuid',
    org_id: 'tc-org',
    slug: 'inbound_router',
    name: 'Inbound Message Router',
    version: 1,
    system_prompt:
      'You are a message classifier for Tremendous Care. Classify intent and suggest the best action.',
    tool_allowlist: [
      'send_sms', 'send_email', 'add_note', 'add_client_note',
      'update_phase', 'update_client_phase', 'complete_task', 'complete_client_task',
      'update_caregiver_field', 'update_client_field', 'update_board_status',
      'create_calendar_event', 'send_docusign_envelope', 'send_esign_envelope',
    ],
    autonomy_profile: { add_note: { current_level: 'L4' }, send_sms: { current_level: 'L2' } },
    context_recipe: { layers: ['identity', 'memories', 'situational'] },
    model: 'claude-haiku-4-5-20251001',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['cron'] },
  };
}

function ok(data, attempts = 1) {
  return { ok: true, status: 200, data, attempts };
}

// ─── Router parity fixtures ───
//
// The legacy router shells (`message-router/index.ts` + `routing.ts`) build
// a Haiku call with:
//   model       = "claude-haiku-4-5-20251001"  (today hardcoded; manifest now)
//   max_tokens  = 400                          (legacy const)
//   system      = the classifier system prompt (now from manifest)
//   messages    = [{ role: "user", content: <userPrompt> }]
//
// The user prompt and system prompt strings ARE legacy outputs; here we use
// representative values. The byte-equal assertion is "what the runtime sends
// to Claude is exactly what the test fixture says it should send."

const routerFixtures = [
  {
    name: 'router classifies a scheduling question with confidence',
    manifest: routerManifest(),
    request: {
      shape: 'router',
      router: {
        systemPrompt: routerManifest().system_prompt,
        userPrompt:
          'Entity: Sarah Vance (interview) — caregiver\nChannel: sms\nInbound message: "When is my interview?"',
      },
    },
    cannedClaudeResponse: ok({
      content: [
        {
          type: 'text',
          text:
            '{"intent":"scheduling_request","confidence":0.92,"suggested_action":"send_sms","suggested_params":{"message":"Your interview is Tue at 2pm."},"drafted_response":"Hi Sarah! Your interview is Tuesday at 2pm. Let me know if anything changes.","reasoning":"asked about scheduling"}',
        },
      ],
      usage: { input_tokens: 320, output_tokens: 70 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: routerManifest().system_prompt,
          messages: [
            {
              role: 'user',
              content:
                'Entity: Sarah Vance (interview) — caregiver\nChannel: sms\nInbound message: "When is my interview?"',
            },
          ],
        },
      ],
      result: {
        status: 'ok',
        agent: { slug: 'inbound_router', version: 1 },
        shadow: false,
        classification: {
          intent: 'scheduling_request',
          confidence: 0.92,
          suggested_action: 'send_sms',
          suggested_params: { message: 'Your interview is Tue at 2pm.' },
          drafted_response:
            'Hi Sarah! Your interview is Tuesday at 2pm. Let me know if anything changes.',
          reasoning: 'asked about scheduling',
        },
        cost: {
          input_tokens: 320,
          output_tokens: 70,
          iterations: 1,
        },
      },
    },
  },
  {
    name: 'router maps STOP to opt_out + action=none',
    manifest: routerManifest(),
    request: {
      shape: 'router',
      router: {
        systemPrompt: routerManifest().system_prompt,
        userPrompt: 'Entity: Joe Bloggs (intake) — caregiver\nChannel: sms\nInbound message: "STOP"',
      },
    },
    cannedClaudeResponse: ok({
      content: [
        {
          type: 'text',
          text:
            '{"intent":"opt_out","confidence":0.99,"suggested_action":"none","suggested_params":{},"drafted_response":"","reasoning":"explicit opt-out"}',
        },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: routerManifest().system_prompt,
          messages: [
            {
              role: 'user',
              content:
                'Entity: Joe Bloggs (intake) — caregiver\nChannel: sms\nInbound message: "STOP"',
            },
          ],
        },
      ],
      result: {
        status: 'ok',
        classification: {
          intent: 'opt_out',
          suggested_action: 'none',
          confidence: 0.99,
          drafted_response: '',
        },
      },
    },
  },
  {
    name: 'router coerces an unknown action to none and unknown intent to unknown',
    manifest: routerManifest(),
    request: {
      shape: 'router',
      router: {
        systemPrompt: routerManifest().system_prompt,
        userPrompt: 'Entity: Random (unknown) — caregiver\nChannel: sms\nInbound message: "?"',
      },
    },
    cannedClaudeResponse: ok({
      content: [
        {
          type: 'text',
          text:
            '{"intent":"sounds_great","confidence":0.5,"suggested_action":"send_invoice","suggested_params":{},"drafted_response":"","reasoning":""}',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: routerManifest().system_prompt,
          messages: [
            {
              role: 'user',
              content: 'Entity: Random (unknown) — caregiver\nChannel: sms\nInbound message: "?"',
            },
          ],
        },
      ],
      result: {
        status: 'ok',
        classification: {
          intent: 'unknown',
          suggested_action: 'none',
          confidence: 0.5,
          suggested_params: {},
          drafted_response: '',
        },
      },
    },
  },
];

// ─── Planner parity fixtures ───
//
// Legacy planner: single Sonnet call,
//   model      = "claude-sonnet-4-5-20250929" (now in manifest)
//   max_tokens = 2048
//   system     = PLANNER_SYSTEM_PROMPT or SINGLE_ENTITY_SYSTEM_PROMPT
//   messages   = [{ role: "user", content: <userPrompt> }]
//
// The fixtures verify the runtime forwards model + max_tokens + system + the
// single-message envelope exactly the way the legacy planner does.

const plannerFixtures = [
  {
    name: 'planner: full-pipeline daily mode forwards systemPrompt and userPrompt unchanged',
    manifest: plannerManifest(),
    request: {
      shape: 'planner',
      planner: {
        mode: 'full_pipeline_daily',
        systemPrompt: 'PLANNER_SYSTEM_PROMPT_FULL_PIPELINE',
        userPrompt: '## Pipeline (3 active entities)\n\n[abc] Sarah V (intake)…',
      },
    },
    cannedClaudeResponse: ok({
      content: [
        {
          type: 'text',
          text:
            '[{"entity_id":"abc","entity_type":"caregiver","entity_name":"Sarah V","action_type":"send_sms","priority":"high","title":"7-day quiet","detail":"No reply since intake","drafted_content":"Hi Sarah!","action_params":{"message":"Hi Sarah!"}}]',
        },
      ],
      usage: { input_tokens: 1500, output_tokens: 90 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          system: 'PLANNER_SYSTEM_PROMPT_FULL_PIPELINE',
          messages: [
            { role: 'user', content: '## Pipeline (3 active entities)\n\n[abc] Sarah V (intake)…' },
          ],
        },
      ],
      result: {
        status: 'ok',
        cost: { input_tokens: 1500, output_tokens: 90, iterations: 1 },
        reply:
          '[{"entity_id":"abc","entity_type":"caregiver","entity_name":"Sarah V","action_type":"send_sms","priority":"high","title":"7-day quiet","detail":"No reply since intake","drafted_content":"Hi Sarah!","action_params":{"message":"Hi Sarah!"}}]',
      },
    },
  },
  {
    name: 'planner: single-entity event-triggered mode forwards correctly (smaller token budget cap)',
    manifest: plannerManifest(),
    request: {
      shape: 'planner',
      planner: {
        mode: 'single_entity_event_triggered',
        systemPrompt: 'SINGLE_ENTITY_SYSTEM_PROMPT_HEADER',
        userPrompt: 'Entity Profile: Maria L\n## Trigger: shift_offer_declined',
      },
    },
    cannedClaudeResponse: ok({
      content: [{ type: 'text', text: '[]' }],
      usage: { input_tokens: 600, output_tokens: 4 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          system: 'SINGLE_ENTITY_SYSTEM_PROMPT_HEADER',
          messages: [
            { role: 'user', content: 'Entity Profile: Maria L\n## Trigger: shift_offer_declined' },
          ],
        },
      ],
      result: {
        status: 'ok',
        reply: '[]',
        cost: { input_tokens: 600, output_tokens: 4, iterations: 1 },
      },
    },
  },
  {
    name: 'planner: 500 from Anthropic surfaces as anthropic_error',
    manifest: plannerManifest(),
    request: {
      shape: 'planner',
      planner: {
        mode: 'full_pipeline_daily',
        systemPrompt: 'sp',
        userPrompt: 'up',
      },
    },
    cannedClaudeResponse: { ok: false, status: 500, data: null, errorText: 'boom', attempts: 1 },
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 2048,
          system: 'sp',
          messages: [{ role: 'user', content: 'up' }],
        },
      ],
      result: {
        status: 'error',
        error: { code: 'anthropic_error' },
      },
    },
  },
];

// ─── Chat parity fixtures ───
//
// Legacy ai-chat:
//   model       = "claude-sonnet-4-5-20250929"
//   max_tokens  = 4096                         (CHAT_DEFAULT_MAX_TOKENS)
//   system      = assembled prompt (or static fallback)
//   messages    = api messages (last 20)
//   tools       = filtered registry definitions
//
// Fixtures use the manifest's static system_prompt directly (no assembler) so
// the prompt-assembly path is locked from drift. Layer C exercises the full
// assembler against the live API.

const chatFixtures = [
  {
    name: 'chat: text-only Claude reply forwards verbatim',
    manifest: recruitingManifest(),
    request: {
      shape: 'chat',
      chat: {
        messages: [{ role: 'user', content: 'Say hello.' }],
        currentUser: 'Kevin',
        toolDefinitions: [{ name: 'search_caregivers' }, { name: 'add_note' }],
        autoExecuteTools: new Set(['search_caregivers', 'add_note']),
        confirmTools: new Set(['send_sms', 'create_calendar_event']),
        executeTool: async () => ({}),
      },
    },
    cannedClaudeResponse: ok({
      content: [{ type: 'text', text: 'Hello, Kevin.' }],
      usage: { input_tokens: 100, output_tokens: 5 },
    }),
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: recruitingManifest().system_prompt,
          messages: [{ role: 'user', content: 'Say hello.' }],
          tools: [{ name: 'search_caregivers' }, { name: 'add_note' }],
        },
      ],
      result: {
        status: 'ok',
        reply: 'Hello, Kevin.',
        cost: { input_tokens: 100, output_tokens: 5, iterations: 1 },
      },
    },
  },
  {
    name: 'chat: auto-tier tool_use is executed and toolResults captured',
    manifest: recruitingManifest(),
    request: {
      shape: 'chat',
      chat: {
        messages: [{ role: 'user', content: 'Search for Sarah.' }],
        currentUser: 'Kevin',
        toolDefinitions: [{ name: 'search_caregivers' }, { name: 'add_note' }],
        autoExecuteTools: new Set(['search_caregivers', 'add_note']),
        confirmTools: new Set(),
        executeTool: async () => ({ ok: true, count: 1, name: 'Sarah V' }),
      },
    },
    cannedClaudeResponse: 'multi-step', // see test runner
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: recruitingManifest().system_prompt,
          messages: [{ role: 'user', content: 'Search for Sarah.' }],
          tools: [{ name: 'search_caregivers' }, { name: 'add_note' }],
        },
        // Second call is the post-tool-result iteration; we don't lock the
        // exact assistant/user message-array bytes here because Claude's
        // `data.content` is reflected back; that surface is asserted in
        // Layer A. The parity bar for the byte-equal check is the FIRST
        // call (the deterministic one).
      ],
      result: {
        status: 'ok',
        reply: 'Found Sarah.',
        toolResults: [
          {
            tool: 'search_caregivers',
            input: { q: 'Sarah' },
            result: { ok: true, count: 1, name: 'Sarah V' },
          },
        ],
        cost: { iterations: 2 },
      },
    },
  },
  {
    name: 'chat: confirm-tier tool_use surfaces pendingConfirmation',
    manifest: recruitingManifest(),
    request: {
      shape: 'chat',
      chat: {
        messages: [{ role: 'user', content: 'Text Sarah.' }],
        currentUser: 'Kevin',
        toolDefinitions: [{ name: 'send_sms' }],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool: async (name, input) => ({
          requires_confirmation: true,
          summary: `Send SMS: "${input.message}"`,
        }),
      },
    },
    cannedClaudeResponse: 'multi-step-confirm',
    expected: {
      claudeRequestBodies: [
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: recruitingManifest().system_prompt,
          messages: [{ role: 'user', content: 'Text Sarah.' }],
          tools: [{ name: 'send_sms' }],
        },
      ],
      result: {
        status: 'ok',
        pendingConfirmation: {
          requires_confirmation: true,
          summary: 'Send SMS: "Hi Sarah!"',
        },
        reply: 'Drafted text — pending your confirm.',
      },
    },
  },
  {
    name: 'chat: shadow_mode flips the result status and short-circuits confirm tools',
    manifest: { ...recruitingManifest(), shadow_mode: true },
    request: {
      shape: 'chat',
      chat: {
        messages: [{ role: 'user', content: 'Text Sarah.' }],
        currentUser: 'Kevin',
        toolDefinitions: [{ name: 'send_sms' }],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        // The "real" execute would actually send. The runtime must not call
        // it under shadow.
        executeTool: async () => {
          throw new Error('REAL EXECUTE MUST NOT BE CALLED IN SHADOW MODE');
        },
      },
    },
    cannedClaudeResponse: 'multi-step-shadow',
    expected: {
      result: {
        status: 'shadow',
        shadow: true,
      },
    },
  },
];

export const fixtures = {
  router: routerFixtures,
  planner: plannerFixtures,
  chat: chatFixtures,
};

// Total fixture count (used by the smoke spec to lock minimum coverage)
export const fixtureCounts = {
  router: routerFixtures.length,
  planner: plannerFixtures.length,
  chat: chatFixtures.length,
  total: routerFixtures.length + plannerFixtures.length + chatFixtures.length,
};
