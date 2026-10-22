-- Phase 7: verified profiles. Everything here is derived from Strike's own records.

-- Deposits and withdrawals (Strike's transaction history): the capital base for time-weighted returns.
CREATE TABLE account_transactions (
  account_id   text NOT NULL,
  id           text NOT NULL,
  type         text NOT NULL,
  amount       numeric NOT NULL,
  status       text NOT NULL,
  ts_ms        bigint NOT NULL,
  asset_symbol text,
  tx_hash      text,
  raw          jsonb NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX account_transactions_time_idx ON account_transactions (account_id, ts_ms);

-- Round-trip trades rebuilt from fills (flat -> flat). Rebuilt wholesale whenever an account's fills change.
CREATE TABLE trades (
  id            bigserial PRIMARY KEY,
  account_id    text NOT NULL,
  symbol        text NOT NULL,
  side          text NOT NULL CHECK (side IN ('long', 'short')),
  opened_ms     bigint NOT NULL,
  closed_ms     bigint NOT NULL,
  size          numeric NOT NULL,
  entry_price   numeric NOT NULL,
  exit_price    numeric NOT NULL,
  entry_notional numeric NOT NULL,
  gross_pnl     numeric NOT NULL,
  fees          numeric NOT NULL,
  funding       numeric NOT NULL,
  net_pnl       numeric NOT NULL,
  liquidated    boolean NOT NULL DEFAULT false,
  split         boolean NOT NULL DEFAULT false
);
CREATE INDEX trades_account_closed_idx ON trades (account_id, closed_ms);
CREATE INDEX trades_closed_idx ON trades (closed_ms);

-- Exactly which fills make up each trade: the audit trail behind every profile number.
CREATE TABLE trade_fills (
  trade_id bigint NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  fill_id  text NOT NULL,
  leg      text NOT NULL CHECK (leg IN ('entry', 'exit')),
  qty      numeric NOT NULL,
  price    numeric NOT NULL,
  PRIMARY KEY (trade_id, fill_id, leg)
);

-- Handles are unique regardless of case.
CREATE UNIQUE INDEX users_handle_lower_idx ON users (lower(handle)) WHERE handle IS NOT NULL;
