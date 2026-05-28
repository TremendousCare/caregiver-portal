-- ═══════════════════════════════════════════════════════════════
-- Executive Task Management — Phase 1 PR 1, Migration 3 of 4
--
-- Five tables that together implement the executive layer:
--
--   exec_task_templates  ─ blueprints for repeating or anchored
--                          executive work (30-day check-in,
--                          monthly P&L review, annual HIPAA audit).
--   exec_tasks           ─ concrete instances generated from a
--                          template OR created ad-hoc. Carries the
--                          structured-response payload that turns
--                          a checkmark into a durable record.
--   exec_goals           ─ Objectives in an OKR framework. One
--                          per "thing we're trying to accomplish
--                          this quarter."
--   exec_key_results     ─ Measurable progress markers under an
--                          Objective. Numeric, with a target and a
--                          confidence chip.
--   exec_goal_checkins   ─ Weekly KR check-in log. Append-only
--                          history of value + confidence + note.
--
-- Visibility matrix (locked with owner 2026-05-28):
--   Table                  owner    admin     member/caregiver
--   ────────────────────────────────────────────────────────────
--   exec_task_templates   R/W       —         —
--   exec_tasks            R/W       —         —
--   exec_goals            R/W       R (read)  —
--   exec_key_results      R/W       R (read)  —
--   exec_goal_checkins    R/W       R (read)  —
--
-- Rationale for admin read-only on goals: alignment. Office admin
-- should know what the quarterly priorities are so their daily
-- choices roll up. They should not be able to edit, set, or check
-- in goals — that's an owner act.
--
-- RLS implementation: every policy uses public.is_owner() or
-- public.is_admin() (both STABLE SECURITY DEFINER per
-- docs/RLS_GOTCHAS.md) PLUS an org_id JWT check. No inline EXISTS.
--
-- Multi-tenancy: every table has org_id NOT NULL with FK +
-- default_org_id() default. Same shape as follow_up_tasks v1.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. exec_task_templates
-- ────────────────────────────────────────────────────────────────────
-- The blueprint. Most templates ship inactive (active=false) so the
-- owner enables them one by one in the UI rather than getting a
-- backlog of generated tasks the first day they log in.
--
-- anchor_type enum:
--   'hire_date'   — generator computes due_at as
--                   (staff_members.hire_date + offset_days) for each
--                   active staff member; idempotent via the
--                   uq_exec_tasks_lifecycle partial unique index.
--                   Use for 30/60/90, anniversary review, etc.
--   'fixed_date'  — recurring on a clock cadence (monthly,
--                   quarterly, annually). next_fire_at is the next
--                   wall-clock date the generator should spawn an
--                   instance for; recurrence_interval_days is how
--                   far to bump it after firing. Approximate but
--                   matches the follow_up_templates pattern; cron
--                   precision can come later if needed.
--   'manual'      — owner creates instances by hand from the
--                   template (e.g. "ad-hoc executive checklist").
--                   No automatic generation.
--
-- structured_questions: ordered JSON array, schema per element:
--   { id: text, label: text, type: 'rating_1_5'|'short_text'|
--     'long_text'|'yes_no'|'single_select'|'number'|'date',
--     options?: text[], required?: boolean }
-- Owner edits this in the Templates UI (Phase 3). Empty array = no
-- structured form, just a free-text completion note.

CREATE TABLE IF NOT EXISTS public.exec_task_templates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL DEFAULT public.default_org_id()
                                REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug                        text NOT NULL,
  name                        text NOT NULL,
  description                 text,
  guidance                    text,
  category                    text NOT NULL
                                CHECK (category IN ('lifecycle', 'recurring', 'ad_hoc')),
  anchor_type                 text NOT NULL DEFAULT 'manual'
                                CHECK (anchor_type IN ('hire_date', 'fixed_date', 'manual')),
  offset_days                 integer
                                CHECK (offset_days IS NULL OR offset_days >= 0),
  recurrence_interval_days    integer
                                CHECK (recurrence_interval_days IS NULL
                                       OR recurrence_interval_days > 0),
  next_fire_at                timestamptz,
  structured_questions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_assignee_email      text,
  default_urgency             text NOT NULL DEFAULT 'warning'
                                CHECK (default_urgency IN ('critical', 'warning', 'info')),
  visibility                  text NOT NULL DEFAULT 'owner'
                                CHECK (visibility IN ('owner', 'admin')),
  active                      boolean NOT NULL DEFAULT false,
  sort_order                  integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  -- Anchor-type / column-presence consistency. Enforced at the DB
  -- layer so a bad UI doesn't leave a "lifecycle" template with no
  -- offset_days, or a "fixed_date" template with no recurrence.
  CHECK (
    (anchor_type = 'hire_date' AND offset_days IS NOT NULL)
    OR (anchor_type = 'fixed_date' AND recurrence_interval_days IS NOT NULL)
    OR (anchor_type = 'manual')
  )
);

CREATE INDEX IF NOT EXISTS idx_exec_task_templates_org
  ON public.exec_task_templates (org_id);
CREATE INDEX IF NOT EXISTS idx_exec_task_templates_active
  ON public.exec_task_templates (org_id, anchor_type, active)
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_exec_task_templates_fire_due
  ON public.exec_task_templates (org_id, next_fire_at)
  WHERE active AND anchor_type = 'fixed_date' AND next_fire_at IS NOT NULL;

DROP TRIGGER IF EXISTS exec_task_templates_touch_updated_at
  ON public.exec_task_templates;
CREATE TRIGGER exec_task_templates_touch_updated_at
  BEFORE UPDATE ON public.exec_task_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. exec_tasks
-- ────────────────────────────────────────────────────────────────────
-- Concrete instances. Idempotency depends on category:
--
--   lifecycle  → UNIQUE (template_id, anchor_staff_email, anchor_date)
--                so the generator doesn't double-spawn a 30-day
--                check-in for the same hire when run twice.
--   recurring  → UNIQUE (template_id, recurrence_period) where
--                recurrence_period is a normalized period string
--                ('2026-06' for monthly, '2026-Q2' for quarterly,
--                '2026' for annual).
--   ad_hoc     → no uniqueness; the owner can create as many as
--                they want.
--
-- Both constraints are partial unique indexes (below) so each
-- category has the right shape without blocking the others.

CREATE TABLE IF NOT EXISTS public.exec_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL DEFAULT public.default_org_id()
                          REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id           uuid REFERENCES public.exec_task_templates(id) ON DELETE SET NULL,
  title                 text NOT NULL,
  description           text,
  category              text NOT NULL
                          CHECK (category IN ('lifecycle', 'recurring', 'ad_hoc')),
  visibility            text NOT NULL DEFAULT 'owner'
                          CHECK (visibility IN ('owner', 'admin')),
  assigned_to           text,
  due_at                timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'in_progress', 'done',
                                            'snoozed', 'cancelled')),
  urgency               text NOT NULL DEFAULT 'warning'
                          CHECK (urgency IN ('critical', 'warning', 'info')),
  -- Lifecycle anchor (NULL for non-lifecycle categories)
  anchor_staff_email    text,
  anchor_date           date,
  -- Recurring anchor (NULL for non-recurring categories)
  recurrence_period     text,
  -- Completion payload
  completed_at          timestamptz,
  completed_by          text,
  completion_notes      text,
  structured_responses  jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome               text
                          CHECK (outcome IS NULL
                                 OR outcome IN ('on_track', 'needs_support', 'concern')),
  -- Snooze / cancel
  snoozed_until         timestamptz,
  cancellation_reason   text,
  -- Audit
  generated_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Category-anchor presence consistency
  CHECK (
    (category = 'lifecycle' AND anchor_staff_email IS NOT NULL AND anchor_date IS NOT NULL)
    OR (category = 'recurring' AND recurrence_period IS NOT NULL)
    OR (category = 'ad_hoc')
  )
);

-- Idempotency: lifecycle instances dedupe on (template, staff, anchor_date).
CREATE UNIQUE INDEX IF NOT EXISTS uq_exec_tasks_lifecycle
  ON public.exec_tasks (template_id, anchor_staff_email, anchor_date)
  WHERE category = 'lifecycle' AND template_id IS NOT NULL;

-- Idempotency: recurring instances dedupe on (template, period).
CREATE UNIQUE INDEX IF NOT EXISTS uq_exec_tasks_recurring
  ON public.exec_tasks (template_id, recurrence_period)
  WHERE category = 'recurring' AND template_id IS NOT NULL;

-- Hot path: "what's on my desk this week"
CREATE INDEX IF NOT EXISTS idx_exec_tasks_due_at
  ON public.exec_tasks (org_id, due_at)
  WHERE status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_exec_tasks_assigned
  ON public.exec_tasks (org_id, assigned_to, status, due_at)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exec_tasks_template
  ON public.exec_tasks (template_id)
  WHERE template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_exec_tasks_org
  ON public.exec_tasks (org_id);

DROP TRIGGER IF EXISTS exec_tasks_touch_updated_at ON public.exec_tasks;
CREATE TRIGGER exec_tasks_touch_updated_at
  BEFORE UPDATE ON public.exec_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 3. exec_goals (Objectives)
-- ────────────────────────────────────────────────────────────────────
-- Quarter is text ('2026-Q2') rather than a calendar range because
-- the UI groups by quarter, and storing the text removes the need
-- for off-by-one date math at every join. start_date / end_date
-- are still present for filters and reports.
--
-- parent_goal_id supports later cascading (Company → Department →
-- Individual); for v1 every goal is top-level and parent_goal_id
-- stays NULL.

CREATE TABLE IF NOT EXISTS public.exec_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  owner_email     text NOT NULL,
  quarter         text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'achieved',
                                      'missed', 'cancelled')),
  parent_goal_id  uuid REFERENCES public.exec_goals(id) ON DELETE SET NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_exec_goals_org_quarter
  ON public.exec_goals (org_id, quarter, sort_order);
CREATE INDEX IF NOT EXISTS idx_exec_goals_owner
  ON public.exec_goals (org_id, owner_email, status);
CREATE INDEX IF NOT EXISTS idx_exec_goals_parent
  ON public.exec_goals (parent_goal_id)
  WHERE parent_goal_id IS NOT NULL;

DROP TRIGGER IF EXISTS exec_goals_touch_updated_at ON public.exec_goals;
CREATE TRIGGER exec_goals_touch_updated_at
  BEFORE UPDATE ON public.exec_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 4. exec_key_results
-- ────────────────────────────────────────────────────────────────────
-- A goal has 2-4 KRs (not enforced at DB; that's a UI convention).
-- KRs are numeric — "make customers happier" is not a KR. Examples:
--   - count   : "Close 25 new contracts"
--   - percent : "Hit 95% on-time clock-in"
--   - dollars : "Reach $250k MRR"
--   - rating  : "4.8★ Google review average"
--
-- start_value / current_value / target_value let the UI render
-- progress as (current - start) / (target - start). For decrease
-- KRs (e.g. "cut turnover from 38% to 25%"), the same formula works
-- with direction='decrease' driving the math.
--
-- data_source is text not enum — 'manual' for v1, future-proofed
-- for 'auto:caregivers.phase_history' etc. without a migration.

CREATE TABLE IF NOT EXISTS public.exec_key_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES public.organizations(id) ON DELETE CASCADE,
  goal_id             uuid NOT NULL REFERENCES public.exec_goals(id) ON DELETE CASCADE,
  title               text NOT NULL,
  description         text,
  owner_email         text NOT NULL,
  metric_unit         text NOT NULL DEFAULT 'count'
                        CHECK (metric_unit IN ('count', 'percent', 'dollars',
                                               'rating', 'other')),
  start_value         numeric NOT NULL DEFAULT 0,
  current_value       numeric NOT NULL DEFAULT 0,
  target_value        numeric NOT NULL,
  direction           text NOT NULL DEFAULT 'increase'
                        CHECK (direction IN ('increase', 'decrease')),
  confidence          text NOT NULL DEFAULT 'green'
                        CHECK (confidence IN ('green', 'yellow', 'red')),
  last_checked_in_at  timestamptz,
  data_source         text NOT NULL DEFAULT 'manual',
  sort_order          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exec_key_results_goal
  ON public.exec_key_results (goal_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_exec_key_results_org
  ON public.exec_key_results (org_id);
CREATE INDEX IF NOT EXISTS idx_exec_key_results_stale
  ON public.exec_key_results (org_id, last_checked_in_at);

DROP TRIGGER IF EXISTS exec_key_results_touch_updated_at ON public.exec_key_results;
CREATE TRIGGER exec_key_results_touch_updated_at
  BEFORE UPDATE ON public.exec_key_results
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 5. exec_goal_checkins
-- ────────────────────────────────────────────────────────────────────
-- Weekly log per KR. week_of is the Monday of the ISO week (UI
-- normalizes before insert). If the owner checks in twice in one
-- week, UNIQUE blocks the duplicate — they update the existing row
-- via the UI. We do NOT use append-only semantics here because the
-- value at week-end is what we care about, not the intra-week
-- noise.

CREATE TABLE IF NOT EXISTS public.exec_goal_checkins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_result_id   uuid NOT NULL REFERENCES public.exec_key_results(id) ON DELETE CASCADE,
  week_of         date NOT NULL,
  value           numeric NOT NULL,
  confidence      text NOT NULL
                    CHECK (confidence IN ('green', 'yellow', 'red')),
  note            text,
  author          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key_result_id, week_of)
);

CREATE INDEX IF NOT EXISTS idx_exec_goal_checkins_kr_week
  ON public.exec_goal_checkins (key_result_id, week_of DESC);
CREATE INDEX IF NOT EXISTS idx_exec_goal_checkins_org_week
  ON public.exec_goal_checkins (org_id, week_of DESC);

-- ────────────────────────────────────────────────────────────────────
-- 6. RLS — owner-write, admin-read on goals/KRs/checkins
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.exec_task_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_goals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_key_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exec_goal_checkins   ENABLE ROW LEVEL SECURITY;

-- Idempotent: drop every policy we're about to create first.
DO $$
DECLARE
  t text;
  cmd text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['exec_task_templates', 'exec_tasks',
                               'exec_goals', 'exec_key_results',
                               'exec_goal_checkins']) LOOP
    FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                     t || '_owner_' || cmd, t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                     t || '_admin_' || cmd, t);
    END LOOP;
  END LOOP;
END
$$;

-- exec_task_templates — owner only, all ops
CREATE POLICY exec_task_templates_owner_select ON public.exec_task_templates
  FOR SELECT TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_task_templates_owner_insert ON public.exec_task_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_task_templates_owner_update ON public.exec_task_templates
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_task_templates_owner_delete ON public.exec_task_templates
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- exec_tasks — owner only, all ops
CREATE POLICY exec_tasks_owner_select ON public.exec_tasks
  FOR SELECT TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_tasks_owner_insert ON public.exec_tasks
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_tasks_owner_update ON public.exec_tasks
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_tasks_owner_delete ON public.exec_tasks
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- exec_goals — owner R/W, admin R
CREATE POLICY exec_goals_admin_select ON public.exec_goals
  FOR SELECT TO authenticated
  USING (public.is_admin() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goals_owner_insert ON public.exec_goals
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goals_owner_update ON public.exec_goals
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goals_owner_delete ON public.exec_goals
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- exec_key_results — owner R/W, admin R
CREATE POLICY exec_key_results_admin_select ON public.exec_key_results
  FOR SELECT TO authenticated
  USING (public.is_admin() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_key_results_owner_insert ON public.exec_key_results
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_key_results_owner_update ON public.exec_key_results
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_key_results_owner_delete ON public.exec_key_results
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- exec_goal_checkins — owner R/W, admin R
CREATE POLICY exec_goal_checkins_admin_select ON public.exec_goal_checkins
  FOR SELECT TO authenticated
  USING (public.is_admin() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goal_checkins_owner_insert ON public.exec_goal_checkins
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goal_checkins_owner_update ON public.exec_goal_checkins
  FOR UPDATE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid)
  WITH CHECK (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);
CREATE POLICY exec_goal_checkins_owner_delete ON public.exec_goal_checkins
  FOR DELETE TO authenticated
  USING (public.is_owner() AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid);

-- ────────────────────────────────────────────────────────────────────
-- 7. Sanity checks
-- ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tbl text;
  v_required_tables text[] := ARRAY[
    'exec_task_templates', 'exec_tasks', 'exec_goals',
    'exec_key_results', 'exec_goal_checkins'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_required_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = v_tbl
    ) THEN
      RAISE EXCEPTION 'exec_tables: table % missing after migration', v_tbl;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = v_tbl AND n.nspname = 'public' AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'exec_tables: RLS not enabled on %', v_tbl;
    END IF;
  END LOOP;
END
$$;
