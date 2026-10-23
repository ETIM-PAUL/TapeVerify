-- Creators can be paid on more than one chain: Solana (USDC, memo), Ethereum (USDC) and Cardano (ADA).
-- pay_address stays the Solana address, so existing plans keep working untouched.

ALTER TABLE subscription_plans ALTER COLUMN pay_address DROP NOT NULL;
ALTER TABLE subscription_plans ADD COLUMN eth_address text;
ALTER TABLE subscription_plans ADD COLUMN ada_address text;
ALTER TABLE subscription_plans
  ADD CONSTRAINT subscription_plans_has_address
  CHECK (pay_address IS NOT NULL OR eth_address IS NOT NULL OR ada_address IS NOT NULL);

ALTER TABLE subscription_payments
  ADD COLUMN chain text NOT NULL DEFAULT 'solana' CHECK (chain IN ('solana', 'ethereum', 'cardano'));
ALTER TABLE subscription_payments ADD COLUMN pay_asset text NOT NULL DEFAULT 'USDC';
-- Ethereum and Cardano have no memo a wallet reliably sets, so the payer is told to send an exact amount (price plus
-- a tiny unique tag), in the asset's base units (USDC 6 decimals, ADA lovelace). Null for Solana, which uses the memo.
ALTER TABLE subscription_payments ADD COLUMN pay_amount text;
-- USD per ADA at the moment the payment was started (ADA payments only).
ALTER TABLE subscription_payments ADD COLUMN rate numeric;
CREATE UNIQUE INDEX subscription_payments_exact_idx
  ON subscription_payments (pay_address, pay_amount)
  WHERE status = 'awaiting' AND pay_amount IS NOT NULL;
