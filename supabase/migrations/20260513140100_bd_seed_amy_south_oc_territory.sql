-- BD Module — seed Amy Dutton's South OC territory + strategic flag
--
-- One-time data seed that:
--   1. Creates the "South OC" territory in the current org with its
--      city list (both formal and shorthand variants — "Rancho Mission
--      Viejo" + "RMV" — so historical Trello-imported rows match).
--   2. Adds Amy Dutton (auth.uid 9228e867-30ca-4294-985b-871a994cc5fc)
--      as a member.
--   3. Flags 14 accounts across 4 health systems (Hoag, Mission Hospital,
--      UCI Hospital Orange, Providence / St Joe's) as
--      is_strategic_shared = true. These are visible to every rep
--      regardless of territory because the BD team coordinates with
--      them as systems, not as city-bound facilities.
--
-- Idempotent: re-running this migration is a no-op for an org that
-- already has the seed applied. The territory create uses an explicit
-- existence check (the unique index on (org_id, lower(name)) is
-- function-based and can't drive ON CONFLICT). The cities array is
-- refreshed on re-run so an operator can amend this file and re-deploy
-- to adjust the canonical city list — the territory row stays the
-- same, only the cities[] is updated. Membership and the strategic
-- flag updates are idempotent by construction.
--
-- Production safety:
--   No DELETE, no DROP. The only mutating statement against existing
--   rows is the strategic-flag UPDATE, which sets a single boolean
--   column on 14 named rows. Rollback at
--   _rollback/20260513140100_bd_seed_amy_south_oc_territory_down.sql
--   reverses the strategic flag and removes the territory + member rows.

DO $$
DECLARE
  v_org_id        uuid;
  v_territory_id  uuid;
  v_user_id       uuid := '9228e867-30ca-4294-985b-871a994cc5fc';
  v_cities        text[] := ARRAY[
    'Aliso Viejo',
    'Costa Mesa',
    'Dana Point',
    'El Toro',
    'Foothill Ranch',
    'Irvine',
    'Ladera Ranch',
    'Laguna Beach',
    'Laguna Hills',
    'Laguna Niguel',
    'Laguna Woods',
    'Lake Forest',
    'Mission Viejo',
    'Newport Beach',
    'Newport Coast',
    'Rancho Mission Viejo',
    'RMV',
    'Rancho Santa Margarita',
    'RSM',
    'San Clemente',
    'San Juan Capistrano',
    'Trabuco Canyon',
    'Trabuco Hills'
  ];
BEGIN
  v_org_id := public.default_org_id();

  SELECT id INTO v_territory_id
  FROM bd_territories
  WHERE org_id = v_org_id
    AND lower(name) = 'south oc'
  LIMIT 1;

  IF v_territory_id IS NULL THEN
    INSERT INTO bd_territories (org_id, name, cities)
    VALUES (v_org_id, 'South OC', v_cities)
    RETURNING id INTO v_territory_id;
  ELSE
    -- Keep the city list in sync with this file on re-run so an
    -- operator can amend the canonical list by editing the migration
    -- and re-deploying. Does not touch the territory row's id.
    UPDATE bd_territories
       SET cities = v_cities
     WHERE id = v_territory_id;
  END IF;

  -- Only seed the membership if Amy exists in auth.users in this
  -- environment. The FK on user_id would otherwise hard-fail the
  -- migration when applied to a fresh dev DB that doesn't have her
  -- account provisioned yet.
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    INSERT INTO bd_territory_members (territory_id, user_id, org_id)
    VALUES (v_territory_id, v_user_id, v_org_id)
    ON CONFLICT (territory_id, user_id) DO NOTHING;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- Strategic-shared flag — 14 accounts across 4 health systems
-- ─────────────────────────────────────────────────────────────────
-- Idempotent: setting is_strategic_shared = true on a row that is
-- already true is a no-op. The WHERE filter pins the change to the
-- exact UUIDs verified against the production data on 2026-05-13.
-- If any UUID has been deleted (it shouldn't have — Trello-imported
-- bd_accounts rows are never deleted in normal operation), the row
-- count for that id will just be zero and the statement still succeeds.

UPDATE bd_accounts
   SET is_strategic_shared = true
 WHERE id IN (
   -- Hoag (8 rows — full system flagged so sub-services match too)
   '2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6'::uuid, -- Hoag (Irvine)
   '47cbb432-6bfd-4f29-87e4-d52bbcd61378'::uuid, -- HOAG (Newport Beach)
   'b2b1d7b9-ed8d-42c2-a5df-f8ddd56974f0'::uuid, -- HOAG (Newport Beach, duplicate)
   '7712de8a-60f9-453a-8ceb-798d650fbd0d'::uuid, -- HOAG Concierge Med (Aliso Viejo)
   'c8284df0-91cb-44bf-8ef0-dc2e1decb646'::uuid, -- HOAG Hospice/HH (Newport Beach)
   'e49cc776-c5e1-4bd2-8680-b44840c6f579'::uuid, -- Hoag Palliative Care (Newport Beach)
   '6740b351-9910-4104-9bd7-525cf86471c7'::uuid, -- Laguna Beach Hoag Family Medicine
   '8b197574-558c-4387-802d-7507bf973cf0'::uuid, -- Neurology Hoag (Aliso Viejo)
   -- Mission Hospital (Mission Viejo)
   '0fa94736-cb17-4614-8df1-4a6bc422a702'::uuid,
   -- UCI Hospital Orange (Orange)
   'bd5fa780-fd05-4521-b3f7-cf574d2300ff'::uuid,
   -- Providence + St Joe's (4 rows — both Providence-branded and the
   -- Providence-owned St Joe's row in Orange)
   'ecf5654a-3398-4fd6-b6dc-fe3fdf3a2b1d'::uuid, -- Providence (city=null)
   '95eb3fd0-861b-4d04-9290-7b99bcf3f899'::uuid, -- Providence Hospital (Laguna Beach)
   '07c68cae-9233-461c-89f5-c8683ccc3d19'::uuid, -- Providence Hospital Orange
   'c57c4189-08b7-4906-ad93-338f2db792ae'::uuid  -- St Joe's Hospital (Orange)
 );
