// ─── Shared TypeScript Interfaces ───

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  riskLevel: "auto" | "confirm";
}

export interface ToolResult {
  requires_confirmation?: boolean;
  action?: string;
  summary?: string;
  caregiver_id?: string;
  params?: Record<string, any>;
  error?: string;
  success?: boolean;
  message?: string;
  [key: string]: any;
}

export interface ToolContext {
  supabase: any;
  caregivers: any[];
  clients: any[];
  currentUser: string;
}

export type ToolHandler = (
  input: any,
  ctx: ToolContext,
) => Promise<ToolResult>;

export type ConfirmHandler = (
  action: string,
  caregiverId: string,
  params: any,
  supabase: any,
  currentUser: string,
) => Promise<ToolResult>;
