ALTER TABLE public.docusign_envelopes
ADD COLUMN IF NOT EXISTS documents_uploaded_detail jsonb DEFAULT '[]'::jsonb;
