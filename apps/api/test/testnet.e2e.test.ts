/**
 * Live Strike testnet: connect throwaway Solana and Ethereum wallets through Pit's own API
 * (challenge -> wallet signature -> verify), then read the account and request a deposit quote
 * and unsigned tx. Cardano needs a real CIP-30 wallet (COSE signing) and is covered manually.
 */
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { KeyVault, LocalKekProvider, loadStrikeConfig } from "@pit/shared";
import {
  generateApiWalletKeys,
  requestBuilderSignature,
  verifyBuilderSignature,
} from "@pit/strike-sdk";
import { base58 } from "@scure/base";
import pg from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadApiConfig } from "../src/config.js";
import { StrikeGateway } from "../src/gateway.js";

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let gateway: StrikeGateway;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const vault = new KeyVault(new LocalKekProvider("t1", { t1: randomBytes(32) }));
  const cfg = loadStrikeConfig({
    STRIKE_NETWORK: "testnet",
    BUILDER_CODE: "Pit",
    BUILDER_FEE_BPS: "10",
  });
  gateway = new StrikeGateway(pool, vault, cfg);
  app = await buildApp({ pool, vault, gateway, api: loadApiConfig({ RATE_LIMIT: "off" }) });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function connect(
  chain: "solana" | "ethereum",
  address: string,
  sign: (msg: string) => Promise<string>,
) {
  const ch = await app.inject({
    method: "POST",
    url: "/v1/auth/challenge",
    payload: { chain, address },
  });
  expect(ch.statusCode, ch.body).toBe(200);
  const { nonce, message } = ch.json();
  expect(message).toContain("0.1%"); // 10 bps fee cap is disclosed to the user
  const v = await app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: { nonce, signature: await sign(message) },
  });
  expect(v.statusCode, v.body).toBe(200);
  return `pit_session=${v.cookies.find((c) => c.name === "pit_session")?.value}`;
}

describe("Strike testnet through Pit's API", () => {
  it("Solana: connect, account, deposit quote + unsigned tx", async () => {
    const priv = ed.utils.randomPrivateKey();
    const address = base58.encode(ed.getPublicKey(priv));
    const cookie = await connect("solana", address, async (m) =>
      base58.encode(ed.sign(new TextEncoder().encode(m), priv)),
    );

    const acct = await app.inject({ method: "GET", url: "/v1/account", headers: { cookie } });
    expect(acct.statusCode, acct.body).toBe(200);
    expect(acct.json().account.blockchain_address).toBe(address);

    const q = await app.inject({
      method: "POST",
      url: "/v1/deposit/quote",
      headers: { cookie },
      payload: { asset: "USDC", amount: "10" },
    });
    expect(q.statusCode, q.body).toBe(200);
    expect(Number(q.json().usdValue)).toBeGreaterThan(9);
    const b = await app.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: { cookie },
      payload: { requestId: q.json().requestId },
    });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().format).toBe("solana_base64");

    const tx = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
    expect(tx.statusCode, tx.body).toBe(200);
  }, 90_000);

  it("Ethereum: connect (EIP-191), account, USDC deposit quote + unsigned tx", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const cookie = await connect("ethereum", account.address, (m) =>
      account.signMessage({ message: m }),
    );

    const acct = await app.inject({ method: "GET", url: "/v1/account", headers: { cookie } });
    expect(acct.statusCode, acct.body).toBe(200);

    const q = await app.inject({
      method: "POST",
      url: "/v1/deposit/quote",
      headers: { cookie },
      payload: { asset: "USDC", amount: "10" },
    });
    expect(q.statusCode, q.body).toBe(200);
    const b = await app.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: { cookie },
      payload: { requestId: q.json().requestId },
    });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().format).toBe("evm_tx_params");
    expect(b.json().unsigned_tx.from.toLowerCase()).toBe(account.address.toLowerCase());
  }, 90_000);

  it("Ethereum: Pit's lowercased address maps to the same Strike account as the checksummed one", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const cookie = await connect("ethereum", account.address, (m) =>
      account.signMessage({ message: m }),
    );
    const viaPit = (
      await app.inject({ method: "GET", url: "/v1/account", headers: { cookie } })
    ).json().account.account_id;

    // Connect the same wallet directly with the checksummed address (as Strike's own app would).
    const anon = await gateway.anon();
    const keys = generateApiWalletKeys();
    const ch = await requestBuilderSignature(anon, {
      address: account.address,
      chain: "ethereum",
      publicKey: keys.publicKey,
      builderCode: "Pit",
      feeShareBps: 10,
    });
    const res = await verifyBuilderSignature(anon, {
      nonce: ch.nonce,
      walletSignature: await account.signMessage({ message: ch.message_to_sign }),
    });
    expect(res.account_id).toBe(viaPit);
  }, 90_000);

  it("validates a call against Strike's real market rules, then stops at the balance check (unfunded)", async () => {
    const priv = ed.utils.randomPrivateKey();
    const address = base58.encode(ed.getPublicKey(priv));
    const cookie = await connect("solana", address, async (m) =>
      base58.encode(ed.sign(new TextEncoder().encode(m), priv)),
    );
    const rules = (await gateway.marketRules())["BTC-USD"] as { mark_price: string };
    const mark = Number(rules.mark_price);
    const call = {
      symbol: "BTC-USD",
      side: "long",
      size: "0.0013",
      leverage: 5,
      tpPrice: String(Math.round(mark * 1.05)),
      slPrice: String(Math.round(mark * 0.95)),
    };
    const ok = await app.inject({
      method: "POST",
      url: "/v1/calls",
      headers: { cookie },
      payload: call,
    });
    expect(ok.statusCode, ok.body).toBe(400);
    expect(ok.json().code).toBe("insufficient_balance"); // passed every market rule; no money to trade with
    const tiny = await app.inject({
      method: "POST",
      url: "/v1/calls",
      headers: { cookie },
      payload: { ...call, size: "0.00001" },
    });
    expect(tiny.json().code).toBe("bad_size"); // under Strike's $100 minimum order value
  }, 90_000);
});
