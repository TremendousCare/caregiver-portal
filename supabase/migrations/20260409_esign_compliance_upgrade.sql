-- ─── E-Signature Compliance Upgrade ───
-- Brings custom eSign system to DocuSign-level legal compliance.
-- Adds: consent tracking, decline with reason, uploaded doc IDs,
-- completion certificate tracking, and enhanced audit capabilities.

-- ─── 1. Consent Tracking (ESIGN Act compliance) ───
-- Records exactly when and from where the signer accepted e-signature consent.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_timestamp timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_ip text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS consent_user_agent text;

-- ─── 2. Decline with Reason ───
-- Allows signers to formally decline and explain why (DocuSign parity).
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS decline_reason text;

-- ─── 3. Uploaded Document IDs ───
-- Stores actual SharePoint doc IDs for reliable matching (replaces fragile filename matching).
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS uploaded_doc_ids jsonb DEFAULT '[]'::jsonb;

-- ─── 4. Per-document Hashes ───
-- Stores individual document hashes (not just combined) for tamper evidence per document.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS document_hashes jsonb DEFAULT '[]'::jsonb;

-- ─── 5. Completion Certificate ───
-- URL of the generated Certificate of Completion PDF.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS completion_certificate_doc_id text;

-- ─── 6. Sender notification tracking ───
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS sender_notified boolean NOT NULL DEFAULT false;
