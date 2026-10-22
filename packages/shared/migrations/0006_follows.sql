-- Phase 6: a follow is a follower's own order that copies a call (same market, side and TP/SL).
-- Tracking columns mirror `calls` so one tracker can drive both. The "at follow" snapshot is what the
-- trust engine later compares the follower's real fill against (fair-fill score, front-running checks).
CREATE TABLE follows (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id                  uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key              text,
  symbol                   text NOT NULL,
  side                     text NOT NULL CHECK (side IN ('long', 'short')),
  leverage                 integer NOT NULL,
  margin_usd               numeric NOT NULL,
  size                     numeric NOT NULL,
  tp_price                 numeric,
  sl_price                 numeric,
  -- What the follower saw when they pressed follow.
  requested_ms             bigint NOT NULL,
  mark_at_request          numeric NOT NULL,
  call_entry_price         numeric NOT NULL,
  drift_bps_at_request     integer NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'open', 'closed', 'failed')),
  strategy_id              uuid,
  primary_client_order_id  text,
  tp_client_order_id       text,
  sl_client_order_id       text,
  entry_order_id           bigint,
  entry_trade_id           bigint,
  entry_price              numeric,
  entry_size               numeric,
  entry_fee                numeric,
  entry_ts_ms              bigint,
  exit_price               numeric,
  exit_size                numeric,
  exit_ts_ms               bigint,
  exit_reason              text CHECK (exit_reason IN ('tp', 'sl', 'manual', 'liquidation', 'external')),
  realized_pnl             numeric,
  fail_reason              text,
  close_requested_at       bigint,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- A user follows a given call at most once.
CREATE UNIQUE INDEX follows_user_call_idx ON follows (user_id, call_id);
CREATE UNIQUE INDEX follows_request_key_idx ON follows (user_id, request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX follows_one_active_per_symbol_idx ON follows (user_id, symbol) WHERE status IN ('pending', 'open');
CREATE INDEX follows_call_idx ON follows (call_id);
CREATE INDEX follows_active_idx ON follows (status) WHERE status IN ('pending', 'open');
