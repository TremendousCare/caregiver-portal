-- Paychex integration Phase 1: paychex_api_log audit table.
--
-- Records every Paychex API call the portal makes — request, response,
-- outcome — so we can prove what happened to Paychex if there's ever
-- a dispute and so the team can debug failures without re-running
-- traffic against production. Includes dry-run calls (PAYCHEX_DRY_RUN
-- flag) so the audit trail is complete in dev as well.
--
-- Per the Decisions section, request/response bodies are stored
-- verbatim except SSN-redaction on full-PII worker variants. Reads
-- default to the nonpii media type, so most rows have no PII anyway.
--
-- Retention: persists for at least 1 year (no auto-prune in this
-- migration; if size becomes a concern we add a partitioning or TTL
-- migration later).
--
-- See: docs/plans/2026-04-25-paychex-integration-plan.md
--      ("Data model" → "New tables" → "paychex_api_log").

CREATE TABLE IF NOT EXISTS paychex_api_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  endpoint        text NOT NULL,
  method          text NOT NULL CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')),
  request_body    jsonb,
  response_status int,
  response_body   jsonb,
  error           text,
  -- Stable hash of payload + ISO date bucket for sync calls;
  -- payroll_runs.id for payroll submissions. Lets retries dedupe
  -- without creating duplicate workers/runs in Paychex.
  idempotency_key text,
  -- True when PAYCHEX_DRY_RUN was set — the call never actually hit
  -- Paychex but was logged so dev/test traffic appears in the audit.
  dry_run         boolean NOT NULL DEFAULT false,
  duration_ms     int,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency lookup: did we already call Paychex with this key?
-- Partial because most callers won't filter by it.
CREATE INDEX IF NOT EXISTS idx_paychex_api_log_idempotency_key
  ON paychex_api_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Per-org chronological reads (Phase 4 PayrollRunsView detail page
-- "view API calls related to this run").
CREATE INDEX IF NOT EXISTS idx_paychex_api_log_org_created_at
  ON paychex_api_log (org_id, created_at DESC);

-- Failure debugging: surface non-2xx responses fast.
CREATE INDEX IF NOT EXISTS idx_paychex_api_log_failures
  ON paychex_api_log (org_id, created_at DESC)
  WHERE response_status IS NOT NULL AND response_status >= 400;

ALTER TABLE paychex_api_log ENABLE ROW LEVEL SECURITY;

-- Read-only for tenant users — the audit log is written exclusively
-- by edge functions (service_role). Authenticated users get a SELECT
-- policy so the Phase 4 UI can display recent calls; INSERT/UPDATE/
-- DELETE are blocked at the policy layer for the authenticated role.
CREATE POLICY "tenant_read_paychex_api_log"
  ON paychex_api_log FOR SELECT
  TO authenticated
  USING (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id);

CREATE POLICY "service_role_full_access_paychex_api_log"
  ON paychex_api_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
