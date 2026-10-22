/**
 * Phase 2 "done when": the SDK signs a request and fetches account data on testnet.
 * Runs the full builder-connect flow with a throwaway Solana keypair (Solana wallet signatures are
 * plain Ed25519), so it needs no browser wallet and no funds.
 */
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  generateApiWalletKeys,
  getAccount,
  getMarkets,
  requestBuilderSignature,
  StrikeClient,
  verifyBuilderSignature,
} from "../src/index.js";

const baseUrl = process.env.STRIKE_API_URL ?? "https://api-v2-testnet.strikefinance.org";
const builderCode = process.env.BUILDER_CODE ?? "TapeVerify";

describe("strike testnet", () => {
  it("syncs clock, connects a builder wallet, signs a request and fetches account data", async () => {
    const anon = new StrikeClient({ baseUrl });
    await anon.syncClock();

    const markets = await getMarkets(anon);
    expect(Object.keys(markets.markets).length).toBeGreaterThan(0);

    // Throwaway Solana identity.
    const solPriv = ed.utils.randomPrivateKey();
    const address = bs58.encode(ed.getPublicKey(solPriv));
    const api = generateApiWalletKeys();

    const challenge = await requestBuilderSignature(anon, {
      address,
      chain: "solana",
      publicKey: api.publicKey,
      builderCode,
      feeShareBps: 10,
    });
    const sig = bs58.encode(ed.sign(new TextEncoder().encode(challenge.message_to_sign), solPriv));
    const connected = await verifyBuilderSignature(anon, {
      nonce: challenge.nonce,
      walletSignature: sig,
    });
    expect(connected.api_wallet_public_key).toBe(api.publicKey);

    const client = anon.withKeys(api);
    const account = await getAccount(client);
    expect(account).toBeTypeOf("object");
  }, 60_000);
});
