-- Voice / CTI Phase 1 — communication_voice_config.
--
-- Per-org configuration for the RingCentral telephony integration:
-- screen-pop, call recording, transcription provider, and the
-- Telephony Sessions webhook subscription tied to the org's RC
-- account. One row per org; created lazily by the admin UI when
-- an admin enables voice for the first time.
--
-- WHY A SIBLING TABLE (NOT EXTENDING communication_routes):
--   communication_routes is shaped for SMS routing — one shared
--   number per category (general/onboarding/scheduling), per-category
--   webhook subscription. Voice with our setup is per-user (each
--   agent has their own RC extension) plus per-org policy (recording,
--   transcription provider, screen-pop UX). The natural identity is
--   org + extension, not "category". Cramming voice into
--   communication_routes would null-pollute both sides. Keep them
--   shaped to what they model.
--
-- AUTH CREDENTIAL (Phase 1 interim):
--   The Telephony Sessions webhook needs an RC JWT with Voice scope.
--   Until Phase C of the SaaS retrofit formalizes per-org secret
--   storage (docs/SAAS_RETROFIT_STATUS.md → "Decisions still open" →
--   Vault vs org_secrets), we reuse the same JWT vault entry that
--   one of the existing communication_routes uses — typically
--   'general'. The reference is by category text, not vault secret
--   name, so when Phase C migrates the secret storage, only the
--   helper RPC needs updating.
--
-- TENANT ISOLATION:
--   org_id PRIMARY KEY enforces one row per org. Default via
--   public.default_org_id() per the Phase B locked decision. Four
--   tenant_isolation_<table>_<command> policies match the B2b
--   pattern (suffix-anchored regex, PR #237). service_role policy
--   for edge functions (webhook handler, subscription renewal cron).
--
-- ROLLBACK: supabase/migrations/_rollback/20260511000000_*_down.sql

CREATE TABLE IF NOT EXISTS communication_voice_config (
  org_id                          uuid PRIMARY KEY
                                    DEFAULT public.default_org_id()
                                    REFERENCES organizations(id) ON DELETE CASCADE,

  -- Feature toggles --------------------------------------------------
  recording_enabled               boolean NOT NULL DEFAULT true,
  screen_pop_enabled              boolean NOT NULL DEFAULT true,

  -- Org-wide default for "auto-navigate to caller profile on answer".
  -- Individual users can override via a user-pref later in PR 3.
  auto_navigate_on_answer_default boolean NOT NULL DEFAULT false,

  -- Transcription provider --------------------------------------------
  -- 'ringcentral_native' = pull transcript from the RC call object.
  -- 'whisper'            = pipe recording through our existing
  --                        call-transcription edge function.
  -- 'both'               = prefer native, fall back to whisper when
  --                        native is missing or empty.
  -- Configurable per org so customers on cheaper RC plans without
  -- RC AI native transcription can still run on Whisper.
  transcription_provider          text NOT NULL DEFAULT 'ringcentral_native'
                                    CHECK (transcription_provider IN (
                                      'ringcentral_native', 'whisper', 'both'
                                    )),

  -- Recording disclosure announcement: some states require two-party
  -- consent. When non-null, the admin UI surfaces this so the org
  -- can confirm their RC outgoing announcement matches.
  recording_disclosure_text       text,

  -- Auth reference (Phase 1 interim — see header).
  -- Points to communication_routes.category whose JWT we use for
  -- voice API calls. NULL = voice not yet provisioned for this org.
  auth_route_category             text REFERENCES communication_routes(category) ON DELETE SET NULL,

  -- Telephony Sessions webhook subscription tracking --------------
  -- Mirrors the per-route fields on communication_routes for SMS.
  -- One subscription covers all extensions on the org's RC account.
  webhook_subscription_id         text,
  webhook_subscription_expires_at timestamptz,
  webhook_last_renewed_at         timestamptz,

  -- Audit ------------------------------------------------------------
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      text
);

CREATE INDEX IF NOT EXISTS idx_communication_voice_config_subscription
  ON communication_voice_config (webhook_subscription_id)
  WHERE webhook_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_communication_voice_config_subscription_expiry
  ON communication_voice_config (webhook_subscription_expires_at)
  WHERE webhook_subscription_expires_at IS NOT NULL;

ALTER TABLE communication_voice_config ENABLE ROW LEVEL SECURITY;

-- Tenant isolation — B2b naming pattern (PR #237).
CREATE POLICY "tenant_isolation_communication_voice_config_select"
  ON communication_voice_config FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

-- Writes are admin-only via the public.is_admin() SECURITY DEFINER
-- helper (RLS_GOTCHAS rule 1: never inline EXISTS against a table
-- the policy lives on, and prefer the helper for any role check).
-- Tenant isolation is still enforced on top of the role check.
CREATE POLICY "tenant_isolation_communication_voice_config_insert"
  ON communication_voice_config FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

CREATE POLICY "tenant_isolation_communication_voice_config_update"
  ON communication_voice_config FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  )
  WITH CHECK (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

CREATE POLICY "tenant_isolation_communication_voice_config_delete"
  ON communication_voice_config FOR DELETE
  TO authenticated
  USING (
    public.is_admin()
    AND org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
  );

CREATE POLICY "service_role_full_access_communication_voice_config"
  ON communication_voice_config FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Sanity check — abort the deploy if anything went sideways.
DO $$
DECLARE
  v_table_exists       boolean;
  v_policy_count       int;
  v_default_expr       text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'communication_voice_config'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'communication_voice_config table missing after migration';
  END IF;

  -- Expect 4 tenant_isolation_* + 1 service_role_full_access_* = 5.
  SELECT count(*) INTO v_policy_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'communication_voice_config'
    AND (
      p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
      OR p.polname = 'service_role_full_access_communication_voice_config'
    );

  IF v_policy_count <> 5 THEN
    RAISE EXCEPTION
      'communication_voice_config: expected 5 RLS policies, found %', v_policy_count;
  END IF;

  -- Confirm org_id default uses the locked default_org_id() helper, not a literal.
  SELECT pg_get_expr(d.adbin, d.adrelid)
    INTO v_default_expr
    FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE c.relname = 'communication_voice_config' AND a.attname = 'org_id';

  IF v_default_expr IS NULL OR v_default_expr NOT LIKE '%default_org_id()%' THEN
    RAISE EXCEPTION
      'communication_voice_config.org_id default must reference default_org_id(); got: %',
      v_default_expr;
  END IF;
END
$$;
