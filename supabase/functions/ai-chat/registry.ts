// ─── Tool Registry ───
// Tools self-register via registerTool(). The registry builds the TOOLS array
// and risk-level sets automatically — no giant switch statements needed.

import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolHandler,
  ConfirmHandler,
} from "./types.ts";

const toolDefs: Map<string, ToolDefinition> = new Map();
const toolHandlers: Map<string, ToolHandler> = new Map();
const confirmHandlers: Map<string, ConfirmHandler> = new Map();

export function registerTool(
  def: ToolDefinition,
  handler: ToolHandler,
  confirmedHandler?: ConfirmHandler,
): void {
  toolDefs.set(def.name, def);
  toolHandlers.set(def.name, handler);
  if (confirmedHandler) {
    confirmHandlers.set(def.name, confirmedHandler);
  }
}

export function getToolDefinitions(): any[] {
  return Array.from(toolDefs.values()).map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.input_schema,
  }));
}

export function getAutoExecuteSet(): Set<string> {
  const set = new Set<string>();
  for (const [name, def] of toolDefs) {
    if (def.riskLevel === "auto") set.add(name);
  }
  return set;
}

export function getConfirmSet(): Set<string> {
  const set = new Set<string>();
  for (const [name, def] of toolDefs) {
    if (def.riskLevel === "confirm") set.add(name);
  }
  return set;
}

export async function executeTool(
  name: string,
  input: any,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handler = toolHandlers.get(name);
  if (!handler) return { error: `Tool ${name} is not available.` };
  try {
    return await handler(input, ctx);
  } catch (err) {
    console.error(`Tool ${name} threw an exception:`, err);
    return { error: `Tool "${name}" failed: ${(err as Error).message || "Unknown error"}` };
  }
}

export async function executeConfirmedAction(
  action: string,
  caregiverId: string,
  params: any,
  supabase: any,
  currentUser: string,
): Promise<ToolResult> {
  const handler = confirmHandlers.get(action);
  if (!handler) return { error: `Unknown action: ${action}` };
  try {
    return await handler(action, caregiverId, params, supabase, currentUser);
  } catch (err) {
    console.error(`Confirmed action ${action} threw an exception:`, err);
    return { error: `Action "${action}" failed: ${(err as Error).message || "Unknown error"}` };
  }
}
