-- A live run earns its source listing's creator a revenue share only if it still runs the listing's
-- signal rules. Decided once, when the run starts (sizing and risk limits may differ: they are the clone's own).
ALTER TABLE live_runs ADD COLUMN listing_id uuid REFERENCES listings(id) ON DELETE SET NULL;
CREATE INDEX live_runs_listing_idx ON live_runs (listing_id) WHERE listing_id IS NOT NULL;
