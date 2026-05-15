-- BD Module — bd_accounts.source provenance column
--
-- Adds a `source` column to bd_accounts so the UI can distinguish
-- accounts that came from cold territory research (Amy's South OC
-- referral list, future BD-rep territory write-ups) from accounts the
-- team has actually engaged with.
--
-- Why this matters:
--   The BD portal currently shows a "cold" badge on accounts that
--   haven't seen activity in 21+ days. That works for accounts we've
--   talked to before — but for a freshly-imported territory list of
--   ~145 accounts where ZERO have any activity, the UI would treat
--   them all as just "cold" and lose the signal that distinguishes
--   "we've engaged this hospital before, but it's been a while" from
--   "we have never actually contacted this account; it came from a
--   cold research pass."
--
--   With `source`, the frontend can render a separate "Prospect" pill
--   on rows where source='research_import' AND activity_count=0 — so
--   Amy can immediately tell which 145 rows are new prospects vs the
--   ~100 existing accounts (some of which are also cold).
--
-- Allowed values (CHECK):
--   - manual          — rep added the account through the portal UI
--                       (default for existing rows; backward compatible)
--   - trello_import   — landed via the legacy Trello board import
--                       (reserved for future migration that backfills
--                       this on rows with non-null trello_card_id)
--   - research_import — bulk-imported from a territory-research
--                       document (Word doc, CSV) before the rep has
--                       made contact
--   - referral_intake — created automatically when a referral was
--                       received from a previously-unknown source
--
-- Production safety:
--   * Pure additive. ADD COLUMN IF NOT EXISTS with NOT NULL DEFAULT
--     'manual' so existing rows are populated atomically as the
--     column is added (Postgres optimization for non-volatile
--     defaults — no table rewrite).
--   * CHECK constraint is dropped + re-added with IF EXISTS guards so
--     re-running the migration is safe.
--   * No data deleted, no existing column changed.
--
-- Rollback:
--   _rollback/20260515220000_bd_accounts_source_column_down.sql drops
--   the index, the CHECK constraint, then the column.

ALTER TABLE bd_accounts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

ALTER TABLE bd_accounts
  DROP CONSTRAINT IF EXISTS bd_accounts_source_check;

ALTER TABLE bd_accounts
  ADD CONSTRAINT bd_accounts_source_check
    CHECK (source IN ('manual', 'trello_import', 'research_import', 'referral_intake'));

-- Cheap supporting index for the prospect-filter query
-- ("show me everything that came from territory research"). Partial so
-- it only covers the non-default value — keeps the index small.
CREATE INDEX IF NOT EXISTS idx_bd_accounts_source_non_manual
  ON bd_accounts (source)
  WHERE source <> 'manual';

COMMENT ON COLUMN bd_accounts.source IS
  'Provenance of this account row. ''manual'' = rep added via portal '
  'UI; ''trello_import'' = legacy Trello board import; '
  '''research_import'' = bulk imported from a territory-research doc '
  '(rep has not yet engaged); ''referral_intake'' = auto-created when '
  'an inbound referral named a previously-unknown source. Used by the '
  'BD portal to surface the ''Prospect'' badge on research_import rows '
  'until the rep logs their first activity.';
