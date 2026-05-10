-- Phase 1.2 — autonomy promotion algorithm v2.
--
-- Backfills `agents.autonomy_profile` from the v1 shape
--    { "<action>": { "current_level": "L1|L2|L3|L4" } }
-- to the v2 shape
--    {
--      "<action>": {
--        "current_level":            "L1|L2|L3|L4",   -- preserved from v1
--        "max_level":                "L4",            -- ceiling per Prime Directive #5
--        "lookback_window":          50,              -- sliding window per `evaluatePromotion`
--        "promotion_thresholds": {                    -- per-transition gates per VISION.md
--          "L1->L2": { "min_consecutive":  5, "min_success_rate": 0.80, "min_sample":  10 },
--          "L2->L3": { "min_consecutive": 10, "min_success_rate": 0.90, "min_sample":  30 },
--          "L3->L4": { "min_consecutive": 20, "min_success_rate": 0.95, "min_sample": 100 }
--        },
--        "demote_on_harmful":         true,           -- one-level demote on severity='harmful'
--        "lockout_hours_after_demote": 24             -- promotion locked after demote until now() + N hours
--      }
--    }
--
-- The v1 shape is a strict subset of v2 — every existing key carries through
-- untouched, plus the four new keys. The runtime (`autonomy.ts:evaluatePromotion`)
-- supplies fallback defaults if any key is missing, so the migration is a
-- pre-warm rather than a hard requirement.
--
-- Idempotent: re-running yields the same end state. The strategy is to walk
-- each row's `autonomy_profile` keys, and for any inner object that is missing
-- a v2 key, layer the defaults in. Existing custom values (e.g. an admin who
-- has hand-edited a per-action `max_level`) are preserved.
--
-- Safety:
--   * Pure JSONB UPDATE — no schema changes, no DROP, no DELETE.
--   * Per-row UPDATE rebuilds the whole profile from scratch using
--     `jsonb_object_agg`, so partial writes from a prior failed run are
--     idempotently overwritten.
--   * Touches three rows total (the seed agents). Negligible runtime.
--   * Does NOT bump `agents.version` — operational backfills are not user
--     manifest edits and do not belong in `agent_versions` history.
--   * `updated_by` set to `'system:phase_1_2_migration'` so the audit trail
--     reflects the source of the change. The `tg_agents_set_updated_at`
--     trigger handles `updated_at`.
--
-- Rollback: not destructive. Reverting v2 is a matter of stopping the
-- `evaluatePromotion` reads in code; the extra JSONB keys are inert if no
-- consumer reads them. No down-migration required. (If we do want to clean
-- back to v1 shape, a follow-up migration can `jsonb_strip` the new keys —
-- safe but unnecessary.)

-- Lock the agents rows we're about to update so concurrent manifest edits
-- via `update_agent_manifest_v1` serialize cleanly. This is a one-shot
-- migration, not a hot path, so the brief lock is fine.

WITH v2_defaults AS (
  SELECT
    'L4'::text                                                AS max_level,
    50::int                                                   AS lookback_window,
    jsonb_build_object(
      'L1->L2', jsonb_build_object('min_consecutive',  5, 'min_success_rate', 0.80, 'min_sample',  10),
      'L2->L3', jsonb_build_object('min_consecutive', 10, 'min_success_rate', 0.90, 'min_sample',  30),
      'L3->L4', jsonb_build_object('min_consecutive', 20, 'min_success_rate', 0.95, 'min_sample', 100)
    )                                                         AS promotion_thresholds,
    true::boolean                                             AS demote_on_harmful,
    24::int                                                   AS lockout_hours_after_demote
),
upgraded AS (
  -- For each agent, rebuild autonomy_profile by walking its keys and
  -- merging the v2 defaults under any missing keys. `jsonb_object_agg`
  -- collapses the per-action rows back into a single jsonb object.
  --
  -- The COALESCE-with-default chain is the idempotent core: if a v2 key
  -- already exists on the inner object (e.g. from a prior run), it wins;
  -- otherwise the default is layered in. Custom admin edits survive.
  SELECT
    a.id,
    jsonb_object_agg(
      kv.key,
      kv.value
        || jsonb_build_object('max_level',                   COALESCE(kv.value->>'max_level',                  d.max_level))
        || jsonb_build_object('lookback_window',             COALESCE((kv.value->>'lookback_window')::int,     d.lookback_window))
        || jsonb_build_object('promotion_thresholds',        COALESCE(kv.value->'promotion_thresholds',         d.promotion_thresholds))
        || jsonb_build_object('demote_on_harmful',           COALESCE((kv.value->>'demote_on_harmful')::bool,  d.demote_on_harmful))
        || jsonb_build_object('lockout_hours_after_demote',  COALESCE((kv.value->>'lockout_hours_after_demote')::int, d.lockout_hours_after_demote))
    ) AS new_profile
  FROM public.agents a
  CROSS JOIN v2_defaults d
  CROSS JOIN LATERAL jsonb_each(a.autonomy_profile) kv
  WHERE jsonb_typeof(a.autonomy_profile) = 'object'
  GROUP BY a.id
)
UPDATE public.agents a
   SET autonomy_profile = u.new_profile,
       updated_by       = 'system:phase_1_2_migration'
  FROM upgraded u
 WHERE a.id = u.id;

-- Smoke: every action entry on every agent should now expose the five new
-- keys. We assert via a DO block so a partial backfill aborts the migration
-- (the runner reports the failure; the schema row is left untouched on
-- error inside DO).

DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT COUNT(*) INTO v_missing
    FROM public.agents a,
         LATERAL jsonb_each(a.autonomy_profile) kv
   WHERE NOT (
           kv.value ? 'current_level'
       AND kv.value ? 'max_level'
       AND kv.value ? 'lookback_window'
       AND kv.value ? 'promotion_thresholds'
       AND kv.value ? 'demote_on_harmful'
       AND kv.value ? 'lockout_hours_after_demote'
         );
  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'Phase 1.2 backfill smoke failed: % action entries missing one or more v2 keys.',
      v_missing;
  END IF;
END
$$;
