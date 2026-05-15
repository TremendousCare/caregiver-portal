-- Rollback for 20260515220100_bd_seed_south_oc_research_import.sql
--
-- Reverses the South OC research-import seed:
--   1. Deletes every bd_accounts row with source='research_import'
--      AND no activities/referrals (to avoid clobbering accounts
--      that have since been worked).
--   2. Clears the address/phone overrides on aliased existing
--      rows IFF the current value still equals what the up-migration
--      set (so we don't undo later edits the rep made).
--   3. Deletes the 5 Hoag named contacts inserted by the up.
--   4. Drops the idempotency indexes.

DELETE FROM bd_accounts a
 WHERE a.source = 'research_import'
   AND NOT EXISTS (SELECT 1 FROM bd_activities x WHERE x.account_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM bd_referrals  x WHERE x.account_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM bd_account_contacts x WHERE x.account_id = a.id);

UPDATE bd_accounts SET address = NULL WHERE id = '792b7c2d-6e6f-4a2c-9cae-e7b4f450ff20'::uuid AND address = '1445 Superior Ave';
UPDATE bd_accounts SET phone   = NULL WHERE id = '792b7c2d-6e6f-4a2c-9cae-e7b4f450ff20'::uuid AND phone   = '+19495153930';
UPDATE bd_accounts SET address = NULL WHERE id = '168a5e17-ef07-4f11-b13e-b1ce9d0b5331'::uuid AND address = 'Flagship Rd';
UPDATE bd_accounts SET phone   = NULL WHERE id = '168a5e17-ef07-4f11-b13e-b1ce9d0b5331'::uuid AND phone   = '+19496428044';
UPDATE bd_accounts SET address = NULL WHERE id = 'bf18c6a7-ab5d-48fb-a572-6c2ca76e2297'::uuid AND address = '1000 Halyard';
UPDATE bd_accounts SET address = NULL WHERE id = 'dfde6580-7254-434f-99da-5df9c5d6d9ff'::uuid AND address = '393 Hospital Road';
UPDATE bd_accounts SET address = NULL WHERE id = '1645ebe9-e1a7-4623-a234-d986d2266601'::uuid AND address = '850 San Clemente Dr';
UPDATE bd_accounts SET address = NULL WHERE id = '3a58d9b7-e7f8-47c6-825f-4254b1abaa76'::uuid AND address = '101 Bayview Pl';
UPDATE bd_accounts SET phone   = NULL WHERE id = '3a58d9b7-e7f8-47c6-825f-4254b1abaa76'::uuid AND phone   = '+19499426391';
UPDATE bd_accounts SET address = NULL WHERE id = '2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6'::uuid AND address = '16200 Sand Canyon Ave';
UPDATE bd_accounts SET phone   = NULL WHERE id = '2a3c0d15-35e5-4a08-8d18-d91dd13cf6a6'::uuid AND phone   = '+19497644624';
UPDATE bd_accounts SET address = NULL WHERE id = '8fdefc8d-13d6-4812-ac5d-f5f3d08882e1'::uuid AND address = '19191 Harvard Ave';
UPDATE bd_accounts SET phone   = NULL WHERE id = '8fdefc8d-13d6-4812-ac5d-f5f3d08882e1'::uuid AND phone   = '+19495092298';
UPDATE bd_accounts SET address = NULL WHERE id = 'cd92e7b6-403d-46ac-961f-ae5c3459083f'::uuid AND address = '19191 Harvard Ave';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'cd92e7b6-403d-46ac-961f-ae5c3459083f'::uuid AND phone   = '+19498549500';
UPDATE bd_accounts SET address = NULL WHERE id = '69d46477-df54-4274-a980-947c01505aab'::uuid AND address = '1 Witherspoon';
UPDATE bd_accounts SET phone   = NULL WHERE id = '69d46477-df54-4274-a980-947c01505aab'::uuid AND phone   = '+19495229604';
UPDATE bd_accounts SET address = NULL WHERE id = '052b574b-06bb-4b5a-8746-dc864ac80ee5'::uuid AND address = '33 Creek Rd';
UPDATE bd_accounts SET phone   = NULL WHERE id = '052b574b-06bb-4b5a-8746-dc864ac80ee5'::uuid AND phone   = '+19497865665';
UPDATE bd_accounts SET address = NULL WHERE id = 'f5cff168-5ff9-4ced-b365-96834d079536'::uuid AND address = '25652 Old Trabuco Rd, Lake Forest 92630';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'f5cff168-5ff9-4ced-b365-96834d079536'::uuid AND phone   = '+19493809380';
UPDATE bd_accounts SET address = NULL WHERE id = '34b13857-a8e6-4d9e-a6f6-8b02c2c3d4bd'::uuid AND address = '23442 El Toro Rd, Lake Forest 92630';
UPDATE bd_accounts SET phone   = NULL WHERE id = '34b13857-a8e6-4d9e-a6f6-8b02c2c3d4bd'::uuid AND phone   = '+19496872723';
UPDATE bd_accounts SET address = NULL WHERE id = '95eb3fd0-861b-4d04-9290-7b99bcf3f899'::uuid AND address = '31872 Coast Hwy, Laguna Beach';
UPDATE bd_accounts SET phone   = NULL WHERE id = '95eb3fd0-861b-4d04-9290-7b99bcf3f899'::uuid AND phone   = '+19494991311';
UPDATE bd_accounts SET address = NULL WHERE id = 'b8871833-0396-46e4-a26d-ace0cd357882'::uuid AND address = '24451 Health Center Dr, Laguna Hills';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'b8871833-0396-46e4-a26d-ace0cd357882'::uuid AND phone   = '+19498374500';
UPDATE bd_accounts SET address = NULL WHERE id = '57fde526-e604-4489-8ad6-cb74799fecbc'::uuid AND address = '25000 Calle De Los Caballeros, Laguna Hills';
UPDATE bd_accounts SET phone   = NULL WHERE id = '57fde526-e604-4489-8ad6-cb74799fecbc'::uuid AND phone   = '+19496097540';
UPDATE bd_accounts SET address = NULL WHERE id = 'bb702366-f5e0-4553-90ef-fed9aa388c5a'::uuid AND address = '24962 Calle Aragon, Laguna Hills/Woods border';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'bb702366-f5e0-4553-90ef-fed9aa388c5a'::uuid AND phone   = '+19495879000';
UPDATE bd_accounts SET address = NULL WHERE id = 'c2884c89-9e7a-47e5-8eef-bcd64c02eda4'::uuid AND address = '24452 Health Center Dr, Laguna Hills';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'c2884c89-9e7a-47e5-8eef-bcd64c02eda4'::uuid AND phone   = '+19498378000';
UPDATE bd_accounts SET address = NULL WHERE id = '570d72ee-dff7-4b59-ade1-fa46b829e70c'::uuid AND address = '27762 Forbes Rd, Laguna Niguel';
UPDATE bd_accounts SET phone   = NULL WHERE id = '570d72ee-dff7-4b59-ade1-fa46b829e70c'::uuid AND phone   = '+18552017289';
UPDATE bd_accounts SET address = NULL WHERE id = 'd726eaef-e357-4c2f-a677-8cd29cdb21eb'::uuid AND address = '30111 Niguel Rd, Laguna Niguel';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'd726eaef-e357-4c2f-a677-8cd29cdb21eb'::uuid AND phone   = '+19498445997';
UPDATE bd_accounts SET address = NULL WHERE id = '81f5d5be-30fd-4987-a8a5-4cc49dbc9ddf'::uuid AND address = '24552 Paseo De Valencia, Laguna Hills';
UPDATE bd_accounts SET phone   = NULL WHERE id = '81f5d5be-30fd-4987-a8a5-4cc49dbc9ddf'::uuid AND phone   = '+19499986296';
UPDATE bd_accounts SET address = NULL WHERE id = 'c4e5cca5-9b0a-4074-9d3e-1c8eb13c9e17'::uuid AND address = '25200 Paseo De Alicia, Laguna Hills';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'c4e5cca5-9b0a-4074-9d3e-1c8eb13c9e17'::uuid AND phone   = '+19495706887';
UPDATE bd_accounts SET address = NULL WHERE id = '2c35ad90-576f-440e-8f60-14d967183047'::uuid AND address = '32170 Niguel Rd, Laguna Niguel';
UPDATE bd_accounts SET phone   = NULL WHERE id = '2c35ad90-576f-440e-8f60-14d967183047'::uuid AND phone   = '+19496763780';
UPDATE bd_accounts SET address = NULL WHERE id = 'bbe5e119-d990-45df-9edc-6d4e27eba0fc'::uuid AND address = '24962 Calle Aragon, Laguna Woods';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'bbe5e119-d990-45df-9edc-6d4e27eba0fc'::uuid AND phone   = '+19494036343';
UPDATE bd_accounts SET address = NULL WHERE id = '7f68fd6a-eec9-4adb-bf81-181231dd3f24'::uuid AND address = '300 Freedom Ln';
UPDATE bd_accounts SET phone   = NULL WHERE id = '7f68fd6a-eec9-4adb-bf81-181231dd3f24'::uuid AND phone   = '+19496494791';
UPDATE bd_accounts SET address = NULL WHERE id = '7712de8a-60f9-453a-8ceb-798d650fbd0d'::uuid AND address = '26671 Aliso Creek Rd #304';
UPDATE bd_accounts SET phone   = NULL WHERE id = '7712de8a-60f9-453a-8ceb-798d650fbd0d'::uuid AND phone   = '+19495563304';
UPDATE bd_accounts SET address = NULL WHERE id = '7d1c6c42-9ab5-4bc8-ae16-d4938526cb0a'::uuid AND address = '1 Amistad Dr';
UPDATE bd_accounts SET phone   = NULL WHERE id = '7d1c6c42-9ab5-4bc8-ae16-d4938526cb0a'::uuid AND phone   = '+19495452260';
UPDATE bd_accounts SET address = NULL WHERE id = 'e8395783-f11c-4450-98f6-35e348c62518'::uuid AND address = '26151 Country Club Dr';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'e8395783-f11c-4450-98f6-35e348c62518'::uuid AND phone   = '+19495822010';
UPDATE bd_accounts SET address = NULL WHERE id = '7fa154dd-7bf4-4143-b35b-31012279078e'::uuid AND address = '27356 Bellogente';
UPDATE bd_accounts SET phone   = NULL WHERE id = '7fa154dd-7bf4-4143-b35b-31012279078e'::uuid AND phone   = '+19493649685';
UPDATE bd_accounts SET address = NULL WHERE id = '4c4b5d8a-5080-49a3-b222-3f673eeaeb5c'::uuid AND address = '21952 Buena Suerte';
UPDATE bd_accounts SET phone   = NULL WHERE id = '4c4b5d8a-5080-49a3-b222-3f673eeaeb5c'::uuid AND phone   = '+19496198796';
UPDATE bd_accounts SET address = NULL WHERE id = '258d79f0-fa02-455f-a3aa-7cbd9f15651f'::uuid AND address = '31741 Rancho Viejo Rd B';
UPDATE bd_accounts SET phone   = NULL WHERE id = '258d79f0-fa02-455f-a3aa-7cbd9f15651f'::uuid AND phone   = '+19498681220';
UPDATE bd_accounts SET address = NULL WHERE id = '87696222-9ada-4411-8e72-653feaa8d292'::uuid AND address = '32353 San Juan Creek Rd';
UPDATE bd_accounts SET phone   = NULL WHERE id = '87696222-9ada-4411-8e72-653feaa8d292'::uuid AND phone   = '+19496611220';
UPDATE bd_accounts SET address = NULL WHERE id = 'bd99c52d-80e2-40e6-8766-29bf7f68ec78'::uuid AND address = '31741 Rancho Viejo Rd A';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'bd99c52d-80e2-40e6-8766-29bf7f68ec78'::uuid AND phone   = '+19492488855';
UPDATE bd_accounts SET address = NULL WHERE id = '85d9159e-40e6-4e37-be18-fabc3f983e63'::uuid AND address = '35410 Del Rey, Dana Point 92624';
UPDATE bd_accounts SET phone   = NULL WHERE id = '85d9159e-40e6-4e37-be18-fabc3f983e63'::uuid AND phone   = '+19494965786';
UPDATE bd_accounts SET address = NULL WHERE id = '956ca760-55a4-48bb-bb40-08930dc03de9'::uuid AND address = '25411 Sea Bluffs Dr';
UPDATE bd_accounts SET phone   = NULL WHERE id = '956ca760-55a4-48bb-bb40-08930dc03de9'::uuid AND phone   = '+19492343000';
UPDATE bd_accounts SET address = NULL WHERE id = '7f8c9961-caa8-44d6-a2d5-b8ea37ab2341'::uuid AND address = '101 Avenida Calafia';
UPDATE bd_accounts SET phone   = NULL WHERE id = '7f8c9961-caa8-44d6-a2d5-b8ea37ab2341'::uuid AND phone   = '+19494209898';
UPDATE bd_accounts SET address = NULL WHERE id = 'e580d9da-5c92-4da3-9212-a6c8107a5763'::uuid AND address = '660 Camino De Los Mares';
UPDATE bd_accounts SET phone   = NULL WHERE id = 'e580d9da-5c92-4da3-9212-a6c8107a5763'::uuid AND phone   = '+19492087611';

DELETE FROM bd_account_contacts
 WHERE account_id = '47cbb432-6bfd-4f29-87e4-d52bbcd61378'::uuid
   AND name IN (
     'Amy Robinson', 'Arnetta Robinson', 'Brittany Carrillo', 'Jenna Gailani, LCSW', 'Madeline Conrado, LCSW'
   );

DROP INDEX IF EXISTS idx_bd_accounts_research_import_unique;
