import type { StrikeClient } from "./client.js";

export type ConnectChain = "ethereum" | "solana" | "cardano";

export interface RequestSignatureParams {
  address: string;
  chain: ConnectChain;
  /** Ed25519 API wallet public key, 64 hex. */
  publicKey: string;
  builderCode: string;
  /** User's approved max builder fee, 0..100 bps. */
  feeShareBps: number;
}

export interface BuilderConnectChallenge {
  nonce: string;
  message_to_sign: string;
}

export interface BuilderConnectResult {
  account_id: string;
  builder_code: string;
  fee_share_bps: number;
  api_wallet_id: string;
  api_wallet_public_key: string;
  api_wallet_expired_at?: string;
  [k: string]: unknown;
}

export function requestBuilderSignature(
  client: StrikeClient,
  p: RequestSignatureParams,
): Promise<BuilderConnectChallenge> {
  return client.publicPost("/auth/builder/request-signature", {
    address: p.address,
    chain: p.chain,
    code: p.builderCode,
    fee_share_bps: p.feeShareBps,
    public_key: p.publicKey,
  });
}

export function verifyBuilderSignature(
  client: StrikeClient,
  p: { nonce: string; walletSignature: string },
): Promise<BuilderConnectResult> {
  return client.publicPost("/auth/builder/verify-signature", {
    nonce: p.nonce,
    wallet_signature: p.walletSignature,
  });
}
