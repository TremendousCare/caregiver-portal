// ─── Shared Operation Types ───
// Used by both ai-chat tool handlers and autonomous Edge Functions.

/** Result of a shared write operation */
export interface OperationResult {
  success: boolean;
  message: string;
  error?: string;
  data?: Record<string, any>;
}

/** Input for creating a timestamped note */
export interface NoteInput {
  text: string;
  type?: string; // "note" | "call" | "text" | "email" | "voicemail" | "meeting"
  direction?: string; // "inbound" | "outbound"
  outcome?: string;
}
