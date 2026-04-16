ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS trello_card_id text;
CREATE INDEX IF NOT EXISTS idx_caregivers_trello_card_id ON caregivers (trello_card_id) WHERE trello_card_id IS NOT NULL;
