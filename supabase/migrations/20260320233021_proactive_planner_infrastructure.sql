-- 1. Expand autonomy_config context CHECK to include 'proactive'
ALTER TABLE autonomy_config DROP CONSTRAINT IF EXISTS autonomy_config_context_check;
ALTER TABLE autonomy_config ADD CONSTRAINT autonomy_config_context_check
  CHECK (context IN ('inbound_routing', 'ai_chat', 'automation', 'proactive'));

-- 2. Seed proactive autonomy config rows (conservative defaults)
INSERT INTO autonomy_config (action_type, entity_type, context, autonomy_level, max_autonomy_level, auto_promote_threshold)
VALUES
  ('send_sms', 'caregiver', 'proactive', 'L1', 'L3', 10),
  ('send_sms', 'client', 'proactive', 'L1', 'L3', 10),
  ('send_email', 'caregiver', 'proactive', 'L1', 'L3', 10),
  ('send_email', 'client', 'proactive', 'L1', 'L3', 10),
  ('add_note', 'caregiver', 'proactive', 'L4', 'L4', 5),
  ('add_note', 'client', 'proactive', 'L4', 'L4', 5),
  ('complete_task', 'caregiver', 'proactive', 'L1', 'L2', 10),
  ('complete_task', 'client', 'proactive', 'L1', 'L2', 10),
  ('update_phase', 'caregiver', 'proactive', 'L1', 'L2', 15),
  ('update_phase', 'client', 'proactive', 'L1', 'L2', 15),
  ('create_calendar_event', 'caregiver', 'proactive', 'L1', 'L2', 10),
  ('create_calendar_event', 'client', 'proactive', 'L1', 'L2', 10),
  ('send_docusign_envelope', 'caregiver', 'proactive', 'L1', 'L1', 999)
ON CONFLICT (action_type, entity_type, context) DO NOTHING;

-- 3. Add planner app_settings keys
INSERT INTO app_settings (key, value)
VALUES
  ('planner_enabled', '"true"'),
  ('planner_max_suggestions', '7'),
  ('last_planner_run', 'null')
ON CONFLICT (key) DO NOTHING;
