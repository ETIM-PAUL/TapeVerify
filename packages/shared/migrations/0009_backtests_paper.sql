-- Phase 9: backtests and paper mode. Both run the same engine on the same spec.

CREATE TABLE backtests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id uuid REFERENCES strategies(id) ON DELETE SET NULL,
  -- The exact spec that ran, so a result stays explainable after the strategy is edited.
  spec        jsonb NOT NULL,
  params      jsonb NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backtests_strategy_idx ON backtests (strategy_id, created_at DESC);
CREATE INDEX backtests_user_idx ON backtests (user_id, created_at DESC);

-- A paper session trades a spec snapshot on live prices with simulated fills. `state` is the engine's
-- JSON state, so a restart resumes exactly where it left off.
CREATE TABLE paper_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strategy_id   uuid REFERENCES strategies(id) ON DELETE SET NULL,
  name          text NOT NULL,
  spec          jsonb NOT NULL,
  params        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopping', 'stopped', 'halted')),
  start_equity  numeric NOT NULL,
  started_ms    bigint NOT NULL,
  state         jsonb NOT NULL,
  last_bar_ms   bigint,
  last_price    numeric,
  last_tick_ms  bigint,
  stop_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  stopped_at    timestamptz
);
CREATE INDEX paper_sessions_user_idx ON paper_sessions (user_id, created_at DESC);
CREATE INDEX paper_sessions_running_idx ON paper_sessions (status) WHERE status IN ('running', 'stopping');

CREATE TABLE paper_trades (
  session_id uuid NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  trade      jsonb NOT NULL,
  exit_ts    bigint NOT NULL,
  net_pnl    numeric NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE paper_equity (
  session_id uuid NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  ts_ms      bigint NOT NULL,
  equity     numeric NOT NULL,
  PRIMARY KEY (session_id, ts_ms)
);
