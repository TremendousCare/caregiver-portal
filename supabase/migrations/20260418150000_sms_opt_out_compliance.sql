-- ═══════════════════════════════════════════════════════════════
-- SMS Opt-Out / TCPA Compliance
--
-- Adds a global SMS opt-out flag to both `caregivers` and `clients`.
-- The flag is set automatically when a recipient texts STOP (or any
-- of the standard TCPA opt-out keywords) and respected by every
-- outbound SMS path.
--
-- Columns:
--   sms_opted_out         BOOLEAN, default false — the gate itself
--   sms_opted_out_at      TIMESTAMPTZ — when they opted out
--   sms_opted_out_source  TEXT — 'keyword', 'admin', 'manual'
--                                so we can distinguish auto vs manual
--
-- All columns are nullable / defaulted so existing rows continue to
-- work and no code needs to pre-populate them.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_opted_out_source TEXT;
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_opted_out_source TEXT;
-- Indexes so the admin "SMS Opt-Outs" list view and the outbound
-- gate lookup stay fast as the tables grow.
CREATE INDEX IF NOT EXISTS idx_caregivers_sms_opted_out
  ON caregivers (sms_opted_out)
  WHERE sms_opted_out = true;
CREATE INDEX IF NOT EXISTS idx_clients_sms_opted_out
  ON clients (sms_opted_out)
  WHERE sms_opted_out = true;
