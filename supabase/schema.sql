-- ═══════════════════════════════════════════════════════════════
-- Tremendous Care — Supabase Schema
-- Run this in your Supabase SQL Editor to create the tables.
-- ═══════════════════════════════════════════════════════════════

-- Caregivers table — one row per caregiver
CREATE TABLE IF NOT EXISTS caregivers (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  per_id TEXT DEFAULT '',
  hca_expiration DATE,
  has_hca TEXT DEFAULT 'yes',
  has_dl TEXT DEFAULT 'yes',
  source TEXT DEFAULT '',
  source_detail TEXT DEFAULT '',
  application_date DATE,
  availability TEXT DEFAULT '',
  years_experience TEXT DEFAULT '',
  languages TEXT DEFAULT '',
  specializations TEXT DEFAULT '',
  certifications TEXT DEFAULT '',
  preferred_shift TEXT DEFAULT '',
  initial_notes TEXT DEFAULT '',
  tasks JSONB DEFAULT '{}'::jsonb,
  notes JSONB DEFAULT '[]'::jsonb,
  phase_timestamps JSONB DEFAULT '{}'::jsonb,
  phase_override TEXT,
  board_status TEXT DEFAULT '',
  board_note TEXT DEFAULT '',
  board_moved_at BIGINT,
  archived BOOLEAN DEFAULT false,
  archived_at BIGINT,
  archive_reason TEXT,
  archive_detail TEXT,
  archive_phase TEXT,
  archived_by TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- App-wide key-value store for settings
-- (phase tasks, board columns, orientation data, etc.)
CREATE TABLE IF NOT EXISTS app_data (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
-- For a team tool, we allow all authenticated users full access.
ALTER TABLE caregivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

-- Policies: restrict to authenticated users only (Supabase Auth)
-- Drop old wide-open policies first (safe to run even if they don't exist)
DROP POLICY IF EXISTS "Allow all access" ON caregivers;
DROP POLICY IF EXISTS "Allow all access" ON app_data;

-- Authenticated users get full CRUD access (team tool — all team members equal)
CREATE POLICY "Authenticated full access" ON caregivers
  FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated full access" ON app_data
  FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_caregivers_created ON caregivers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caregivers_board ON caregivers(board_status);
