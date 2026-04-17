ALTER TABLE docusign_envelopes
  DROP CONSTRAINT docusign_envelopes_caregiver_id_fkey,
  ADD CONSTRAINT docusign_envelopes_caregiver_id_fkey
    FOREIGN KEY (caregiver_id) REFERENCES caregivers(id) ON DELETE CASCADE;
