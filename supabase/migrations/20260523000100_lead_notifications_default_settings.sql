-- Lead Notification V1 — Default settings seed (PR 2 of 4).
--
-- Pre-populates `organizations.settings.lead_notifications` for any org
-- that doesn't already have a value. This keeps the Settings UI
-- predictable on first load and pre-fills the toast recipient list for
-- Tremendous Care with the three users the owner named:
--
--   • amy.dutton@tremendouscareca.com  (BD rep — the primary contact)
--   • kevinnash@tremendouscareca.com   (management)
--   • blertanash@tremendouscareca.com  (management)
--
-- The list is editable in Settings → Lead Notifications and is not
-- referenced anywhere else, so changing it post-deploy is a single-row
-- UPDATE through the org-settings-update edge function.
--
-- Production safety:
--   • Default `enabled = false`. Nothing fires until an admin flips
--     the switch in Settings.
--   • Idempotent: writes only into keys that are not already present,
--     using `||` (jsonb concat with right-side wins) carefully so
--     a re-run does not clobber user-edited values.
--   • Additive only — no DROP, no DELETE.

DO $$
DECLARE
  v_org RECORD;
  v_existing jsonb;
  v_new jsonb;
  v_tc_default jsonb;
  v_generic_default jsonb;
BEGIN
  -- Tremendous-Care-specific default: pre-populate toast recipients
  -- with the three users the owner explicitly named for V1.
  v_tc_default := jsonb_build_object(
    'enabled',                  false,
    'sms_recipient_emails',     '[]'::jsonb,
    'teams_webhook_url',        '',
    'toast_recipient_emails',   jsonb_build_array(
      'amy.dutton@tremendouscareca.com',
      'kevinnash@tremendouscareca.com',
      'blertanash@tremendouscareca.com'
    ),
    'quiet_hours_start_hour',   21,
    'quiet_hours_end_hour',     7,
    'quiet_hours_timezone',     'America/Los_Angeles'
  );

  -- Generic default for any other org. Empty recipient lists, sensible
  -- quiet-hours defaults (admin can adjust per-org timezone in
  -- Settings).
  v_generic_default := jsonb_build_object(
    'enabled',                  false,
    'sms_recipient_emails',     '[]'::jsonb,
    'teams_webhook_url',        '',
    'toast_recipient_emails',   '[]'::jsonb,
    'quiet_hours_start_hour',   21,
    'quiet_hours_end_hour',     7,
    'quiet_hours_timezone',     'America/Los_Angeles'
  );

  FOR v_org IN SELECT id, slug, settings FROM public.organizations LOOP
    v_existing := COALESCE(v_org.settings -> 'lead_notifications', '{}'::jsonb);

    -- Merge: defaults first, then existing values win on conflict. That
    -- means re-running this seed only fills in keys the admin hasn't
    -- set yet; admin-edited values are never overwritten.
    IF v_org.slug = 'tremendous-care' THEN
      v_new := v_tc_default || v_existing;
    ELSE
      v_new := v_generic_default || v_existing;
    END IF;

    -- Only write if there is something to add — avoids a no-op UPDATE
    -- + audit trigger when the merged value matches existing.
    IF v_new <> v_existing THEN
      UPDATE public.organizations
      SET    settings = COALESCE(settings, '{}'::jsonb)
                        || jsonb_build_object('lead_notifications', v_new),
             updated_at = now()
      WHERE  id = v_org.id;
    END IF;
  END LOOP;
END $$;

-- Sanity: confirm Tremendous Care has the default block now. Catches a
-- regression where someone accidentally renames the org slug.
DO $$
DECLARE
  v_block jsonb;
BEGIN
  SELECT settings -> 'lead_notifications' INTO v_block
  FROM public.organizations
  WHERE slug = 'tremendous-care';

  IF v_block IS NULL THEN
    RAISE EXCEPTION
      'lead-notif default settings: tremendous-care org is missing lead_notifications block after seed';
  END IF;
END $$;
