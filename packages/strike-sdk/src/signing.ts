import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

ed.etc.sha512Sync = (...m) => {
  const h = sha512.create();
  for (const msg of m) h.update(msg);
  return h.digest();
};

export interface ApiWalletKeys {
  publicKey: string; // 64 hex
  privateKey: string; // 64 hex
}

export function generateApiWalletKeys(): ApiWalletKeys {
  const priv = ed.utils.randomPrivateKey();
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(ed.getPublicKey(priv)) };
}

export const EMPTY_BODY_SHA256 = bytesToHex(sha256(new Uint8Array()));

export interface SignOptions {
  /** Unix seconds; defaults to now (+ clock offset handled by caller). */
  timestamp?: number;
  nonce?: string;
}

/**
 * Headers for an API-wallet request. Message: `{METHOD}:{PATH}:{TS}:{NONCE}:{SHA256_HEX(body)}`
 * where PATH includes `?query`. `X-Builder-Fee-Bps` is deliberately not part of the signature.
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  keys: ApiWalletKeys,
  opts: SignOptions = {},
): Record<string, string> {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${bodyHash}`;
  const sig = ed.sign(new TextEncoder().encode(message), hexToBytes(keys.privateKey));
  return {
    "X-API-Wallet-Public-Key": keys.publicKey,
    "X-API-Wallet-Signature": bytesToHex(sig),
    "X-API-Wallet-Timestamp": timestamp,
    "X-API-Wallet-Nonce": nonce,
  };
}

/** `session.logon` params for the user WebSocket (timestamp in milliseconds). */
export function signLogon(keys: ApiWalletKeys, timestampMs = Date.now()) {
  const message = `session.logon:${timestampMs}:${keys.publicKey}`;
  const signature = bytesToHex(
    ed.sign(new TextEncoder().encode(message), hexToBytes(keys.privateKey)),
  );
  return { apiKey: keys.publicKey, signature, timestamp: timestampMs };
}

export function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  return ed.verify(
    hexToBytes(signatureHex),
    new TextEncoder().encode(message),
    hexToBytes(publicKeyHex),
  );
}
