CREATE TABLE IF NOT EXISTS action_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type         text NOT NULL,
  entity_type         text NOT NULL CHECK (entity_type IN ('caregiver', 'client')),
  entity_id           text NOT NULL,
  actor               text NOT NULL DEFAULT 'system',
  action_context      jsonb DEFAULT '{}',
  source              text NOT NULL DEFAULT 'ai_chat'
                        CHECK (source IN ('ai_chat', 'automation', 'manual')),
  outcome_type        text CHECK (outcome_type IN (
                        'response_received', 'no_response', 'completed',
                        'advanced', 'declined', 'expired'
                      )),
  outcome_detail      jsonb,
  outcome_detected_at timestamptz,
  created_at          timestamptz DEFAULT now(),
  expires_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_action_outcomes_pending
  ON action_outcomes (entity_type, entity_id, created_at DESC)
  WHERE outcome_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_action_outcomes_aggregate
  ON action_outcomes (action_type, outcome_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_outcomes_recent
  ON action_outcomes (outcome_detected_at DESC)
  WHERE outcome_detected_at IS NOT NULL;

ALTER TABLE action_outcomes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'action_outcomes_all' AND tablename = 'action_outcomes'
  ) THEN
    CREATE POLICY action_outcomes_all ON action_outcomes
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
