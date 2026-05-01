-- Phase 0.4 — Edge function cutover feature flag.
--
-- Seeds a single `app_settings` row that toggles each of the three legacy
-- agent edge functions (ai-chat / ai-planner / message-router) between
-- their current monolithic implementation (`index_legacy.ts`, identical to
-- pre-0.4 behaviour) and the new shell that calls `runAgent()` (Phase 0.3
-- runtime). All three flags default false so this migration is a pure
-- no-op until the owner flips one explicitly.
--
-- Flip-without-redeploy contract:
--   UPDATE public.app_settings
--      SET value = jsonb_set(value, '{ai_chat}', 'true'::jsonb)
--    WHERE key  = 'agent_runtime_cutover';
--
-- The shell reads the flag at the top of every invocation (cheap; one row,
-- single field). Read failure or missing key → treated as false. Once the
-- post-0.4 ≥ 7-day bake completes clean, the legacy code paths are removed
-- in a follow-up PR and this row becomes vestigial.
--
-- Idempotent: re-running this migration neither overwrites a flipped flag
-- nor errors. The ON CONFLICT DO NOTHING preserves whatever state the
-- owner has set in the live row.

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
