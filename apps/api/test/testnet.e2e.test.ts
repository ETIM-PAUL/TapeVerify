/**
 * Live Strike testnet: connect throwaway Solana and Ethereum wallets through TapeVerify's own API
 * (challenge -> wallet signature -> verify), then read the account and request a deposit quote
 * and unsigned tx. Cardano needs a real CIP-30 wallet (COSE signing) and is covered manually.
 */
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { base58 } from "@scure/base";
import {
  instantiateTemplate,
  KeyVault,
  LocalKekProvider,
  loadStrikeConfig,
} from "@tapeverify/shared";
import {
  generateApiWalletKeys,
  requestBuilderSignature,
  verifyBuilderSignature,
} from "@tapeverify/strike-sdk";
import pg from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrafter, loadAiConfig } from "../src/ai/translate.js";
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
    BUILDER_CODE: "TapeVerify",
    BUILDER_FEE_BPS: "10",
  });
  gateway = new StrikeGateway(pool, vault, cfg);
  const ai = loadAiConfig();
  app = await buildApp({
    pool,
    vault,
    gateway,
    draft: ai ? createDrafter(ai) : null,
    api: loadApiConfig({ RATE_LIMIT: "off" }),
  });
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
  return `tape_session=${v.cookies.find((c) => c.name === "tape_session")?.value}`;
}

describe("Strike testnet through TapeVerify's API", () => {
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

  it("Ethereum: TapeVerify's lowercased address maps to the same Strike account as the checksummed one", async () => {
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
      builderCode: "TapeVerify",
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

  it.skipIf(!process.env.OPENAI_API_KEY)(
    "drafts a strategy from plain English with the real model, then saves it and reads it back",
    async () => {
      const priv = ed.utils.randomPrivateKey();
      const address = base58.encode(ed.getPublicKey(priv));
      const cookie = await connect("solana", address, async (m) =>
        base58.encode(ed.sign(new TextEncoder().encode(m), priv)),
      );
      const r = await app.inject({
        method: "POST",
        url: "/v1/strategies/draft",
        headers: { cookie },
        payload: {
          prompt:
            "Buy ETH when the 1 hour RSI(14) falls below 28 and close once it is above 55. 3x leverage, 2.5% stop.",
        },
      });
      expect(r.statusCode, r.body).toBe(200);
      const d = r.json();
      expect(d.spec).toMatchObject({ market: "ETH-USD", timeframe: "1h", direction: "long" });
      expect(d.spec.exit.stopLossPct).toBe(2.5);
      expect(d.spec.sizing.leverage).toBe(3);
      expect(d.description.lines.length).toBeGreaterThan(3);
      console.log(
        `${d.description.headline}\n${d.description.lines.map((l: { label: string; text: string }) => `  ${l.label}: ${l.text}`).join("\n")}\n  assumed: ${d.assumptions.join(" | ")}`,
      );

      const saved = await app.inject({
        method: "POST",
        url: "/v1/strategies",
        headers: { cookie },
        payload: { spec: d.spec, source: "ai", prompt: "x" },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const got = await app.inject({
        method: "GET",
        url: `/v1/strategies/${saved.json().id}`,
        headers: { cookie },
      });
      expect(got.json().issues).toEqual([]);
    },
    120_000,
  );

  it("backtests the templates on real indexed testnet candles with Strike's real market rules and fees", async () => {
    const priv = ed.utils.randomPrivateKey();
    const address = base58.encode(ed.getPublicKey(priv));
    const cookie = await connect("solana", address, async (m) =>
      base58.encode(ed.sign(new TextEncoder().encode(m), priv)),
    );
    const have = await pool.query(
      "SELECT count(*) AS n FROM candles WHERE symbol = 'BTC-USD' AND interval = '1h' AND price_type = 'mark' AND volume <> 1",
    );
    if (Number(have.rows[0].n) < 500) {
      console.log(
        "skipped: run the indexer or `pnpm --filter @tapeverify/workers test:live` first to load real candles",
      );
      return;
    }
    for (const tpl of ["dip_buyer", "trend_follower", "breakout"] as const) {
      const spec = instantiateTemplate(tpl, { marginUsd: 200, leverage: 3, maxLossUsd: 500 });
      spec.timeframe = "1h"; // the test database only holds 1h candles
      const saved = await app.inject({
        method: "POST",
        url: "/v1/strategies",
        headers: { cookie },
        payload: { spec, source: "template" },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const r = await app.inject({
        method: "POST",
        url: `/v1/strategies/${saved.json().id}/backtest`,
        headers: { cookie },
        payload: { days: 180 },
      });
      expect(r.statusCode, r.body).toBe(201);
      const { result, params } = r.json();
      expect(params.takerRate).toBe(0.0005); // Strike's real tier-0 taker rate
      expect(Number.isFinite(result.endEquity)).toBe(true);
      expect(result.coverage.bars).toBeGreaterThan(100 * 24);
      const s = result.stats;
      console.log(
        `${tpl.padEnd(15)} ${result.coverage.bars} candles  trades ${s.trades}  return ${s.returnPct.toFixed(2)}%  maxDD ${s.maxDrawdownPct.toFixed(1)}%  win ${s.winRate === null ? "-" : Math.round(s.winRate * 100)}%  fees $${s.totalFees.toFixed(2)}  liq ${s.liquidations}  hold-only ${s.buyAndHoldPct?.toFixed(1)}%`,
      );
    }
  }, 120_000);
});
