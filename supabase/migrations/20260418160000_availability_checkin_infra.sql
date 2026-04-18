-- ═══════════════════════════════════════════════════════════════
-- Availability Check-In Infrastructure (PR 2 of 5)
--
-- Preparation only — adds the columns and seeded survey template that
-- the recurring availability check-in feature (PR 3/4/5) will use.
-- No behavior change on its own:
--
--   1. Adds `availability_check_paused` and metadata columns to
--      `caregivers`. Defaults to false, so every existing caregiver
--      is opted-in to future availability check-ins. A future PR
--      will add the admin UI to toggle it per-caregiver.
--
--   2. Seeds ONE pre-built survey template named "Availability
--      Check-In" containing a single `availability_schedule`
--      question. Idempotent — inserted only if no template with that
--      name already exists, so re-running the migration does nothing.
--
-- What this does NOT do:
--   - No cron. No automation rules. No outbound texts.
--   - Nothing sends this survey until a future PR adds the cron AND
--     the admin explicitly enables a rule in the Automations tab.
--
-- All changes are nullable / defaulted, so rollback is a column drop
-- and a single row delete.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Per-caregiver opt-out from availability check-ins ──
--
-- Global SMS opt-out (sms_opted_out, set by STOP keyword) is separate.
-- This flag is specifically for "please stop asking me about
-- availability" — a caregiver on this list still gets shift offers,
-- schedule confirmations, and other SMS. It's set by the admin, not
-- by any keyword.
ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS availability_check_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS availability_check_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS availability_check_paused_reason TEXT;

-- Partial index so the "Paused Check-Ins" admin list view (PR 3) can
-- pull just the paused caregivers without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_caregivers_availability_check_paused
  ON caregivers (availability_check_paused)
  WHERE availability_check_paused = true;


-- ── 2. Seed the Availability Check-In survey template ──
--
-- Inserted only if no template with this exact name exists, so this
-- migration can safely be re-run (e.g. on a preview branch, a
-- restored backup, or a fresh environment).
--
-- The template is `enabled = true` so the admin can select it in the
-- automations tab when they set up the recurring rule (PR 4). The
-- recurring rule itself will ship `enabled = false` — that's the
-- real kill switch. This template, on its own, cannot send SMS.
--
-- The question ID is hardcoded rather than auto-generated so it's
-- stable across environments (makes documentation and future
-- template upgrades easier).

INSERT INTO survey_templates (
  name,
  description,
  questions,
  enabled,
  expires_hours,
  send_via,
  sms_template,
  email_subject,
  email_template,
  auto_archive_disqualified,
  created_by
)
SELECT
  'Availability Check-In',
  'Periodic check-in asking caregivers to update their current weekly availability. Used by the recurring availability reminder automation.',
  '[
    {
      "id": "q_avail_checkin_v1",
      "text": "Please select the days and times you are available to work:",
      "type": "availability_schedule",
      "required": true,
      "options": [],
      "qualification_rules": []
    }
  ]'::jsonb,
  true,
  72,
  'sms',
  'Hi {{first_name}}, quick check-in from Tremendous Care — please update your availability so we can match you with the right shifts: {{survey_link}}',
  'Tremendous Care — Update Your Availability',
  E'Hi {{first_name}},\n\nQuick check-in: please take a moment to update your availability so we can match you with the right shifts.\n\n{{survey_link}}\n\nThanks,\nTremendous Care',
  false,
  'system:seed'
WHERE NOT EXISTS (
  SELECT 1 FROM survey_templates WHERE name = 'Availability Check-In'
);
