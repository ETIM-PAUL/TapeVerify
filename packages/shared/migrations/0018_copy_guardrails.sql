-- Limits a follower sets once and every follow respects. A null limit means no limit.
CREATE TABLE copy_guardrails (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_margin_usd      numeric CHECK (max_margin_usd IS NULL OR max_margin_usd > 0),
  max_loss_usd        numeric CHECK (max_loss_usd IS NULL OR max_loss_usd > 0),
  max_leverage        integer CHECK (max_leverage IS NULL OR max_leverage BETWEEN 1 AND 150),
  max_drift_bps       integer CHECK (max_drift_bps IS NULL OR max_drift_bps BETWEEN 1 AND 1000),
  max_open_copies     integer CHECK (max_open_copies IS NULL OR max_open_copies >= 1),
  daily_loss_limit_usd numeric CHECK (daily_loss_limit_usd IS NULL OR daily_loss_limit_usd > 0),
  require_clean_caller boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
