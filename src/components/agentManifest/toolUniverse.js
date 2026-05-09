// Phase 0.5 PR B — per-agent tool universe (locked §9 D1).
//
// Hard-coded list of every tool each agent is *capable* of being
// allowlisted with. The Phase 0.1 seed populated each agent's
// `tool_allowlist` with the full universe; the editor lets admins
// trim it. New tools added to a shell in a code change need to be
// reflected here in a follow-up PR — there's a sanity test that
// asserts the seed allowlist is a subset of the universe.
//
// Locked rationale (§9 D1): dynamic registry queries from the
// frontend would require adding a registry-introspection edge
// function. Hard-coding is fine for 0.5 (3 agents); when Phase 2+
// adds new agents, we revisit. Keeping these in one place makes the
// diff PR for "we added a new tool to recruiting" trivial.

const RECRUITING_UNIVERSE = [
  // caregiver-read
  'search_caregivers', 'get_caregiver_detail', 'get_pipeline_stats', 'list_stale_leads', 'check_compliance',
  // caregiver-write
  'add_note', 'draft_message', 'update_phase', 'complete_task', 'update_caregiver_field', 'update_board_status',
  // communication
  'send_sms', 'get_sms_history', 'get_call_log', 'get_call_recording', 'get_call_transcription',
  // email
  'search_emails', 'get_email_thread', 'send_email',
  // calendar
  'get_calendar_events', 'check_availability', 'create_calendar_event', 'update_calendar_event',
  // docusign
  'get_docusign_envelopes', 'send_docusign_envelope',
  // esign
  'get_esign_envelopes', 'send_esign_envelope',
  // client
  'search_clients', 'get_client_detail', 'get_client_pipeline_stats', 'list_stale_clients',
  'add_client_note', 'update_client_phase', 'complete_client_task', 'update_client_field',
  // awareness
  'get_caregiver_documents', 'get_automation_summary', 'get_inbound_messages', 'get_action_items', 'manage_suggestions',
];

const PROACTIVE_PLANNER_UNIVERSE = [
  'send_sms', 'send_email', 'add_note', 'add_client_note',
  'complete_task', 'complete_client_task',
  'update_phase', 'update_client_phase',
  'create_calendar_event', 'send_docusign_envelope',
];

const INBOUND_ROUTER_UNIVERSE = [
  'send_sms', 'send_email',
  'add_note', 'add_client_note',
  'update_phase', 'update_client_phase',
  'complete_task', 'complete_client_task',
  'update_caregiver_field', 'update_client_field',
  'update_board_status',
  'create_calendar_event',
  'send_docusign_envelope', 'send_esign_envelope',
];

// Lookup by agent slug. Unknown slugs return [] so the multiselect
// shows nothing rather than crashing — the validator catches this on
// save attempt.
export function toolUniverseForAgent(slug) {
  switch (slug) {
    case 'recruiting':        return RECRUITING_UNIVERSE;
    case 'proactive_planner': return PROACTIVE_PLANNER_UNIVERSE;
    case 'inbound_router':    return INBOUND_ROUTER_UNIVERSE;
    default:                  return [];
  }
}

// Exported for unit testing the "seed is a subset of universe" guard.
export const TOOL_UNIVERSES = {
  recruiting:        RECRUITING_UNIVERSE,
  proactive_planner: PROACTIVE_PLANNER_UNIVERSE,
  inbound_router:    INBOUND_ROUTER_UNIVERSE,
};
