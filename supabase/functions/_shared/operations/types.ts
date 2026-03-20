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

// ─── Action Params for Autonomous Execution ───
// Each action type has a well-defined params shape used by executeSuggestion.

/** All supported autonomous action types */
export type AutonomousActionType =
  | "send_sms"
  | "send_email"
  | "add_note"
  | "add_client_note"
  | "update_phase"
  | "update_client_phase"
  | "complete_task"
  | "complete_client_task"
  | "update_caregiver_field"
  | "update_client_field"
  | "update_board_status"
  | "create_calendar_event"
  | "send_docusign_envelope";

export interface SendSmsParams {
  entity_id: string;
  entity_type: string;
  message: string;
}

export interface SendEmailParams {
  entity_id?: string;
  to_email: string;
  to_name?: string;
  subject: string;
  body: string;
  cc?: string;
}

export interface AddNoteParams {
  entity_id: string;
  entity_type: string;
  text: string;
  note_type?: string;
}

export interface UpdatePhaseParams {
  entity_id: string;
  entity_type: string;
  new_phase: string;
  reason?: string;
}

export interface CompleteTaskParams {
  entity_id: string;
  entity_type: string;
  task_id: string;
}

export interface UpdateFieldParams {
  entity_id: string;
  entity_type: string;
  field: string;
  value: string;
}

export interface UpdateBoardStatusParams {
  entity_id: string;
  new_status: string;
  note?: string;
}

export interface CreateCalendarEventParams {
  entity_id?: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  caregiver_email?: string;
  additional_attendees?: string;
  location?: string;
  description?: string;
  is_online?: boolean;
}

export interface SendDocuSignEnvelopeParams {
  entity_id: string;
  caregiver_email: string;
  caregiver_name: string;
  template_ids?: string[];
  template_names?: string[];
  is_packet?: boolean;
}
