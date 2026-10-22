-- Phase 10: live strategy runs on real accounts, with budget caps, kill switches and a full audit trail.

-- The tracker records exit commissions too, so net loss can be computed from Strike's own numbers.
ALTER TABLE calls ADD COLUMN exit_fee numeric;
ALTER TABLE follows ADD COLUMN exit_fee numeric;

-- Operator-level switches. `emergency_stop` = true halts every live run and blocks new ones.
CREATE TABLE system_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_flags (key, value) VALUES ('emergency_stop', 'false'::jsonb);

CREATE TABLE live_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id    uuid REFERENCES strategies(id) ON DELETE SET NULL,
  name           text NOT NULL,
  market         text NOT NULL,
  spec           jsonb NOT NULL,
  -- Hard limits set by the user at launch: {maxMarginUsd, maxLossUsd}.
  budget         jsonb NOT NULL,
  network        text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  -- Set when the user routes this run through a Strike sub-account they created and funded in the app.
  sub_account_id text,
  -- Strike account whose history we read: the master account, or the sub-account.
  account_id     text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopping', 'stopped', 'halted', 'error')),
  stop_reason    text,
  started_ms     bigint NOT NULL,
  last_bar_ms    bigint,
  -- Counters the decision logic needs: day, tradesToday, barsSinceExit, signal sequence, failures.
  state          jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  stopped_at     timestamptz
);
CREATE INDEX live_runs_user_idx ON live_runs (user_id, created_at DESC);
CREATE INDEX live_runs_active_idx ON live_runs (status) WHERE status IN ('active', 'stopping');
-- One live run per market per user, so every fill is attributable to exactly one run.
CREATE UNIQUE INDEX live_runs_one_active_idx ON live_runs (user_id, market) WHERE status IN ('active', 'stopping');

-- One row per intended position. Written BEFORE any order is sent (status 'planned'), which is what makes
-- placement idempotent: after a crash the row says what was intended and Strike's history says what happened.
CREATE TABLE live_trades (
  id                       bigserial PRIMARY KEY,
  run_id                   uuid NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
  seq                      integer NOT NULL,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  symbol                   text NOT NULL,
  side                     text NOT NULL CHECK (side IN ('long', 'short')),
  status                   text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'pending', 'open', 'closed', 'failed')),
  leverage                 integer NOT NULL,
  margin_usd               numeric NOT NULL,
  size                     numeric NOT NULL,
  sl_price                 numeric NOT NULL,
  tp_price                 numeric,
  trail_pct                numeric,
  worst_case_loss          numeric NOT NULL,
  strategy_id              uuid NOT NULL,
  primary_client_order_id  text NOT NULL,
  tp_client_order_id       text,
  sl_client_order_id       text,
  trail_client_order_id    text,
  close_client_order_id    text,
  close_reason_hint        text,
  sent_at                  bigint,
  entry_order_id           bigint,
  entry_trade_id           bigint,
  entry_price              numeric,
  entry_size               numeric,
  entry_fee                numeric,
  entry_ts_ms              bigint,
  exit_price               numeric,
  exit_size                numeric,
  exit_ts_ms               bigint,
  exit_fee                 numeric,
  exit_reason              text,
  realized_pnl             numeric,
  fail_reason              text,
  close_requested_at       bigint,
  bars_held                integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
CREATE INDEX live_trades_run_idx ON live_trades (run_id, seq DESC);
CREATE INDEX live_trades_active_idx ON live_trades (status) WHERE status IN ('planned', 'pending', 'open');

-- Append-only audit log: every decision, order, fill, halt and error of a run.
CREATE TABLE live_events (
  id     bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
  ts_ms  bigint NOT NULL,
  kind   text NOT NULL,
  data   jsonb NOT NULL
);
CREATE INDEX live_events_run_idx ON live_events (run_id, id DESC);
