-- Active Roster v12.0: Add employment lifecycle fields
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status TEXT DEFAULT 'onboarding';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status_changed_at BIGINT;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS employment_status_changed_by TEXT;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS availability_type TEXT DEFAULT '';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS current_assignment TEXT DEFAULT '';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS cpr_expiry_date DATE;

-- Index for fast roster queries
CREATE INDEX IF NOT EXISTS idx_caregivers_employment_status ON caregivers (employment_status);
