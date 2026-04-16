
CREATE TABLE IF NOT EXISTS user_roles (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);

-- Seed initial admins
INSERT INTO user_roles (email, role) VALUES
  ('chrisnash@tremendouscareca.com', 'admin'),
  ('kevinnash@tremendouscareca.com', 'admin'),
  ('blertanash@tremendouscareca.com', 'admin'),
  ('nashkevi1@gmail.com', 'admin')
ON CONFLICT (email) DO UPDATE SET role = 'admin';

-- RLS
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read (needed to check own role)
CREATE POLICY "authenticated_read_user_roles"
  ON user_roles FOR SELECT
  USING (auth.role() = 'authenticated');

-- Users can self-register as member (auto-insert on first login)
CREATE POLICY "self_register_as_member"
  ON user_roles FOR INSERT
  WITH CHECK (
    email = lower(auth.jwt()->>'email')
    AND role = 'member'
  );

-- Admins can update any role
CREATE POLICY "admins_update_user_roles"
  ON user_roles FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE email = lower(auth.jwt()->>'email') AND role = 'admin')
  );

-- Admins can insert new roles (for pre-seeding users)
CREATE POLICY "admins_insert_user_roles"
  ON user_roles FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE email = lower(auth.jwt()->>'email') AND role = 'admin')
  );
