-- ═══════════════════════════════════════════════════════════════
-- Multiple Boards Support
--
-- Adds boards + board_cards tables to support Trello-style
-- multiple Kanban boards. Each board has its own columns, labels,
-- checklist templates, and cards.
-- ═══════════════════════════════════════════════════════════════

-- ─── Boards table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  entity_type text NOT NULL DEFAULT 'caregiver',  -- 'caregiver', 'client', 'custom'
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  checklist_templates jsonb NOT NULL DEFAULT '[]'::jsonb,
  orientation_data jsonb DEFAULT '{}'::jsonb,
  sort_order integer DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ─── Board Cards table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  entity_type text NOT NULL DEFAULT 'caregiver',
  entity_id text NOT NULL,           -- references caregivers.id or clients.id
  column_id text,                    -- references a column id within the board's columns jsonb
  sort_order integer DEFAULT 0,
  labels jsonb DEFAULT '[]'::jsonb,  -- array of label ids from the board's labels
  checklists jsonb DEFAULT '[]'::jsonb,
  due_date date,
  description text,
  pinned_note text,
  moved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(board_id, entity_id)
);

-- ─── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_board_cards_board_id ON board_cards(board_id);
CREATE INDEX IF NOT EXISTS idx_board_cards_entity_id ON board_cards(entity_id);
CREATE INDEX IF NOT EXISTS idx_boards_slug ON boards(slug);

-- ─── RLS Policies ───────────────────────────────────────────
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_cards ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read/write boards
CREATE POLICY "boards_all" ON boards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "board_cards_all" ON board_cards FOR ALL USING (true) WITH CHECK (true);

-- ─── Updated_at trigger ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Only create triggers if they don't exist (safe for re-runs)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'boards_updated_at') THEN
    CREATE TRIGGER boards_updated_at BEFORE UPDATE ON boards
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'board_cards_updated_at') THEN
    CREATE TRIGGER board_cards_updated_at BEFORE UPDATE ON board_cards
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END;
$$;

-- ─── Enable Realtime ────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE boards;
ALTER PUBLICATION supabase_realtime ADD TABLE board_cards;
