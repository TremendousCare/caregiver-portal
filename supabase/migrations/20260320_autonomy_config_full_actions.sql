-- ══════════════════════════════════════════════
-- Seed autonomy_config with all supported action types
-- Phase 1: Agent Tool Parity
--
-- Adds rows for action types that were missing from the initial seed
-- (which only covered send_sms, send_email, update_phase, complete_task, add_note).
-- New action types: add_client_note, update_caregiver_field, update_client_field,
-- update_client_phase, complete_client_task, update_board_status,
-- create_calendar_event, send_docusign_envelope
-- ══════════════════════════════════════════════

INSERT INTO autonomy_config (action_type, entity_type, context, autonomy_level, max_autonomy_level) VALUES
  -- Client notes: same as caregiver notes, low risk → auto
  ('add_client_note',       'caregiver', 'inbound_routing', 'L4', 'L4'),
  ('add_client_note',       'client',    'inbound_routing', 'L4', 'L4'),

  -- Field updates: medium risk → suggest only, max confirm
  ('update_caregiver_field', 'caregiver', 'inbound_routing', 'L1', 'L2'),
  ('update_client_field',    'client',    'inbound_routing', 'L1', 'L2'),

  -- Client phase changes: same conservative level as caregiver
  ('update_client_phase',    'client',    'inbound_routing', 'L1', 'L2'),

  -- Client task completion: same as caregiver tasks
  ('complete_client_task',   'client',    'inbound_routing', 'L1', 'L3'),

  -- Board status: medium risk → suggest, can promote to confirm
  ('update_board_status',    'caregiver', 'inbound_routing', 'L1', 'L2'),

  -- Calendar: medium risk, complex action → suggest only, max confirm
  ('create_calendar_event',  'caregiver', 'inbound_routing', 'L1', 'L2'),
  ('create_calendar_event',  'client',    'inbound_routing', 'L1', 'L2'),

  -- DocuSign: high risk → suggest only, max suggest (never auto-send envelopes)
  ('send_docusign_envelope', 'caregiver', 'inbound_routing', 'L1', 'L1')

ON CONFLICT (action_type, entity_type, context) DO NOTHING;
