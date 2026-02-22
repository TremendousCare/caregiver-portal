-- ═══════════════════════════════════════════════════════════════
-- Context Layer Foundation — Phase 1
-- Tables: context_memory, events, context_snapshots
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Context Memory ──
-- Stores episodic (per-entity), semantic (learned patterns),
-- procedural (SOPs), and preference memories.
-- Phase 1: episodic only. Semantic activates in Phase 2 with outcome data.

CREATE TABLE IF NOT EXISTS context_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_type     text NOT NULL CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'preference')),
  entity_type     text CHECK (entity_type IN ('caregiver', 'client', 'system')),
  entity_id       uuid,
  content         text NOT NULL,
  confidence      real DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source          text DEFAULT 'ai_observation' CHECK (source IN ('ai_observation', 'user_correction', 'outcome_analysis', 'manual')),
  tags            text[] DEFAULT '{}',
  created_at      timestamptz DEFAULT now(),
  expires_at      timestamptz,
  superseded_by   uuid REFERENCES context_memory(id)
);

-- Indexes for fast context assembly queries
CREATE INDEX IF NOT EXISTS idx_context_memory_entity
  ON context_memory (entity_type, entity_id)
  WHERE superseded_by IS NULL;

-- Note: now() removed from predicate (not IMMUTABLE); expiry filtering done at query time
CREATE INDEX IF NOT EXISTS idx_context_memory_type
  ON context_memory (memory_type)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_context_memory_tags
  ON context_memory USING gin (tags)
  WHERE superseded_by IS NULL;


-- ── 2. Events (Unified Event Bus) ──
-- Single stream of everything that happens in the system.
-- Replaces scattered logging across notes, automation_log, inbound_sms_log.

CREATE TABLE IF NOT EXISTS events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  entity_type     text CHECK (entity_type IN ('caregiver', 'client')),
  entity_id       uuid,
  actor           text NOT NULL DEFAULT 'system',
  payload         jsonb DEFAULT '{}',
  created_at      timestamptz DEFAULT now()
);

-- Indexes for event queries
CREATE INDEX IF NOT EXISTS idx_events_entity
  ON events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_time
  ON events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_recent
  ON events (created_at DESC);


-- ── 3. Context Snapshots (Session Continuity) ──
-- Stores conversation summaries and active threads between chat sessions.
-- One row per user, upserted at end of each conversation.

CREATE TABLE IF NOT EXISTS context_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  session_summary text,
  active_threads  jsonb DEFAULT '[]',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- One snapshot per user (latest wins)
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_snapshots_user
  ON context_snapshots (user_id);


-- ── Enable RLS (all authenticated users = full access, matching existing pattern) ──

ALTER TABLE context_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_snapshots ENABLE ROW LEVEL SECURITY;

-- Policies: authenticated users get full access (same as other tables)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'context_memory_all' AND tablename = 'context_memory') THEN
    CREATE POLICY context_memory_all ON context_memory FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'events_all' AND tablename = 'events') THEN
    CREATE POLICY events_all ON events FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'context_snapshots_all' AND tablename = 'context_snapshots') THEN
    CREATE POLICY context_snapshots_all ON context_snapshots FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
