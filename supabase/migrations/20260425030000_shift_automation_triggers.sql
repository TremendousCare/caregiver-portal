-- ═══════════════════════════════════════════════════════════════
-- Shift Automation Triggers — Phase 2 of Caregiver Portal Launch
--
-- Adds four shift-related trigger types to automation_rules so the new
-- "Scheduling" tab in Settings → Automations can host workforce-ops
-- notification rules:
--
--   shift_assigned       — fires when a caregiver is assigned to a shift
--   shift_reminder_24h   — recurring; fires from automation-cron when a
--                          shift starts ~24h from now
--   shift_changed        — fires when start_time / end_time / client of
--                          an already-assigned shift is edited
--   shift_canceled       — fires when an assigned shift is canceled
--                          (status → 'cancelled', or caregiver removed,
--                          or reassigned to a different caregiver)
--
-- Also seeds four DEFAULT RULES, all DISABLED by default. Admin opts in
-- per rule once they've reviewed the templates. Rules use entity_type
-- 'shift' to surface in the new Scheduling tab.
--
-- Additive + idempotent. Old code paths continue to work because:
--   - New trigger types extend the CHECK; existing ones still pass
--   - Seed INSERTs use ON CONFLICT DO NOTHING keyed off the literal id
--   - No tables created, no columns added, no rows updated
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Extend the trigger_type CHECK to allow shift_* triggers ──
ALTER TABLE automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check;

ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver',
    'days_inactive',
    'interview_scheduled',
    'phase_change',
    'task_completed',
    'document_uploaded',
    'document_signed',
    'inbound_sms',
    'new_client',
    'client_phase_change',
    'client_task_completed',
    'survey_completed',
    'survey_pending',
    'recurring_availability_check',
    'shift_assigned',
    'shift_reminder_24h',
    'shift_changed',
    'shift_canceled'
  ]));

-- ── 2. Index for shift_reminder_24h dedup ──
-- The cron checks "have we already sent this reminder for this shift?"
-- by querying automation_log WHERE rule_id = ? AND status = 'success'
-- AND trigger_context->>'shift_id' = ?. Without a functional index this
-- becomes a sequential scan as automation_log grows.
CREATE INDEX IF NOT EXISTS idx_automation_log_shift_reminder
  ON automation_log (rule_id, ((trigger_context ->> 'shift_id')))
  WHERE status = 'success' AND trigger_context ->> 'shift_id' IS NOT NULL;

-- ── 3. Seed default rules (all disabled — admin opts in per rule) ──
-- Keyed off literal ids so the migration is idempotent. Templates use
-- the new shift merge fields ({{shift_start_text}}, {{client_full_name}},
-- {{shift_address}}) which the dispatcher pre-formats into the
-- trigger_context.

INSERT INTO automation_rules (
  id, name, trigger_type, entity_type, conditions, action_type,
  action_config, message_template, enabled, created_by, updated_by
) VALUES
  (
    'seed_shift_assigned',
    'New Shift Assigned',
    'shift_assigned',
    'shift',
    '{}'::jsonb,
    'send_sms',
    '{}'::jsonb,
    'Hi {{first_name}}, you''ve been assigned a shift on {{shift_start_text}} for {{client_full_name}}. Reply ''C'' to confirm or call us with questions.',
    false,
    'system_seed',
    'system_seed'
  ),
  (
    'seed_shift_reminder_24h',
    'Shift Reminder (24 hours)',
    'shift_reminder_24h',
    'shift',
    '{"start_hour": 9, "end_hour": 20}'::jsonb,
    'send_sms',
    '{}'::jsonb,
    'Hi {{first_name}}, reminder: you have a shift tomorrow at {{shift_start_text}} for {{client_full_name}} at {{shift_address}}. See you then!',
    false,
    'system_seed',
    'system_seed'
  ),
  (
    'seed_shift_changed',
    'Shift Updated',
    'shift_changed',
    'shift',
    '{}'::jsonb,
    'send_sms',
    '{}'::jsonb,
    'Hi {{first_name}}, your shift on {{shift_start_text}} for {{client_full_name}} has been updated. Please check the app for the latest details.',
    false,
    'system_seed',
    'system_seed'
  ),
  (
    'seed_shift_canceled',
    'Shift Canceled',
    'shift_canceled',
    'shift',
    '{}'::jsonb,
    'send_sms',
    '{}'::jsonb,
    'Hi {{first_name}}, your shift on {{shift_start_text}} for {{client_full_name}} has been canceled. Contact your coordinator with any questions.',
    false,
    'system_seed',
    'system_seed'
  )
ON CONFLICT (id) DO NOTHING;
