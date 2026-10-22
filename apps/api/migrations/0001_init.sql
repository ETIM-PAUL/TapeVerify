CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain         text NOT NULL CHECK (chain IN ('cardano', 'ethereum', 'solana')),
  address       text NOT NULL,
  strike_account_id text,
  handle        text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

-- API wallet private keys are stored only as vault-sealed envelopes (never plaintext).
CREATE TABLE api_wallets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network        text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  public_key     text NOT NULL UNIQUE,
  sealed_private_key jsonb NOT NULL,
  kek_id         text NOT NULL,
  fee_share_bps  integer NOT NULL CHECK (fee_share_bps BETWEEN 0 AND 100),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_wallets_user_idx ON api_wallets (user_id) WHERE revoked_at IS NULL;
CREATE INDEX api_wallets_kek_idx ON api_wallets (kek_id);
