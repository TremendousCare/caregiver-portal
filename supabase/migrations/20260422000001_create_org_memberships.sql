-- Phase A — Auth foundation: org_memberships table + backfill.
-- Additive only. Does not modify user_roles or caregivers.
-- Part of the SaaS retrofit; see docs/SAAS_RETROFIT.md.

CREATE TABLE IF NOT EXISTS public.org_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'member', 'caregiver')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id ON public.org_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org_id  ON public.org_memberships (org_id);

-- ── Backfill ────────────────────────────────────────────────
-- Staff first, so an admin who also happens to have a caregiver
-- profile keeps their staff role at the membership level. The
-- existing caregiver-PWA redirect in AppContext is unaffected by
-- this ordering.
--
-- user_roles keys on email; join auth.users on lower(email). Any
-- user_roles row with no matching auth.users entry is skipped
-- silently — those emails are not logged-in users anyway.
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT
  (SELECT id FROM public.organizations WHERE slug = 'tremendous-care'),
  u.id,
  ur.role
FROM public.user_roles ur
JOIN auth.users u ON lower(u.email) = lower(ur.email)
WHERE ur.role IN ('admin', 'member')
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Then caregivers. Conflict = user already has a staff row → skip.
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT
  (SELECT id FROM public.organizations WHERE slug = 'tremendous-care'),
  c.user_id,
  'caregiver'
FROM public.caregivers c
WHERE c.user_id IS NOT NULL
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ── RLS ─────────────────────────────────────────────────────
-- A user may read only their own membership rows. No client
-- writes during Phase A; service_role handles provisioning.
ALTER TABLE public.org_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_memberships"
  ON public.org_memberships FOR SELECT
  USING (user_id = auth.uid());
