-- Connect handshake in flight: the API wallet key is sealed from the moment it is generated.
CREATE TABLE pending_connects (
  nonce          text PRIMARY KEY,
  chain          text NOT NULL CHECK (chain IN ('cardano', 'ethereum', 'solana')),
  address        text NOT NULL,
  public_key     text NOT NULL,
  sealed_private_key jsonb NOT NULL,
  fee_share_bps  integer NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Only a hash of the session token is stored.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE deposits (
  request_id   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain        text NOT NULL,
  asset_symbol text NOT NULL,
  asset_amount text NOT NULL,
  usd_value    text NOT NULL,
  tx_hash      text,
  status       text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'submitted', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deposits_user_idx ON deposits (user_id, created_at DESC);

CREATE TABLE withdrawals (
  withdraw_id  text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain        text NOT NULL,
  asset        text NOT NULL,
  usd_value    text NOT NULL,
  fee          text NOT NULL,
  status       text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'submitted', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);
