-- ─── eSign Compliance Upgrade ───
-- Adds ESIGN Act compliance, Certificate of Completion, decline flow,
-- reliable document matching, and completion notifications.
-- All columns are nullable to maintain backward compatibility.

-- 1. ESIGN Act consent tracking
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_timestamp timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_ip text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_user_agent text;

-- 2. Decline with reason
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS decline_reason text;

-- 3. Reliable document matching (stores actual SharePoint doc IDs)
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS uploaded_doc_ids text[] DEFAULT '{}';

-- 4. Per-document SHA-256 hashes for tamper evidence
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS document_hashes jsonb DEFAULT '{}';

-- 5. Certificate of Completion reference
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS completion_certificate_doc_id text;

-- 6. Sender notification tracking
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS sender_notified boolean DEFAULT false;
