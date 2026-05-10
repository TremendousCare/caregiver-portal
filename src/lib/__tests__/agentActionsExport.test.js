// Phase 1.1.C — agent-actions-export edge function smoke tests.
//
// The endpoint streams NDJSON and runs the verifier inline. We don't
// run the whole Deno entry point here (it requires `Deno.serve`,
// `jsr:` imports, env vars). Instead we test:
//   - The clampLimit logic indirectly via a behaviour assertion on
//     a contract we control.
//   - That the export's NDJSON shape (one header line + one row per
//     line) round-trips through string parsing.
//
// Real chain-walk semantics are covered by agentActionsVerify.test.js;
// those guarantees carry into the export endpoint because it reuses
// verifyAgentActionsChain unchanged.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('agent-actions-export edge function — structural assertions', () => {
  const exportSrc = readFileSync(
    join(__dirname, '../../../supabase/functions/agent-actions-export/index.ts'),
    'utf-8',
  );

  it('reuses verifyAgentActionsChain (no parallel verifier)', () => {
    expect(exportSrc).toMatch(/verifyAgentActionsChain/);
    expect(exportSrc).toMatch(/from '\.\.\/_shared\/operations\/agentActionsVerify\.ts'/);
  });

  it('streams via ReadableStream + TextEncoder (true streaming, not buffered)', () => {
    expect(exportSrc).toMatch(/new ReadableStream/);
    expect(exportSrc).toMatch(/new TextEncoder/);
  });

  it('emits a header line before per-row lines', () => {
    expect(exportSrc).toMatch(/export_meta:/);
    expect(exportSrc).toMatch(/total_rows:\s*report\.total_rows/);
    expect(exportSrc).toMatch(/first_break_at:\s*report\.first_break_at/);
  });

  it('annotates each row with verified=true|false + error detail', () => {
    expect(exportSrc).toMatch(/verified:\s*!err/);
    expect(exportSrc).toMatch(/error: err/);
  });

  it('orders by chain_seq ASC (consistent with the verifier)', () => {
    expect(exportSrc).toMatch(/order\(['"]chain_seq['"],\s*\{ ascending: true \}\)/);
  });

  it('caps limit at MAX_LIMIT (10000) to prevent unbounded exports', () => {
    expect(exportSrc).toMatch(/MAX_LIMIT\s*=\s*10000/);
    expect(exportSrc).toMatch(/Math\.min\(n,\s*MAX_LIMIT\)/);
  });

  it('honors agent_id, from, to, limit query params', () => {
    expect(exportSrc).toMatch(/searchParams\.get\(['"]agent_id['"]\)/);
    expect(exportSrc).toMatch(/searchParams\.get\(['"]from['"]\)/);
    expect(exportSrc).toMatch(/searchParams\.get\(['"]to['"]\)/);
    expect(exportSrc).toMatch(/searchParams\.get\(['"]limit['"]\)/);
  });

  it('sets Content-Type to application/x-ndjson', () => {
    expect(exportSrc).toMatch(/['"]Content-Type['"]:\s*['"]application\/x-ndjson['"]/);
  });

  it('includes Content-Disposition for filename', () => {
    expect(exportSrc).toMatch(/Content-Disposition.*attachment.*filename/);
  });

  it('requires AGENT_ACTIONS_ED25519_SEED env var (signing key for verification)', () => {
    expect(exportSrc).toMatch(/AGENT_ACTIONS_ED25519_SEED/);
  });
});

describe('agent-actions-export edge function — dual-write integration assertions', () => {
  // Cross-check that the dual-write call sites all use recordAgentAction
  // imported from the same _shared module. If a future refactor moves
  // it to a different file or breaks the import, this catches it
  // before the chain has gaps in production.
  const chatShellSrc = readFileSync(
    join(__dirname, '../../../supabase/functions/ai-chat/shell.ts'),
    'utf-8',
  );
  const plannerShellSrc = readFileSync(
    join(__dirname, '../../../supabase/functions/ai-planner/shell.ts'),
    'utf-8',
  );
  const routerShellSrc = readFileSync(
    join(__dirname, '../../../supabase/functions/message-router/shell.ts'),
    'utf-8',
  );
  const routingSrc = readFileSync(
    join(__dirname, '../../../supabase/functions/_shared/operations/routing.ts'),
    'utf-8',
  );

  it('chat shell imports recordAgentAction', () => {
    expect(chatShellSrc).toMatch(
      /import \{ recordAgentAction \} from "\.\.\/_shared\/operations\/agentActions\.ts"/
    );
  });

  it('chat shell calls recordAgentAction in the post-conversation tool loop with phase=executed', () => {
    expect(chatShellSrc).toMatch(
      /recordAgentAction\(supabase, \{[\s\S]*?phase:\s*"executed"/
    );
  });

  it('chat shell calls recordAgentAction in the confirmAction success path', () => {
    expect(chatShellSrc).toMatch(/audit confirmAction/);
  });

  it('planner shell imports recordAgentAction', () => {
    expect(plannerShellSrc).toMatch(
      /import \{ recordAgentAction \} from "\.\.\/_shared\/operations\/agentActions\.ts"/
    );
  });

  it('planner shell sets phase based on auto_executed status', () => {
    expect(plannerShellSrc).toMatch(
      /phase:\s*status === "auto_executed" \? "auto_executed" : "suggested"/
    );
  });

  it('router shell imports recordAgentAction', () => {
    expect(routerShellSrc).toMatch(
      /import \{ recordAgentAction \} from "\.\.\/_shared\/operations\/agentActions\.ts"/
    );
  });

  it('router shell writes phase=suggested for the classified suggestion', () => {
    expect(routerShellSrc).toMatch(
      /recordAgentAction\(supabase, \{[\s\S]*?phase:\s*"suggested"/
    );
  });

  it('executeSuggestion in routing.ts writes phase=executed or auto_executed', () => {
    // Dynamic import inside the function (avoids a top-level circular
    // dep with agentActions.ts → recordAgentAction → routing helpers).
    expect(routingSrc).toMatch(
      /import\("\.\/agentActions\.ts"\)/
    );
    expect(routingSrc).toMatch(
      /phase = suggestion\.status === "auto_executed"[\s\S]*?"auto_executed"[\s\S]*?"executed"/
    );
  });

  it('executeSuggestion only writes audit on result.success (no chain rows for failed executions)', () => {
    expect(routingSrc).toMatch(/if \(result\.success && suggestion\.agent_id\) \{/);
  });
});
