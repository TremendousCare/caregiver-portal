-- ═══════════════════════════════════════════════════════════════
-- Care Coordinator Agent — M1: seed the agent manifest
--
-- Idempotent seed of the care-coordinator agent in the existing
-- public.agents registry. Fixed slug ('care-coordinator') is the
-- natural key so re-runs are safe.
--
-- config carries the v1 behavior contract the detector (M2) reads:
--   - enabled: master feature flag. FALSE here so the not-yet-built
--     detector stays inert until we deliberately flip it on for a tenant.
--   - acute_window_days / baseline_window_days: the two-window analysis
--     (see docs/CARE_COORDINATOR_AGENT.md §2.1).
--   - severity_thresholds: tunable cluster gates (§8). Editable from
--     data, no redeploy.
--
-- Behavior-neutral: nothing dispatches this agent yet.
-- ═══════════════════════════════════════════════════════════════

INSERT INTO public.agents (slug, display_name, description, status, version, model, config)
VALUES (
  'care-coordinator',
  'Care Coordinator',
  'Read-only clinical-surveillance agent. Detects change-of-condition clusters from caregiver shift observations against the care-plan baseline and surfaces triage-ready care signals to office staff.',
  'active',
  '1.0.0',
  NULL,
  jsonb_build_object(
    'enabled', false,
    'acute_window_days', 7,
    'baseline_window_days', 30,
    'severity_thresholds', jsonb_build_object(
      'watch_min_categories', 2,
      'urgent_min_categories', 3
    )
  )
)
ON CONFLICT (slug) DO NOTHING;
