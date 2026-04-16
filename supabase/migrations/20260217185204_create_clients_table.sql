
-- Create clients table for the Client Pipeline module
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  -- Contact info
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  -- Client-specific fields
  contact_name TEXT DEFAULT '',
  relationship TEXT DEFAULT '',
  care_recipient_name TEXT DEFAULT '',
  care_recipient_age TEXT DEFAULT '',
  care_needs TEXT DEFAULT '',
  hours_needed TEXT DEFAULT '',
  start_date_preference TEXT DEFAULT '',
  budget_range TEXT DEFAULT '',
  insurance_info TEXT DEFAULT '',
  referral_source TEXT DEFAULT '',
  referral_detail TEXT DEFAULT '',
  -- Pipeline
  phase TEXT DEFAULT 'new_lead',
  phase_timestamps JSONB DEFAULT '{}'::jsonb,
  tasks JSONB DEFAULT '{}'::jsonb,
  notes JSONB DEFAULT '[]'::jsonb,
  -- Sequences
  active_sequences JSONB DEFAULT '[]'::jsonb,
  -- Status
  lost_reason TEXT DEFAULT '',
  lost_detail TEXT DEFAULT '',
  assigned_to TEXT DEFAULT '',
  priority TEXT DEFAULT 'normal',
  -- Archive
  archived BOOLEAN DEFAULT false,
  archived_at BIGINT,
  archive_reason TEXT,
  archive_detail TEXT,
  -- Timestamps
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT
);

-- RLS
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access on clients" ON clients
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Indexes
CREATE INDEX IF NOT EXISTS idx_clients_phase ON clients(phase);
CREATE INDEX IF NOT EXISTS idx_clients_created ON clients(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_assigned ON clients(assigned_to);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE clients;
