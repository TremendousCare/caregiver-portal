-- Rollback for Phase 0.4 cleanup — restore the agent_runtime_cutover row.
--
-- Restores the seed shape from `20260506000000_agent_platform_phase_0_4
-- _cutover_flag.sql`: all three shell flags default false. Useful only if
-- the cleanup PR itself is reverted alongside this rollback (the cleanup
-- removes the flag-reading code, so restoring the row alone has no effect
-- on edge function behaviour).
--
-- Idempotent via ON CONFLICT (key) — preserves any flipped value if the
-- row still exists.

INSERT INTO public.app_settings (key, value)
VALUES (
  'agent_runtime_cutover',
  jsonb_build_object(
    'ai_chat',         false,
    'ai_planner',      false,
    'message_router',  false
  )
)
ON CONFLICT (key) DO NOTHING;
