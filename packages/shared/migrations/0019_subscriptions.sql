-- Creator subscriptions: a creator sets a price, subscribers pay on-chain, and premium calls stay locked to subscribers
-- until they close (a closed call is part of the public record).

ALTER TABLE calls ADD COLUMN premium boolean NOT NULL DEFAULT false;
-- A premium call becomes public at this time; null keeps it subscribers-only until it closes.
ALTER TABLE calls ADD COLUMN public_at_ms bigint;
CREATE INDEX calls_premium_idx ON calls (user_id) WHERE premium;

CREATE TABLE subscription_plans (
  creator_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  price_usdc  numeric NOT NULL CHECK (price_usdc >= 1 AND price_usdc <= 100000),
  period_days integer NOT NULL CHECK (period_days BETWEEN 1 AND 365),
  -- A Solana address the creator controls. Payments go straight to it: Tape never holds the money.
  pay_address text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per person per creator; renewing extends ends_ms.
CREATE TABLE subscriptions (
  creator_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_ms    bigint NOT NULL,
  ends_ms       bigint NOT NULL,
  PRIMARY KEY (creator_id, subscriber_id),
  CHECK (creator_id <> subscriber_id)
);
CREATE INDEX subscriptions_subscriber_idx ON subscriptions (subscriber_id);

-- Every payment attempt, and the proof for the ones that succeeded. A transaction can pay for one subscription only.
CREATE TABLE subscription_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdc   numeric NOT NULL,
  period_days   integer NOT NULL,
  pay_address   text NOT NULL,
  mint          text NOT NULL,
  -- Written into the transaction's memo so a payment can be matched to the person who started it.
  reference     text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'paid')),
  signature     text UNIQUE,
  created_ms    bigint NOT NULL,
  expires_ms    bigint NOT NULL,
  paid_ms       bigint,
  slot          bigint
);
CREATE INDEX subscription_payments_creator_idx ON subscription_payments (creator_id, paid_ms DESC);
CREATE INDEX subscription_payments_subscriber_idx ON subscription_payments (subscriber_id, created_ms DESC);
