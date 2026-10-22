-- Phase 4: market data + indexer storage. Written by apps/workers, read by the API, backtester and Argus.

CREATE TABLE candles (
  symbol       text NOT NULL,
  interval     text NOT NULL,
  price_type   text NOT NULL CHECK (price_type IN ('last', 'mark', 'index')),
  open_time    bigint NOT NULL,
  close_time   bigint NOT NULL,
  open         numeric NOT NULL,
  high         numeric NOT NULL,
  low          numeric NOT NULL,
  close        numeric NOT NULL,
  volume       numeric NOT NULL,
  quote_volume numeric NOT NULL,
  trades       integer NOT NULL,
  PRIMARY KEY (symbol, interval, price_type, open_time)
);

CREATE TABLE market_trades (
  symbol         text NOT NULL,
  trade_id       bigint NOT NULL,
  price          numeric NOT NULL,
  qty            numeric NOT NULL,
  time_ms        bigint NOT NULL,
  is_buyer_maker boolean NOT NULL,
  PRIMARY KEY (symbol, trade_id)
);
CREATE INDEX market_trades_time_idx ON market_trades (symbol, time_ms);

CREATE TABLE mark_prices (
  symbol       text NOT NULL,
  ts_ms        bigint NOT NULL,
  mark_price   numeric NOT NULL,
  index_price  numeric NOT NULL,
  funding_rate numeric,
  PRIMARY KEY (symbol, ts_ms)
);

-- Aggregated top-of-book samples (all markets). Coarse; the exact book is L3 below.
CREATE TABLE depth_snapshots (
  symbol  text NOT NULL,
  ts_ms   bigint NOT NULL,
  bids    jsonb NOT NULL,
  asks    jsonb NOT NULL,
  PRIMARY KEY (symbol, ts_ms)
);

-- L3: a segment is one unbroken, gap-free stretch of the feed (snapshot + contiguous updates).
-- Any disconnect, sequence gap or `clear` ends the segment; the next bootstrap starts a new one.
CREATE TABLE l3_segments (
  id             bigserial PRIMARY KEY,
  symbol         text NOT NULL,
  start_ts       bigint NOT NULL,
  end_ts         bigint,
  start_sequence bigint NOT NULL,
  end_sequence   bigint,
  end_reason     text
);
CREATE INDEX l3_segments_symbol_time_idx ON l3_segments (symbol, start_ts);

-- Full book at a point in a segment: the first row is the bootstrap snapshot, the rest are checkpoints.
CREATE TABLE l3_snapshots (
  id            bigserial PRIMARY KEY,
  segment_id    bigint NOT NULL REFERENCES l3_segments(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL,
  ts_ms         bigint NOT NULL,
  book          jsonb NOT NULL
);
CREATE INDEX l3_snapshots_segment_idx ON l3_snapshots (segment_id, last_sequence);

-- Prices and sizes are kept as the feed's exact strings.
CREATE TABLE l3_updates (
  segment_id     bigint NOT NULL REFERENCES l3_segments(id) ON DELETE CASCADE,
  sequence       bigint NOT NULL,
  ts_ms          bigint NOT NULL,
  action         text NOT NULL,
  order_id       text,
  taker_order_id text,
  side           text,
  price          text,
  delta_size     text,
  remaining_size text,
  trade_id       bigint,
  PRIMARY KEY (segment_id, sequence)
);

-- Per-user trading records (source for verified stats, Argus and the leaderboard).
CREATE TABLE fills (
  account_id      text NOT NULL,
  id              text NOT NULL,
  trade_id        bigint NOT NULL,
  order_id        text NOT NULL,
  symbol          text NOT NULL,
  side            text NOT NULL,
  role            text NOT NULL,
  price           numeric NOT NULL,
  size            numeric NOT NULL,
  realized_pnl    numeric NOT NULL,
  fee             numeric NOT NULL,
  fee_type        text,
  ts_ms           bigint NOT NULL,
  auto_close_type text,
  leverage        numeric,
  raw             jsonb NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX fills_trade_idx ON fills (account_id, trade_id);
CREATE INDEX fills_time_idx ON fills (symbol, ts_ms);

CREATE TABLE funding_payments (
  account_id    text NOT NULL,
  id            text NOT NULL,
  symbol        text NOT NULL,
  position_side text,
  position_size numeric,
  funding_rate  numeric,
  amount        numeric NOT NULL,
  ts_ms         bigint NOT NULL,
  raw           jsonb NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX funding_time_idx ON funding_payments (account_id, ts_ms);

-- Bookkeeping so backfills resume and operators can see ingest health.
CREATE TABLE ingest_status (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
