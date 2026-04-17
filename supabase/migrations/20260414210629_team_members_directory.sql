-- ═══════════════════════════════════════════════════════════════
-- Team Members Directory — Phase 1 of role-based communication routing
--
-- Purpose:
--   Create a new `team_members` table that holds the full employee
--   directory (name, job title, personal phone, etc.) so the Admin
--   Settings page has a place to enter and manage employees.
--
-- Safety notes:
--   - This migration is PURELY ADDITIVE. It creates one new table.
--   - The existing `user_roles` table is NOT touched, renamed, or
--     dropped. Existing access-control code keeps working unchanged.
--   - Nothing reads from `team_members` yet other than the new
--     Admin Settings UI section added in the same PR.
--   - RLS is enabled: any authenticated user can read, only admins
--     (as defined in user_roles) can write.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS team_members (
  email              TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  job_title          TEXT,
  personal_phone     TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         TEXT
);

-- Fast lookup of active employees (used by UI list + future routing UIs)
CREATE INDEX IF NOT EXISTS idx_team_members_active
  ON team_members (is_active)
  WHERE is_active = true;

-- ─── Row Level Security ──────────────────────────────────────
-- Read: any authenticated user (directory is visible to the team)
-- Write: only admins (as determined by the existing user_roles table)

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read team_members"
  ON team_members FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert team_members"
  ON team_members FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update team_members"
  ON team_members FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete team_members"
  ON team_members FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE email = auth.jwt() ->> 'email' AND role = 'admin'
    )
  );
