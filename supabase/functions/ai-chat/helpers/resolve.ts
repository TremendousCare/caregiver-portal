// ─── Shared Entity Resolution Helpers ───
// Eliminates the repeated resolve + ambiguity check + error return pattern
// used across all tool files. Each tool was doing this 3-line block:
//   const cg = await resolveCaregiver(...);
//   if (!cg) return { error: "..." };
//   if (cg._ambiguous) return { error: `Multiple matches: ...` };
//
// Now tools call: const cg = await requireCaregiver(input, ctx);
// If resolution fails, an early-return ToolResult is thrown (caught by the caller).

import type { ToolContext, ToolResult } from "../types.ts";
import { resolveCaregiver } from "./caregiver.ts";
import { resolveClient } from "./client.ts";

/** Sentinel class for early-return tool results (not a real error) */
export class ToolEarlyReturn {
  constructor(public result: ToolResult) {}
}

/**
 * Resolve a caregiver or throw a ToolEarlyReturn with the appropriate error message.
 * Use in a try/catch that catches ToolEarlyReturn and returns its result.
 */
export async function requireCaregiver(
  input: { caregiver_id?: string; name?: string },
  ctx: ToolContext,
): Promise<any> {
  const cg = await resolveCaregiver(ctx.supabase, input, ctx.caregivers);
  if (!cg) {
    throw new ToolEarlyReturn({ error: "Caregiver not found. Please check the name or ID." });
  }
  if (cg._ambiguous) {
    const names = cg.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ");
    throw new ToolEarlyReturn({ error: `Multiple matches found: ${names}. Please be more specific.` });
  }
  return cg;
}

/**
 * Resolve a client or throw a ToolEarlyReturn with the appropriate error message.
 */
export async function requireClient(
  input: { client_id?: string; identifier?: string; name?: string },
  ctx: ToolContext,
): Promise<any> {
  const client = await resolveClient(ctx.supabase, input, ctx.clients || []);
  if (!client) {
    throw new ToolEarlyReturn({ error: "Client not found. Please check the name or ID." });
  }
  if (client._ambiguous) {
    const names = client.matches.map((c: any) => `${c.first_name} ${c.last_name}`).join(", ");
    throw new ToolEarlyReturn({ error: `Multiple matches found: ${names}. Please be more specific.` });
  }
  return client;
}

/**
 * Wrap a tool handler to automatically catch ToolEarlyReturn and return its result.
 * This lets tool handlers use requireCaregiver/requireClient without manual try/catch.
 */
export function withResolve<T extends any[]>(
  handler: (...args: T) => Promise<ToolResult>,
): (...args: T) => Promise<ToolResult> {
  return async (...args: T): Promise<ToolResult> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ToolEarlyReturn) return err.result;
      throw err; // Re-throw real errors
    }
  };
}
