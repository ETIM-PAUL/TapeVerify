-- Phase 11: strategy marketplace and creator earnings (Option B: Pit is the builder, creators get a revenue share).

-- Which rules a live run actually ran, so a listing's record only counts trades made with those exact rules.
ALTER TABLE live_runs ADD COLUMN spec_hash text;
-- The builder fee rate (bps) the order carried, recorded when the order is planned.
ALTER TABLE live_trades ADD COLUMN builder_bps integer;

CREATE TABLE listings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id      uuid REFERENCES strategies(id) ON DELETE SET NULL,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- Immutable snapshot of the published rules. Editing the strategy later changes nothing here.
  spec             jsonb NOT NULL,
  spec_hash        text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unlisted')),
  -- Creator's share of the builder fee Pit earns on clones' trades, in bps of that fee (5000 = 50%). Fixed per listing.
  creator_share_bps integer NOT NULL CHECK (creator_share_bps BETWEEN 0 AND 10000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_status_idx ON listings (status, created_at DESC);
CREATE INDEX listings_creator_idx ON listings (creator_id);
-- One published listing per strategy.
CREATE UNIQUE INDEX listings_one_per_strategy_idx ON listings (strategy_id) WHERE status = 'published' AND strategy_id IS NOT NULL;

ALTER TABLE strategies ADD COLUMN cloned_from_listing uuid REFERENCES listings(id) ON DELETE SET NULL;
ALTER TABLE strategies ADD COLUMN cloned_from_version integer;
ALTER TABLE strategies DROP CONSTRAINT strategies_source_check;
ALTER TABLE strategies ADD CONSTRAINT strategies_source_check CHECK (source IN ('ai', 'template', 'manual', 'clone'));
CREATE INDEX strategies_clone_idx ON strategies (cloned_from_listing) WHERE cloned_from_listing IS NOT NULL;

-- One accrual per closed trade of a clone's live run: the creator's share of the builder fee on that trade.
-- Computed from Strike's fills (entry and exit notional) with Strike's published fee formula.
CREATE TABLE creator_earnings (
  id                bigserial PRIMARY KEY,
  listing_id        uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  creator_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clone_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
  live_trade_id     bigint NOT NULL UNIQUE REFERENCES live_trades(id) ON DELETE CASCADE,
  entry_notional    numeric NOT NULL,
  exit_notional     numeric NOT NULL,
  builder_bps       integer NOT NULL,
  builder_fee       numeric NOT NULL,
  creator_share_bps integer NOT NULL,
  creator_amount    numeric NOT NULL,
  status            text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'paid')),
  payout_ref        text,
  accrued_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz
);
CREATE INDEX creator_earnings_creator_idx ON creator_earnings (creator_id, accrued_at DESC);
CREATE INDEX creator_earnings_listing_idx ON creator_earnings (listing_id);
