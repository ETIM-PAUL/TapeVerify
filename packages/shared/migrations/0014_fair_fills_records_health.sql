-- Phase 13: Argus II. Fair-fill scores, signed records, Strike health and liquidation alerts.

-- How each fill compared with the market at that moment. Keyed by fill: trades are rebuilt wholesale, fills are not.
-- basis says what the comparison used: the exact order book (l3), a depth sample, the mark price or the minute's VWAP.
CREATE TABLE fill_scores (
  account_id   text NOT NULL,
  fill_id      text NOT NULL,
  basis        text NOT NULL CHECK (basis IN ('l3', 'depth', 'mark', 'candle', 'maker', 'none')),
  ref_price    numeric,
  -- What walking the book for the fill's size would have cost at that moment (l3 and depth only).
  expected_price numeric,
  slippage_bps numeric,
  score        integer,
  note         text,
  scored_ms    bigint NOT NULL,
  PRIMARY KEY (account_id, fill_id)
);
CREATE INDEX fill_scores_scored_idx ON fill_scores (scored_ms);

-- Signed, chained snapshots of each trader's verified stats.
CREATE TABLE record_batches (
  id           bigserial PRIMARY KEY,
  created_ms   bigint NOT NULL,
  count        integer NOT NULL,
  merkle_root  text NOT NULL,
  prev_hash    text,
  batch_hash   text NOT NULL,
  signature    text NOT NULL,
  signer_key   text NOT NULL,
  -- Anchor: chain, cluster, tx signature, memo, and when it was seen finalized. Null until anchored.
  anchor       jsonb,
  anchor_error text,
  anchored_ms  bigint
);

CREATE TABLE record_snapshots (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   text NOT NULL,
  seq          integer NOT NULL,
  taken_ms     bigint NOT NULL,
  payload      jsonb NOT NULL,
  prev_hash    text,
  record_hash  text NOT NULL,
  signature    text NOT NULL,
  signer_key   text NOT NULL,
  batch_id     bigint REFERENCES record_batches(id),
  leaf_index   integer,
  UNIQUE (user_id, seq)
);
CREATE INDEX record_snapshots_user_idx ON record_snapshots (user_id, seq DESC);
CREATE INDEX record_snapshots_batch_idx ON record_snapshots (batch_id);
CREATE INDEX record_snapshots_pending_idx ON record_snapshots (id) WHERE batch_id IS NULL;

-- Strike's protocol (SLP) vault, sampled over time.
CREATE TABLE health_samples (
  ts_ms        bigint PRIMARY KEY,
  slp          jsonb,
  status       text NOT NULL CHECK (status IN ('ok', 'watch', 'alert', 'unknown')),
  reasons      jsonb NOT NULL
);

-- A copied position getting close to liquidation.
CREATE TABLE liquidation_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follow_id    uuid NOT NULL REFERENCES follows(id) ON DELETE CASCADE,
  symbol       text NOT NULL,
  level        text NOT NULL CHECK (level IN ('warn', 'danger', 'critical')),
  entry_price  numeric NOT NULL,
  mark_price   numeric NOT NULL,
  liq_price    numeric NOT NULL,
  -- How far from entry toward liquidation the mark has travelled, 0 to 1.
  used         numeric NOT NULL,
  created_ms   bigint NOT NULL,
  resolved_ms  bigint,
  resolution   text
);
CREATE UNIQUE INDEX liquidation_alerts_open_idx ON liquidation_alerts (follow_id) WHERE resolved_ms IS NULL;
CREATE INDEX liquidation_alerts_user_idx ON liquidation_alerts (user_id, created_ms DESC);
