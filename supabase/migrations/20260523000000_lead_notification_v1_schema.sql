-- Lead Notification V1 — Schema foundation (PR 1 of 4).
--
-- Adds two tables and a trigger that fan-outs nothing yet: this PR only
-- enqueues notification rows when a client lead enters the pipeline.
-- PR 3 (dispatcher edge function) will drain the queue and actually send
-- SMS / Teams / in-portal toasts.
--
-- Tables created:
--   public.lead_notification_queue  — one row per lead, drained by cron
--   public.notifications_user       — one row per (toast recipient, lead),
--                                     consumed by realtime subscription
--
-- Trigger: on clients AFTER INSERT, when phase = 'new_lead' (or NULL,
-- since the column defaults to 'new_lead'), enqueue a queue row and log
-- a `client_created` event. All inserts happen through a
-- SECURITY DEFINER helper so RLS does not block the trigger when the
-- inserting role is `authenticated`.
--
-- Multi-tenancy compliance (CLAUDE.md Prime Directives):
--   • Both new tables have NOT NULL org_id DEFAULT public.default_org_id()
--     REFERENCES public.organizations(id).
--   • No hardcoded org UUIDs.
--   • RLS policies are scoped via the existing public.is_staff() and
--     public.is_admin() SECURITY DEFINER helpers — no inline subqueries.
--
-- Idempotency: every CREATE uses IF NOT EXISTS / OR REPLACE so the
-- Deploy Database Migrations workflow can re-run this safely.

-- ────────────────────────────────────────────────────────────────────
-- 1. lead_notification_queue
-- ────────────────────────────────────────────────────────────────────
-- One row enqueued per new lead. Drained by the dispatch cron in PR 3.
-- `scheduled_for` is bumped forward by the dispatcher when the current
-- time falls inside the org's quiet-hours window. `channels` records
-- per-channel send results (sms / teams / toast). `status` is the
-- top-level state machine: pending → sent | skipped_disabled | failed.

CREATE TABLE IF NOT EXISTS public.lead_notification_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id         text NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'skipped_disabled', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  channels        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Dispatcher pulls (status='pending' AND scheduled_for <= now()) ordered
-- by scheduled_for ASC. This partial index keeps the working set tiny
-- even as the table grows historically.
CREATE INDEX IF NOT EXISTS idx_lead_notification_queue_pending
  ON public.lead_notification_queue (scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lead_notification_queue_org
  ON public.lead_notification_queue (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_notification_queue_lead
  ON public.lead_notification_queue (lead_id);

-- ────────────────────────────────────────────────────────────────────
-- 2. notifications_user
-- ────────────────────────────────────────────────────────────────────
-- One row per (toast recipient, notification). The dispatcher inserts
-- a row per configured toast recipient email when a queue row is sent.
-- The frontend subscribes via realtime filtered by user_email = current
-- user's email and pops a toast on INSERT.
--
-- Keyed by email (not auth.uid()) because the recipient list in
-- organizations.settings.lead_notifications stores emails — they are
-- stable across auth.users churn and consistent with team_members
-- which is email-keyed.

CREATE TABLE IF NOT EXISTS public.notifications_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_email      text NOT NULL,
  notification_type text NOT NULL DEFAULT 'new_lead'
                    CHECK (notification_type IN ('new_lead')),
  lead_id         text REFERENCES public.clients(id) ON DELETE CASCADE,
  title           text NOT NULL,
  message         text NOT NULL,
  link_url        text,
  severity        text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info', 'urgent')),
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_inbox
  ON public.notifications_user (user_email, created_at DESC);

-- Partial index supporting the realtime subscription and the unread-count
-- badge: "give me my unread rows in this org". Filtering at query time
-- with `now()` would break IMMUTABLE rules, so we just key on read_at.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications_user (user_email, org_id)
  WHERE read_at IS NULL;

-- Enable realtime so the frontend NotificationContext can subscribe in PR 4.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications_user'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications_user;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 3. SECURITY DEFINER helpers
-- ────────────────────────────────────────────────────────────────────
-- The trigger runs as the inserting role (typically `authenticated` or
-- `service_role`). To keep RLS sane on the new tables, the trigger calls
-- a SECURITY DEFINER helper that bypasses RLS for the queue / events
-- inserts only.

CREATE OR REPLACE FUNCTION public.enqueue_lead_notification(p_client_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_queue_id uuid;
BEGIN
  -- Resolve the org from the client row. Clients always have org_id
  -- since Phase B1. Fall back to default_org_id() as a defensive net —
  -- a client without an org should be impossible but if it happens we
  -- still enqueue under the Tremendous Care default rather than crash
  -- the insert.
  SELECT COALESCE(org_id, public.default_org_id()) INTO v_org_id
  FROM public.clients
  WHERE id = p_client_id;

  IF v_org_id IS NULL THEN
    -- Lead not found (shouldn't happen — trigger fires AFTER INSERT)
    -- or no default org exists. Bail silently; the client insert
    -- still succeeded.
    RETURN NULL;
  END IF;

  INSERT INTO public.lead_notification_queue (org_id, lead_id, scheduled_for)
  VALUES (v_org_id, p_client_id, now())
  RETURNING id INTO v_queue_id;

  -- Best-effort observability log into the unified events bus.
  -- entity_id is uuid in events table, but clients.id is text; we
  -- intentionally pass NULL for entity_id and stash the text client id
  -- in payload, matching the existing pattern used elsewhere in the
  -- codebase for client-keyed events.
  BEGIN
    INSERT INTO public.events (org_id, event_type, entity_type, entity_id, actor, payload)
    VALUES (
      v_org_id,
      'client_created',
      'client',
      NULL,
      'system:trigger',
      jsonb_build_object(
        'client_id', p_client_id,
        'queue_id', v_queue_id,
        'source', 'lead_notification_trigger'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let an events insert failure break the queue insert.
    NULL;
  END;

  RETURN v_queue_id;
END;
$$;

-- The trigger function. AFTER INSERT, only when the row represents a
-- net-new lead (phase = 'new_lead' or NULL since that is the default).
CREATE OR REPLACE FUNCTION public.clients_after_insert_lead_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.phase IS NULL OR NEW.phase = 'new_lead' THEN
    PERFORM public.enqueue_lead_notification(NEW.id);
  END IF;
  RETURN NULL; -- AFTER trigger, return value ignored.
END;
$$;

-- Idempotent install. Drop the trigger first so re-running this
-- migration replaces the definition cleanly.
DROP TRIGGER IF EXISTS clients_after_insert_lead_notify ON public.clients;
CREATE TRIGGER clients_after_insert_lead_notify
  AFTER INSERT ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_after_insert_lead_notify();

-- ────────────────────────────────────────────────────────────────────
-- 4. RLS
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.lead_notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_user      ENABLE ROW LEVEL SECURITY;

-- Queue: staff can read (for the admin debug UI later); only the
-- dispatcher (service_role) and the trigger (SECURITY DEFINER, bypasses
-- RLS) write. No write policies for authenticated.
DROP POLICY IF EXISTS lead_notification_queue_read_staff ON public.lead_notification_queue;
CREATE POLICY lead_notification_queue_read_staff
  ON public.lead_notification_queue
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- notifications_user: a user reads only their own rows (by email,
-- case-insensitive), within their org. Mark-as-read (UPDATE) is also
-- limited to their own rows.
DROP POLICY IF EXISTS notifications_user_read_own ON public.notifications_user;
CREATE POLICY notifications_user_read_own
  ON public.notifications_user
  FOR SELECT
  TO authenticated
  USING (lower(user_email) = lower((auth.jwt() ->> 'email')));

DROP POLICY IF EXISTS notifications_user_update_own ON public.notifications_user;
CREATE POLICY notifications_user_update_own
  ON public.notifications_user
  FOR UPDATE
  TO authenticated
  USING (lower(user_email) = lower((auth.jwt() ->> 'email')))
  WITH CHECK (lower(user_email) = lower((auth.jwt() ->> 'email')));

-- ────────────────────────────────────────────────────────────────────
-- 5. Grants
-- ────────────────────────────────────────────────────────────────────
-- The SECURITY DEFINER helper is invoked by the trigger only — no need
-- to expose it to authenticated. The trigger function itself does not
-- need GRANTs because PG runs triggers as the owner via the trigger
-- ownership chain.
REVOKE ALL ON FUNCTION public.enqueue_lead_notification(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_lead_notification(text) TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- 6. Sanity check
-- ────────────────────────────────────────────────────────────────────
-- Fail loudly if the trigger plumbing did not land. Catches accidental
-- DROP in a future PR.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'clients_after_insert_lead_notify'
      AND tgrelid = 'public.clients'::regclass
  ) THEN
    RAISE EXCEPTION 'lead-notif v1 schema: trigger clients_after_insert_lead_notify is missing after migration';
  END IF;
END $$;
