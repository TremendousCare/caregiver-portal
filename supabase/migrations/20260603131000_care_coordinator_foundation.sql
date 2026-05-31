-- ═══════════════════════════════════════════════════════════════
-- Care Coordinator Agent — M1: data foundation
--
-- Two new tables for the Change-of-Condition Detector. Additive and
-- behavior-neutral: no code reads or writes these yet (the detector
-- lands in M2). Full design: docs/CARE_COORDINATOR_AGENT.md.
--
--   1. care_signals
--      The detector's triage worklist. One row per detected
--      change-of-condition cluster for a client. Carries the severity,
--      the Stop-and-Watch categories that fired, a nurse-ready SBAR
--      draft, and the exact observation rows that triggered it
--      (traceability). Dispositioned by office staff (ack / dismiss /
--      actioned / spin-off into a follow-up task).
--
--   2. client_health_events
--      The outcome-measurement substrate. Hospitalizations, ED visits,
--      falls, discharges, etc. — captured so the attribution job (M4)
--      can correlate signals -> interventions -> outcomes and the
--      impact dashboard (M5) can report readmission / ACH / ED trends
--      to referral partners. There is no home for this data today.
--
-- Multi-tenancy: both tables get org_id with the same default-backfill
-- pattern as the rest of the schema (public.default_org_id()), per the
-- "free / non-blocking retrofit hygiene" decision in the design doc.
--
-- Reminder: additive only. No existing data is touched.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. care_signals ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.care_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL DEFAULT public.default_org_id()
                      REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id         text NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- The plan whose baseline the detector reasoned against. SET NULL if
  -- the plan is later removed — the signal is still real history.
  care_plan_id      uuid REFERENCES public.care_plans(id) ON DELETE SET NULL,

  severity          text NOT NULL
                      CHECK (severity IN ('info', 'watch', 'urgent')),
  -- Stop-and-Watch categories that fired, e.g.
  -- ARRAY['ate_less','pain','needs_more_help'].
  categories        text[] NOT NULL DEFAULT '{}',
  summary           text NOT NULL,            -- one-line worklist headline
  -- SBAR draft for the nurse hand-off:
  -- { situation, background, assessment, recommendation }.
  sbar              jsonb,
  -- Traceability: the exact observation rows behind this signal.
  -- [{ observation_id, logged_at, type, rating, note, task_name }]
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The acute window the detector analyzed, for reproducibility.
  window_start      timestamptz,
  window_end        timestamptz,

  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'acknowledged', 'dismissed', 'actioned')),
  disposition_note  text,                     -- why dismissed / what was done
  dispositioned_by  text,
  dispositioned_at  timestamptz,
  -- Set when a staff member spins a follow-up task off this signal (M3).
  follow_up_task_id uuid REFERENCES public.follow_up_tasks(id) ON DELETE SET NULL,
  -- Soft link to a client_health_event later attributed to this signal
  -- (M4). Intentionally not a hard FK to avoid a circular constraint
  -- and keep the attribution job's writes simple.
  outcome_event_id  uuid,

  -- Provenance for prompt A/B and post-hoc QA.
  agent_id          uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  model             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Hot path: the open worklist, highest severity first.
CREATE INDEX IF NOT EXISTS idx_care_signals_open
  ON public.care_signals (org_id, status, severity, created_at DESC);
-- "Signals for this client" — client page panel + dedup lookup.
CREATE INDEX IF NOT EXISTS idx_care_signals_client
  ON public.care_signals (client_id, created_at DESC);


-- ── 2. client_health_events ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_health_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL DEFAULT public.default_org_id()
                         REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id            text NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  event_type           text NOT NULL
                         CHECK (event_type IN (
                           'hospitalization', 'ed_visit', 'fall', 'infection',
                           'hospital_discharge', 'death', 'other')),
  occurred_at          timestamptz NOT NULL,
  -- For 30-day readmission math: the discharge this admission followed.
  related_discharge_id uuid REFERENCES public.client_health_events(id) ON DELETE SET NULL,
  -- Optional clinical judgment: was this potentially avoidable?
  avoidable            boolean,
  -- Filled by the attribution job (M4): did a care signal precede this?
  preceding_signal_id  uuid REFERENCES public.care_signals(id) ON DELETE SET NULL,
  source               text
                         CHECK (source IS NULL OR source IN (
                           'caregiver', 'family', 'office', 'partner')),
  note                 text,
  recorded_by          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- "Health events for this client", newest first — readmission windows
-- and the client-page timeline.
CREATE INDEX IF NOT EXISTS idx_client_health_events_client
  ON public.client_health_events (client_id, occurred_at DESC);
-- Org-scoped reporting sweeps for the impact dashboard (M5).
CREATE INDEX IF NOT EXISTS idx_client_health_events_org_type
  ON public.client_health_events (org_id, event_type, occurred_at DESC);


-- ── Row-Level Security ─────────────────────────────────────────
-- Staff-only for both tables, mirroring care_plan_observations. Family
-- / partner read scopes (if ever needed) ship with the surface that
-- needs them.

ALTER TABLE public.care_signals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_health_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS care_signals_staff_all        ON public.care_signals;
DROP POLICY IF EXISTS client_health_events_staff_all ON public.client_health_events;

CREATE POLICY care_signals_staff_all ON public.care_signals
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

CREATE POLICY client_health_events_staff_all ON public.client_health_events
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());


-- ── Auto-update updated_at triggers ────────────────────────────
-- Reuses public.touch_updated_at() (created in the care-plan schema
-- migration 20260419010000).

DROP TRIGGER IF EXISTS care_signals_touch_updated_at        ON public.care_signals;
DROP TRIGGER IF EXISTS client_health_events_touch_updated_at ON public.client_health_events;

CREATE TRIGGER care_signals_touch_updated_at
  BEFORE UPDATE ON public.care_signals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER client_health_events_touch_updated_at
  BEFORE UPDATE ON public.client_health_events
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
