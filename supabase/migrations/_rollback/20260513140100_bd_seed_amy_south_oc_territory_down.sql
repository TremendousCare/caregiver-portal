-- Rollback for 20260513140100_bd_seed_amy_south_oc_territory.sql
--
-- Reverses the data seed by removing Amy's membership + the South OC
-- territory row, and clearing the is_strategic_shared flag on the 14
-- accounts that were set by the seed migration.
--
-- The is_strategic_shared column itself is dropped by the up-migration
-- rollback (20260513140000_..._down.sql) — this file only reverses the
-- seed's data writes so an operator can re-run just the seed if needed
-- without also tearing down the schema.

DO $$
DECLARE
  v_org_id        uuid;
  v_territory_id  uuid;
BEGIN
  v_org_id := public.default_org_id();

  SELECT id INTO v_territory_id
  FROM bd_territories
  WHERE org_id = v_org_id
    AND lower(name) = 'south oc'
  LIMIT 1;

  IF v_territory_id IS NOT NULL THEN
    -- Cascade drops bd_territory_members rows pointed at this id.
    DELETE FROM bd_territories WHERE id = v_territory_id;
  END IF;
END $$;

UPDATE bd_accounts
   SET is_strategic_shared = false
 WHERE id IN (
   '2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6'::uuid,
   '47cbb432-6bfd-4f29-87e4-d52bbcd61378'::uuid,
   'b2b1d7b9-ed8d-42c2-a5df-f8ddd56974f0'::uuid,
   '7712de8a-60f9-453a-8ceb-798d650fbd0d'::uuid,
   'c8284df0-91cb-44bf-8ef0-dc2e1decb646'::uuid,
   'e49cc776-c5e1-4bd2-8680-b44840c6f579'::uuid,
   '6740b351-9910-4104-9bd7-525cf86471c7'::uuid,
   '8b197574-558c-4387-802d-7507bf973cf0'::uuid,
   '0fa94736-cb17-4614-8df1-4a6bc422a702'::uuid,
   'bd5fa780-fd05-4521-b3f7-cf574d2300ff'::uuid,
   'ecf5654a-3398-4fd6-b6dc-fe3fdf3a2b1d'::uuid,
   '95eb3fd0-861b-4d04-9290-7b99bcf3f899'::uuid,
   '07c68cae-9233-461c-89f5-c8683ccc3d19'::uuid,
   'c57c4189-08b7-4906-ad93-338f2db792ae'::uuid
 );
