
-- Remove permissive write policies
DROP POLICY IF EXISTS "Authenticated users can update app_settings" ON app_settings;
DROP POLICY IF EXISTS "Authenticated users can insert app_settings" ON app_settings;

-- Replace with admin-only write policies
CREATE POLICY "admins_update_app_settings" ON app_settings FOR UPDATE
  USING (EXISTS (SELECT 1 FROM user_roles WHERE email = lower(auth.jwt()->>'email') AND role = 'admin'));

CREATE POLICY "admins_insert_app_settings" ON app_settings FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE email = lower(auth.jwt()->>'email') AND role = 'admin'));
