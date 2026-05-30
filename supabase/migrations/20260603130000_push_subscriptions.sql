-- ═══════════════════════════════════════════════════════════════
-- push_subscriptions — Web Push endpoints for caregiver shift reminders
--
-- Stores one row per installed-PWA push subscription. The caregiver app
-- registers a subscription (endpoint + p256dh + auth keys) after the
-- caregiver opts in; the send-push / shift-reminders edge functions read
-- these rows (service_role) and deliver Web Push notifications.
--
-- Multi-tenancy: org_id is included per the prime directive (every new
-- table gets it). Because this is a brand-new, empty table we can add it
-- NOT NULL with a DEFAULT of public.default_org_id() directly — no
-- backfill step is needed. RLS below scopes rows to the owning caregiver
-- (mirroring clock_events / caregiver_assignments, which gate on
-- current_user_caregiver_id() rather than org_id); the org_id filter is
-- added in the Phase B2 RLS sweep alongside its sibling caregiver tables.
--
-- All additive. Idempotent (IF NOT EXISTS throughout).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL DEFAULT public.default_org_id()
                  REFERENCES public.organizations(id),
  caregiver_id  text NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  -- The push service endpoint uniquely identifies a subscription. UNIQUE
  -- so re-subscribing the same browser upserts rather than duplicates.
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when a push send returns 404/410 (subscription expired) so the
  -- sender can skip it without deleting the audit row.
  disabled_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_caregiver
  ON push_subscriptions (caregiver_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_org_id
  ON push_subscriptions (org_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Staff: full access (mirrors the staff_all pattern on caregiver tables).
DROP POLICY IF EXISTS push_subscriptions_staff_all ON push_subscriptions;
CREATE POLICY push_subscriptions_staff_all ON push_subscriptions
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Caregiver: manage only their own subscriptions. Mirrors the
-- current_user_caregiver_id() gating used by clock_events_read_own etc.
DROP POLICY IF EXISTS push_subscriptions_own_select ON push_subscriptions;
CREATE POLICY push_subscriptions_own_select ON push_subscriptions
  FOR SELECT TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id());

DROP POLICY IF EXISTS push_subscriptions_own_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_own_insert ON push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (caregiver_id = public.current_user_caregiver_id());

DROP POLICY IF EXISTS push_subscriptions_own_update ON push_subscriptions;
CREATE POLICY push_subscriptions_own_update ON push_subscriptions
  FOR UPDATE TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id())
  WITH CHECK (caregiver_id = public.current_user_caregiver_id());

DROP POLICY IF EXISTS push_subscriptions_own_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_own_delete ON push_subscriptions
  FOR DELETE TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id());
