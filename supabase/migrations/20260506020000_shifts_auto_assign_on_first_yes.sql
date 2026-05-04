-- ═══════════════════════════════════════════════════════════════
-- Add `auto_assign_on_first_yes` to shifts.
--
-- When a broadcast is sent with this flag set, the message-router
-- will assign the shift to the first caregiver who replies "Yes",
-- expire the other pending offers, and send a confirmation SMS,
-- without waiting for the scheduler to act manually.
--
-- Defaults to false so existing behavior is unchanged. Schedulers
-- opt in per-broadcast via a checkbox in the BroadcastModal.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS auto_assign_on_first_yes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN shifts.auto_assign_on_first_yes IS
  'If true, the first caregiver to reply "Yes" to a shift offer is auto-assigned, other pending offers are expired, and a confirmation SMS is sent. Set per-broadcast from the BroadcastModal checkbox.';
