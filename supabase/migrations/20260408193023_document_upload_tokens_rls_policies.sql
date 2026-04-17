-- Allow authenticated users (staff) to insert and read upload tokens
CREATE POLICY "Authenticated users can insert tokens"
  ON document_upload_tokens FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read tokens"
  ON document_upload_tokens FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update tokens"
  ON document_upload_tokens FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
