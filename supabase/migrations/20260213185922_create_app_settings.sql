
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read app_settings"
  ON app_settings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update app_settings"
  ON app_settings FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert app_settings"
  ON app_settings FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Also allow service role (Edge Functions)
CREATE POLICY "Service role full access to app_settings"
  ON app_settings FOR ALL
  TO service_role
  USING (true);
