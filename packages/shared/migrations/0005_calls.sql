-- Phase 5: calls (shareable trades). Entry and exit values come from Strike's fills, never from user input.
CREATE TABLE calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code               text NOT NULL UNIQUE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key              text,
  symbol                   text NOT NULL,
  side                     text NOT NULL CHECK (side IN ('long', 'short')),
  leverage                 integer NOT NULL,
  size                     numeric NOT NULL,
  tp_price                 numeric,
  sl_price                 numeric,
  -- Follow window and price-drift limit chosen by the caller (ms epoch, basis points).
  expires_at               bigint NOT NULL,
  max_drift_bps            integer NOT NULL CHECK (max_drift_bps BETWEEN 1 AND 1000),
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'open', 'expired', 'closed', 'failed')),
  strategy_id              uuid,
  primary_client_order_id  text,
  tp_client_order_id       text,
  sl_client_order_id       text,
  -- Filled in from Strike's order and fill history.
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
CREATE UNIQUE INDEX calls_request_key_idx ON calls (user_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX calls_user_idx ON calls (user_id, created_at DESC);
CREATE INDEX calls_active_idx ON calls (status) WHERE status IN ('pending', 'open', 'expired');
-- At most one unfinished call per user per market keeps entries and exits attributable.
CREATE UNIQUE INDEX calls_one_active_per_symbol_idx ON calls (user_id, symbol) WHERE status IN ('pending', 'open', 'expired');
