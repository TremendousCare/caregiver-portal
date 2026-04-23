-- Phase A — Auth foundation: organizations table.
-- Additive only. No existing data touched.
-- Part of the SaaS retrofit; see docs/SAAS_RETROFIT.md and
-- docs/SAAS_RETROFIT_STATUS.md for context.

CREATE TABLE IF NOT EXISTS public.organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON public.organizations (slug);

-- Seed Tremendous Care as org #1 (idempotent on slug).
INSERT INTO public.organizations (slug, name)
VALUES ('tremendous-care', 'Tremendous Care')
ON CONFLICT (slug) DO NOTHING;

-- RLS: readable by any authenticated user (needed so clients can
-- confirm their own org). Write access is service_role only during
-- Phase A; a proper admin policy will be introduced in a later phase.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_organizations"
  ON public.organizations FOR SELECT
  USING (auth.role() = 'authenticated');
