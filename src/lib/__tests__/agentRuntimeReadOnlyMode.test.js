/**
 * Phase 1.3 — startup-time read_only_mode behavior.
 *
 * When `agents.read_only_mode = true` at manifest load, runAgent runs
 * the chat handler normally but routes EVERY tool call (auto-tier and
 * confirm-tier) through a synthetic suppressor that returns a
 * read_only result without invoking executeTool.
 *
 * Distinct from shadow_mode (which only intercepts confirm-tier writes
 * and lets auto-tier reads through) and from kill_switch (which
 * prevents the agent from running at all).
 *
 * Result.status is `read_only` so callers can distinguish it from a
 * regular "ok" run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runAgent,
  __testables,
} from '../../../supabase/functions/_shared/operations/agentRuntime.ts';

const ORG_ID = 'org-1';
const AGENT_ID = 'agent-recruiting-uuid';

function makeManifest(overrides = {}) {
  return {
    id: AGENT_ID,
    org_id: ORG_ID,
    slug: 'recruiting',
    name: 'Recruiting Agent',
    version: 1,
    system_prompt: 'sys',
    tool_allowlist: ['search_caregivers', 'send_sms'],
    autonomy_profile: {},
    context_recipe: {},
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 5,
    kill_switch: false,
    shadow_mode: false,
    read_only_mode: true,
    outcome_definition: {},
    triggers: {},
    ...overrides,
  };
}

function makeSupabase(manifest) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: manifest, error: null })),
          })),
        })),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Wrapper unit ───

describe('wrapChatRequestForReadOnly', () => {
  it('replaces executeTool with a synthetic suppressor (every tool returns read_only)', async () => {
    const manifest = makeManifest();
    const original = vi.fn(async () => ({ ok: true }));
    const wrapped = __testables.wrapChatRequestForReadOnly(
      {
        messages: [],
        toolDefinitions: [],
        autoExecuteTools: new Set(['search_caregivers']),
        confirmTools: new Set(['send_sms']),
        executeTool: original,
      },
      manifest,
    );

    const r1 = await wrapped.executeTool('search_caregivers', { q: 'x' }, {});
    const r2 = await wrapped.executeTool('send_sms', { to: '+1' }, {});

    expect(original).not.toHaveBeenCalled();
    expect(r1.status).toBe('read_only');
    expect(r1.read_only).toBe(true);
    expect(r1.agent_id).toBe(AGENT_ID);
    expect(r2.status).toBe('read_only');
    expect(r2.message).toMatch(/Read-only mode/);
  });
});

// ─── End-to-end through runAgent ───

describe('runAgent — read_only_mode at startup', () => {
  it('returns status="read_only" and never calls executeTool', async () => {
    const manifest = makeManifest({ read_only_mode: true });
    const supabase = makeSupabase(manifest);

    const executeTool = vi.fn(async () => ({ ok: true }));

    // Claude asks for a tool, then returns text.
    let turn = 0;
    const claude = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          ok: true, status: 200, attempts: 1,
          data: {
            content: [
              { type: 'tool_use', id: 'tu-1', name: 'send_sms', input: {} },
            ],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        };
      }
      return {
        ok: true, status: 200, attempts: 1,
        data: {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      };
    });

    const result = await runAgent(
      supabase,
      'recruiting',
      {
        shape: 'chat',
        chat: {
          messages: [{ role: 'user', content: 'hi' }],
          toolDefinitions: [{ name: 'send_sms', input_schema: { type: 'object' } }],
          autoExecuteTools: new Set(),
          confirmTools: new Set(['send_sms']),
          executeTool,
        },
      },
      { orgId: ORG_ID, apiKey: 'test', callAnthropicImpl: claude },
    );

    expect(result.status).toBe('read_only');
    expect(executeTool).not.toHaveBeenCalled();
    // Claude got the synthetic "Read-only mode" tool result back; it
    // produced a final text reply on the next turn.
    expect(result.reply).toBe('ok');
  });

  it('precedence: read_only beats shadow when both flags are on', async () => {
    const manifest = makeManifest({ read_only_mode: true, shadow_mode: true });
    const supabase = makeSupabase(manifest);

    const executeTool = vi.fn(async () => ({ ok: true }));
    let turn = 0;
    const claude = vi.fn(async () => {
      turn++;
      if (turn === 1) {
        return {
          ok: true, status: 200, attempts: 1,
          data: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'search_caregivers', input: {} }],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        };
      }
      return {
        ok: true, status: 200, attempts: 1,
        data: {
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      };
    });

    const result = await runAgent(
      supabase,
      'recruiting',
      {
        shape: 'chat',
        chat: {
          messages: [{ role: 'user', content: 'hi' }],
          toolDefinitions: [
            { name: 'search_caregivers', input_schema: { type: 'object' } },
          ],
          // search_caregivers is auto-tier — under shadow alone it would
          // pass through to executeTool. Under read_only it MUST be
          // suppressed.
          autoExecuteTools: new Set(['search_caregivers']),
          confirmTools: new Set(),
          executeTool,
        },
      },
      { orgId: ORG_ID, apiKey: 'test', callAnthropicImpl: claude },
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.status).toBe('read_only');
  });

  it('kill_switch supersedes read_only (kill is the strictest gate)', async () => {
    const manifest = makeManifest({ kill_switch: true, read_only_mode: true });
    const supabase = makeSupabase(manifest);
    const executeTool = vi.fn();
    const claude = vi.fn();

    const result = await runAgent(
      supabase,
      'recruiting',
      {
        shape: 'chat',
        chat: {
          messages: [{ role: 'user', content: 'hi' }],
          toolDefinitions: [],
          autoExecuteTools: new Set(),
          confirmTools: new Set(),
          executeTool,
        },
      },
      { orgId: ORG_ID, apiKey: 'test', callAnthropicImpl: claude },
    );

    expect(result.status).toBe('killed');
    expect(claude).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
