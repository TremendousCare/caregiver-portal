-- Rollback for 20260531000100_backfill_service_plan_caregiver_rules_hazel_sheldon.sql
--
-- Removes only the rows this backfill created, identified by the created_by
-- tag. Rules the office has since added or edited through the UI carry a
-- different created_by (a user name) and are left untouched.

DELETE FROM public.service_plan_caregiver_rules
WHERE created_by = 'system:backfill-20260531';
