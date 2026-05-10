-- Phase 1.1.A — agent_actions table.
--
-- Tamper-evident audit log of every action an agent takes. Each row
-- contains a SHA-256 hash chain link (prev_hash + row_hash) and an
-- Ed25519 signature over the row_hash. A daily verifier (Phase 1.1.B)
-- walks the chain and alerts on broken hashes or invalid signatures.
--
-- Foundation only: PR 1.1.A creates the table + lockdown + the
-- record_agent_action_v1 RPC that's the sole write path. PR 1.1.B
-- adds the verifier edge function + daily cron + the first dual-
-- write call site (toggle_agent_flag_v1). PR 1.1.C extends dual-
-- write to every logEvent / logAction call site + the export
-- endpoint.
--
-- Why agent_actions exists when we already have events: events is a
-- general-purpose append-only stream with no per-row tamper
-- evidence. agent_actions specifically tracks decisions made BY an
-- agent (suggested|confirmed|executed|auto_executed|rejected|
-- expired|shadow) with cryptographic guarantees the row hasn't been
-- edited after the fact. A future regulator asking "what did this
-- AI agent do, and prove it" reads from agent_actions, not events.
--
-- Hash content (locked per docs/AGENT_PLATFORM.md → Phase 1.1):
--   row_hash = SHA-256(prev_hash || canonical(payload) || created_at_ns
--                       || agent_id || phase)
-- The implementation extends this to also include agent_version,
-- action_type, entity_type, entity_id, actor, and outcome_id so that
-- ANY field change breaks the chain. The locked spec listed the
-- minimum; we strengthen it. Documented in the recordAgentAction
-- helper.
--
-- RLS posture: SELECT for authenticated (admins read the audit log
-- + the verifier reads it). NO direct INSERT/UPDATE/DELETE for
-- authenticated — those go through record_agent_action_v1 (next
-- migration) which is SECURITY DEFINER. Same lockdown pattern as
-- agents/agent_versions in PR B (Phase 0.5).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, REVOKE is a no-op when
-- the privilege is absent. Safe to re-run via supabase db push.

CREATE TABLE IF NOT EXISTS public.agent_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy / agent lineage.
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id),
  agent_id        uuid NOT NULL REFERENCES public.agents(id),
  agent_version   integer NOT NULL CHECK (agent_version >= 1),

  -- What happened. action_type mirrors events.event_type for the
  -- subset that came from an agent. phase is the lifecycle position
  -- per docs/AGENT_PLATFORM.md: a single tool call may produce many
  -- agent_actions rows over its life (suggested → confirmed →
  -- executed, or suggested → expired).
  action_type     text NOT NULL CHECK (length(action_type) > 0),
  phase           text NOT NULL CHECK (
                    phase IN (
                      'suggested', 'confirmed', 'executed',
                      'auto_executed', 'rejected', 'expired', 'shadow'
                    )
                  ),

  -- Entity context. Caregiver/client-scoped actions populate these;
  -- agent-scoped actions (e.g. flag toggles) leave them NULL. Mirror
  -- the events table's CHECK so cross-table consistency is obvious.
  entity_type     text CHECK (entity_type IS NULL OR entity_type IN ('caregiver', 'client')),
  entity_id       uuid,

  -- Who triggered it. user:<email> | system:<source> | system:ai
  actor           text NOT NULL DEFAULT 'system',

  -- The action's parameters / inputs / detail. Format mirrors
  -- events.payload for consistency.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional FK to action_outcomes when this row corresponds to a
  -- third-party-verified outcome (Phase 2 will populate). NULL until
  -- the outcome closes.
  outcome_id      uuid REFERENCES public.action_outcomes(id),

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Hash chain. prev_hash is the row_hash of the most recent row
  -- with the same org_id (or '' for the genesis row). row_hash is
  -- the SHA-256 over the chain inputs (see header). UNIQUE on
  -- row_hash catches accidental duplicate writes — the cryptographic
  -- collision probability is negligible.
  prev_hash       text NOT NULL,
  row_hash        text NOT NULL UNIQUE,

  -- Ed25519 signature of row_hash by the per-org signing key
  -- (Tremendous Care key in env var until SaaS Phase C lands per-
  -- org Vault keys per docs/AGENT_PLATFORM.md → Phase 1.1).
  signature       text NOT NULL CHECK (length(signature) > 0)
);

-- Index for chain walks (verifier reads in created_at order per org).
CREATE INDEX IF NOT EXISTS idx_agent_actions_org_chain
  ON public.agent_actions (org_id, created_at DESC);

-- Index for per-agent forensics ("what did agent X do last week?").
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_chain
  ON public.agent_actions (agent_id, created_at DESC);

-- Index for outcome resolution ("which agent action produced
-- outcome Y?").
CREATE INDEX IF NOT EXISTS idx_agent_actions_outcome
  ON public.agent_actions (outcome_id) WHERE outcome_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- RLS — strict tenant isolation, SELECT-only for authenticated.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_predicate constant text :=
    'org_id = nullif(auth.jwt() ->> ''org_id'', '''')::uuid';
BEGIN
  -- SELECT — any same-org authenticated user can read the audit log.
  -- Whether non-admins should see it is a Phase 1.4 question (the
  -- metrics dashboard); for now we trust org-scoped read.
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_agent_actions_select ON public.agent_actions';
  EXECUTE format(
    'CREATE POLICY tenant_isolation_agent_actions_select ON public.agent_actions '
    || 'FOR SELECT TO authenticated USING (%s)',
    v_predicate
  );
  -- INSERT/UPDATE/DELETE: NO policies + REVOKE below. Writes happen
  -- only through record_agent_action_v1 (SECURITY DEFINER, next
  -- migration). This is the same lockdown pattern as PR B's
  -- agent_table_write_lockdown migration on agents/agent_versions.
END
$$;

-- Lockdown: revoke direct write privileges from authenticated. The
-- SECURITY DEFINER RPC runs as the function owner (postgres) and is
-- unaffected. service_role still bypasses RLS for migrations and
-- ad-hoc admin queries.
REVOKE INSERT, UPDATE, DELETE ON public.agent_actions FROM authenticated;

-- Sanity: confirm the lockdown landed. Mirrors the PR B pattern.
DO $$
DECLARE
  v_bad_count integer;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM information_schema.table_privileges
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name = 'agent_actions'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'agent_actions lockdown failed: authenticated still has % write privileges',
      v_bad_count;
  END IF;
END
$$;
